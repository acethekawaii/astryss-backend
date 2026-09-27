import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import Redis from 'ioredis';
import { Model } from 'mongoose';
import { WebSocket } from 'ws';

import { boardByteLength, boardId, stardust } from './stardust.config';
import {
  encodeDelta,
  encodeRecord,
  encodeSnapshot,
  hashIp,
  offset,
  paintAll,
  planCooldown,
  tokenId,
} from './stardust.invariants';
import { Placement, PlacementDocument } from './schemas/placement.schema';
import {
  AnonId,
  Cell,
  ColorIndex,
  IpHash,
  LivePixel,
  UnhashedIp,
} from './types/stardust.types';

export const STARDUST_REDIS_URL = 'STARDUST_REDIS_URL';
export const STARDUST_SECRET = 'STARDUST_SECRET_TOKEN';

const BOARD_KEY = `stardust:${boardId}:board`;
const SEQ_KEY = `stardust:${boardId}:seq`;
const CHANNEL = `stardust:${boardId}:pixels`;

@Injectable()
export class Canvas implements OnModuleInit, OnModuleDestroy {
  private readonly redis: Redis;
  private readonly sub: Redis;
  private readonly secret: string;
  private ready = false;
  private readonly sockets = new Set<WebSocket>();
  private flushBuffer: LivePixel[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @InjectModel(Placement.name)
    private readonly placements: Model<PlacementDocument>,
    @Inject(STARDUST_REDIS_URL) redisUrl: string,
    @Inject(STARDUST_SECRET) secret: string,
  ) {
    if (secret.length < 32) {
      throw new Error('STARDUST_SECRET must be at least 32 characters');
    }
    if (stardust.palette.length < 1 || stardust.palette.length > 256) {
      throw new Error('palette length must be 1..256');
    }
    if (stardust.blank !== 0) {
      throw new Error('blank must be 0');
    }
    if (stardust.flushMs < 100 || stardust.flushMs > 250) {
      throw new Error('flushMs must be 100..250');
    }
    this.secret = secret;
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
  }

