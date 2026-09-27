import { INestApplication } from '@nestjs/common';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { RedisMemoryServer } from 'redis-memory-server';
import Redis from 'ioredis';
import request from 'supertest';
import { WebSocket } from 'ws';

import { configureApp } from '../../main';
import { boardByteLength, stardust } from './stardust.config';
import { decodeDelta, readSnapshotSeq } from './stardust.invariants';
import { Placement } from './schemas/placement.schema';
import { StardustModule } from './stardust.module';

const SECRET = 'stardust-test-secret-at-least-32b';

describe('stardust http', () => {
  let app: INestApplication;
  let mongo: MongoMemoryServer;
  let redisServer: RedisMemoryServer;
  let redisUrl: string;
  let mongoUri: string;
  let redis: Redis;

  async function bootApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongoUri),
        StardustModule.forRoot({ redisUrl, secret: SECRET }),
      ],
    }).compile();
    const nestApp = moduleRef.createNestApplication();
    configureApp(nestApp);
    await nestApp.init();
    await nestApp.listen(0);
    return nestApp;
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      instance: {
        launchTimeout: 60_000,
      },
    });
    redisServer = new RedisMemoryServer();
    mongoUri = mongo.getUri();
    const host = await redisServer.getHost();
    const port = await redisServer.getPort();
    redisUrl = `redis://${host}:${port}`;
    redis = new Redis(redisUrl);
    app = await bootApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    if (redisServer) {
      await redisServer.stop();
    }
    if (mongo) {
      await mongo.stop();
    }
  });

  async function freshToken(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v2/stardust/session')
      .expect(201);
    expect(res.body.message).toBe('Success');
    expect(typeof res.body.data.token).toBe('string');
    return res.body.data.token as string;
  }

  it('places a pixel, updates the snapshot byte, and stores one mongo row without ip', async () => {
    const placementModel = app.get<Model<Placement>>(
      getModelToken(Placement.name),
    );
    const before = await placementModel.countDocuments();
    const token = await freshToken();
    const x = 7;
    const y = 9;
    const color = 5;
    const place = await request(app.getHttpServer())
      .post('/api/v2/stardust/pixels')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', '203.0.113.1')
      .send({ x, y, color })
      .expect(201);
    expect(place.body.data).toMatchObject({ x, y, color });
    expect(typeof place.body.data.nextAllowedAt).toBe('string');

    const board = await request(app.getHttpServer())
      .get('/api/v2/stardust/board')
      .buffer()
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200)
      .expect('Content-Type', /application\/octet-stream/)
      .expect('Cache-Control', 'no-store');

    const body = board.body as Buffer;
    expect(body.toString('ascii', 0, 4)).toBe('STBD');
    const headerLen = 14 + stardust.palette.length * 3;
    expect(body[headerLen + y * stardust.width + x]).toBe(color);

    const rows = await placementModel.find().sort({ _id: -1 }).limit(1).lean();
    expect(await placementModel.countDocuments()).toBe(before + 1);
    expect(rows[0].x).toBe(x);
    expect(rows[0].y).toBe(y);
    expect(rows[0].color).toBe(color);
    expect(typeof rows[0].anonId).toBe('string');
    expect((rows[0] as { ip?: unknown }).ip).toBeUndefined();
  });

  it('returns 429 on the second place from the same token', async () => {
    const placementModel = app.get<Model<Placement>>(
      getModelToken(Placement.name),
    );
    const before = await placementModel.countDocuments();
    const token = await freshToken();
    await request(app.getHttpServer())
      .post('/api/v2/stardust/pixels')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ x: 1, y: 1, color: 2 })
      .expect(201);

    const denied = await request(app.getHttpServer())
      .post('/api/v2/stardust/pixels')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ x: 2, y: 2, color: 3 })
      .expect(429);

    expect(denied.body.message.remainingMs).toBeGreaterThan(29000);
    expect(denied.body.message.remainingMs).toBeLessThanOrEqual(30000);
    expect(typeof denied.body.message.nextAllowedAt).toBe('string');

    const after = await placementModel.countDocuments();
    expect(after - before).toBe(1);
  });

  it(
    'allows the same token again after 30 seconds',
    async () => {
      const token = await freshToken();
      await request(app.getHttpServer())
        .post('/api/v2/stardust/pixels')
        .set('Authorization', `Bearer ${token}`)
        .send({ x: 11, y: 11, color: 4 })
        .expect(201);

      await new Promise((r) => setTimeout(r, 30_500));

      await request(app.getHttpServer())
        .post('/api/v2/stardust/pixels')
        .set('Authorization', `Bearer ${token}`)
        .send({ x: 12, y: 12, color: 6 })
        .expect(201);
    },
    40_000,
  );

  it('rate-limits the 11th token from one forwarded IP', async () => {
    const placementModel = app.get<Model<Placement>>(
      getModelToken(Placement.name),
    );
    const before = await placementModel.countDocuments();
    const tokens: string[] = [];
    for (let i = 0; i < 11; i++) {
      tokens.push(await freshToken());
    }
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/v2/stardust/pixels')
        .set('Authorization', `Bearer ${tokens[i]}`)
        .set('X-Forwarded-For', '198.51.100.20')
        .send({ x: 50 + i, y: 50, color: 1 });
      statuses.push(res.status);
    }
    expect(statuses[10]).toBe(429);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    const after = await placementModel.countDocuments();
    expect(after - before).toBe(10);
  });

  it('does not add log rows for 400 or 401', async () => {
    const placementModel = app.get<Model<Placement>>(
      getModelToken(Placement.name),
    );
    const before = await placementModel.countDocuments();
    const token = await freshToken();

    await request(app.getHttpServer())
      .post('/api/v2/stardust/pixels')
      .set('Authorization', `Bearer ${token}`)
      .send({ x: -1, y: 0, color: 1 })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v2/stardust/pixels')
      .send({ x: 0, y: 0, color: 1 })
      .expect(401);

    const after = await placementModel.countDocuments();
    expect(after).toBe(before);
  });

  it('rebuilds the board from the log after deleting redis keys', async () => {
    const token = await freshToken();
    await request(app.getHttpServer())
      .post('/api/v2/stardust/pixels')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', '203.0.113.50')
      .send({ x: 100, y: 200, color: 8 })
      .expect(201);

    const beforeBoard = await request(app.getHttpServer())
      .get('/api/v2/stardust/board')
      .buffer()
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const previous = Buffer.from(beforeBoard.body);
    const prevSeq = readSnapshotSeq(previous);

    await redis.del('stardust:board', 'stardust:seq');
    await app.close();

    app = await bootApp();

    const afterBoard = await request(app.getHttpServer())
      .get('/api/v2/stardust/board')
      .buffer()
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const rebuilt = Buffer.from(afterBoard.body);
    const headerLen = 14 + stardust.palette.length * 3;
    expect(rebuilt.length).toBe(headerLen + boardByteLength);
    expect(rebuilt.subarray(headerLen).equals(previous.subarray(headerLen))).toBe(
      true,
    );
    expect(readSnapshotSeq(rebuilt)).toBe(prevSeq);
  });

  it('fans a placement out to two authenticated websocket clients', async () => {
    const tokenA = await freshToken();
    const tokenB = await freshToken();
    const tokenPlace = await freshToken();
    await new Promise((r) => setTimeout(r, 1000));

    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('expected tcp address');
    }
    const url = `ws://127.0.0.1:${address.port}/api/v2/stardust/live`;

    const openClient = (token: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(url, {
          origin: 'http://localhost:3000',
        });
        ws.once('open', () => {
          ws.send(JSON.stringify({ token }));
          resolve(ws);
        });
        ws.once('error', reject);
      });

    const wsA = await openClient(tokenA);
    const wsB = await openClient(tokenB);
    await new Promise((r) => setTimeout(r, 100));

    const waitFrame = (ws: WebSocket) =>
      new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('frame timeout')), 1000);
        ws.once('message', (data) => {
          clearTimeout(timer);
          resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        });
      });

    const frameA = waitFrame(wsA);
    const frameB = waitFrame(wsB);

    await request(app.getHttpServer())
      .post('/api/v2/stardust/pixels')
      .set('Authorization', `Bearer ${tokenPlace}`)
      .set('X-Forwarded-For', '203.0.113.77')
      .send({ x: 321, y: 123, color: 10 })
      .expect(201);

    const [a, b] = await Promise.all([frameA, frameB]);
    const pixelsA = decodeDelta(a);
    const pixelsB = decodeDelta(b);
    expect(pixelsA).toHaveLength(1);
    expect(pixelsB).toHaveLength(1);
    expect(pixelsA[0]).toMatchObject({ x: 321, y: 123, color: 10 });
    expect(pixelsB[0]).toMatchObject({ x: 321, y: 123, color: 10 });

    wsA.close();
    wsB.close();
  });
});