  async onModuleInit(): Promise<void> {
    await this.sub.subscribe(CHANNEL);
    this.sub.on('messageBuffer', (_channel, message) => {
      if (message.length < 9) {
        return;
      }
      const pixel: LivePixel = {
        seq: message.readUInt32BE(0),
        x: message.readUInt16BE(4),
        y: message.readUInt16BE(6),
        color: message.readUInt8(8) as ColorIndex,
      };
      this.enqueueFlush(pixel);
    });
    await this.startup();
    this.ready = true;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const ws of this.sockets) {
      ws.close();
    }
    this.sockets.clear();
    await this.sub.quit();
    await this.redis.quit();
  }

  admit(
    token: string,
    ip: UnhashedIp,
  ): { anonId: AnonId; ipHash: IpHash } {
    const anonId = tokenId(token, this.secret);
    return { anonId, ipHash: hashIp(this.secret, ip) };
  }

  watch(ws: WebSocket): void {
    const timer = setTimeout(() => {
      ws.close(1008);
    }, 5000);

    const onMessage = (raw: Buffer | ArrayBuffer | Buffer[]) => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      let token: string | undefined;
      try {
        const parsed = JSON.parse(
          Buffer.isBuffer(raw)
            ? raw.toString()
            : Buffer.from(raw as ArrayBuffer).toString(),
        ) as { token?: unknown };
        if (typeof parsed.token !== 'string') {
          ws.close(1008);
          return;
        }
        token = parsed.token;
        tokenId(token, this.secret);
      } catch {
        ws.close(1008);
        return;
      }
      this.sockets.add(ws);
      ws.on('close', () => {
        this.sockets.delete(ws);
      });
    };

    ws.on('message', onMessage);
  }

  async snapshot(): Promise<Buffer> {
    if (!this.ready) {
      throw new HttpException('Board not ready', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const results = await this.redis
      .multi()
      .getBuffer(BOARD_KEY)
      .get(SEQ_KEY)
      .exec();
    const board = results?.[0]?.[1] as Buffer | null;
    const seqRaw = results?.[1]?.[1] as string | null;
    if (!board || board.length !== boardByteLength) {
      throw new HttpException('Board not ready', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const seq = seqRaw ? Number.parseInt(seqRaw, 10) : 0;
    return encodeSnapshot(board, Number.isFinite(seq) ? seq : 0);
  }

  async place(
    token: string,
    ip: UnhashedIp,
    cell: Cell,
    color: ColorIndex,
  ): Promise<{ x: number; y: number; color: ColorIndex; nextAllowedAt: string }> {
    if (!this.ready) {
      throw new HttpException('Board not ready', HttpStatus.SERVICE_UNAVAILABLE);
    }

    const { anonId, ipHash } = this.admit(token, ip);
    const lockKey = `stardust:lock:${ipHash}`;
    const idKey = `stardust:id:${anonId}`;
    const ipKey = `stardust:ip:${ipHash}`;
    const locked = await this.redis.set(lockKey, '1', 'PX', 2000, 'NX');
    if (locked !== 'OK') {
      throw new HttpException('Busy', HttpStatus.TOO_MANY_REQUESTS);
    }

    let nextAllowedAt: string;
    let recordIpAtMs: number;
    let identityTtlMs: number;
    let ipMember: string;

    try {
      const planned = await this.planFromRedis(idKey, ipKey);
      if (!planned.ok) {
        throw new HttpException(
          { message: { remainingMs: planned.remainingMs, nextAllowedAt: planned.nextAllowedAt } },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      nextAllowedAt = planned.nextAllowedAt;
      recordIpAtMs = planned.recordIpAtMs;
      identityTtlMs = planned.identityTtlMs;

      const setId = await this.redis.set(
        idKey,
        '1',
        'PX',
        identityTtlMs,
        'NX',
      );
      if (setId !== 'OK') {
        const again = await this.planFromRedis(idKey, ipKey);
        if (!again.ok) {
          throw new HttpException(
            {
              message: {
                remainingMs: again.remainingMs,
                nextAllowedAt: again.nextAllowedAt,
              },
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        nextAllowedAt = again.nextAllowedAt;
        recordIpAtMs = again.recordIpAtMs;
        identityTtlMs = again.identityTtlMs;
      }

      ipMember = `${recordIpAtMs}:${anonId}:${Math.random().toString(36).slice(2)}`;
      await this.redis.zadd(ipKey, recordIpAtMs, ipMember);
    } finally {
      await this.redis.del(lockKey);
    }

    const at = new Date();
    try {
      await this.placements.create({
        x: cell.x,
        y: cell.y,
        color,
        anonId,
        at,
        board: boardId,
      });
    } catch (err) {
      await this.redis.del(idKey);
      await this.redis.zrem(ipKey, ipMember!);
      throw err;
    }

    const off = offset(cell);
    const byte = Buffer.from([color]);
    let painted = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.redis.setrange(BOARD_KEY, off, byte);
        painted = true;
        break;
      } catch {
        // retry once
      }
    }
    if (!painted) {
      throw new HttpException(
        'Board write failed',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const seq = await this.redis.incr(SEQ_KEY);
    const live: LivePixel = { seq, x: cell.x, y: cell.y, color };
    await this.redis.publish(CHANNEL, encodeRecord(live));

    return { x: cell.x, y: cell.y, color, nextAllowedAt };
  }

  private async planFromRedis(idKey: string, ipKey: string) {
    const nowMs = Date.now();
    const pttl = await this.redis.pttl(idKey);
    const identityRemainingMs = pttl > 0 ? pttl : 0;
    const minScore = nowMs - stardust.ipWindowMs;
    await this.redis.zremrangebyscore(ipKey, '-inf', minScore);
    const hits = await this.redis.zrangebyscore(
      ipKey,
      minScore,
      '+inf',
      'WITHSCORES',
    );
    const ipHits: number[] = [];
    for (let i = 1; i < hits.length; i += 2) {
      ipHits.push(Number(hits[i]));
    }
    return planCooldown({ identityRemainingMs, ipHits }, nowMs);
  }

  private enqueueFlush(pixel: LivePixel): void {
    this.flushBuffer.push(pixel);
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = this.flushBuffer;
      this.flushBuffer = [];
      if (batch.length === 0) {
        return;
      }
      const frame = encodeDelta(batch);
      for (const ws of this.sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(frame);
        }
      }
    }, stardust.flushMs);
  }

  private async startup(): Promise<void> {
    const len = await this.redis.strlen(BOARD_KEY);
    const log = await this.placements
      .find({ board: boardId })
      .sort({ at: 1, _id: 1 })
      .lean()
      .exec();

    if (len === 0) {
      const board = Buffer.alloc(boardByteLength, stardust.blank);
      paintAll(
        board,
        log.map((row) => ({
          x: row.x,
          y: row.y,
          color: row.color as ColorIndex,
        })),
      );
      const set = await this.redis.set(BOARD_KEY, board, 'NX');
      if (set === 'OK') {
        await this.redis.set(SEQ_KEY, String(log.length));
      } else {
        const again = await this.redis.strlen(BOARD_KEY);
        if (again !== boardByteLength) {
          throw new Error(
            `stardust board key has unexpected length ${again}`,
          );
        }
      }
      return;
    }

    if (len !== boardByteLength) {
      throw new Error(`stardust board key has unexpected length ${len}`);
    }

    const seqRaw = await this.redis.get(SEQ_KEY);
    const seq = seqRaw ? Number.parseInt(seqRaw, 10) : 0;
    if (log.length > seq) {
      const missing = log.slice(seq);
      for (const row of missing) {
        const cell = { x: row.x, y: row.y } as Cell;
        await this.redis.setrange(
          BOARD_KEY,
          offset(cell),
          Buffer.from([row.color]),
        );
      }
      await this.redis.set(SEQ_KEY, String(log.length));
    }
  }
}

export function assertBearer(header: string | undefined): string {
  if (!header || !header.startsWith('Bearer ')) {
    throw new UnauthorizedException('Missing token');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new UnauthorizedException('Missing token');
  }
  return token;
}
