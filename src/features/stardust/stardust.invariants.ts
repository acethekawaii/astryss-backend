import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';

import { boardByteLength, stardust } from './stardust.config';
import {
  AnonId,
  Cell,
  ColorIndex,
  CooldownPlan,
  CooldownView,
  IpHash,
  LivePixel,
  StoredPlacement,
  UnhashedIp,
} from './stardust.types';

function asAnonId(value: string): AnonId {
  return value as AnonId;
}

function asColorIndex(value: number): ColorIndex {
  return value as ColorIndex;
}

function asCell(x: number, y: number): Cell {
  return { x, y } as Cell;
}

function asUnhashedIp(value: string): UnhashedIp {
  return value as UnhashedIp;
}

function asIpHash(value: string): IpHash {
  return value as IpHash;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export function parseCell(x: unknown, y: unknown): Cell {
  if (!isInt(x) || !isInt(y)) {
    throw new BadRequestException('Invalid cell');
  }
  if (x < 0 || x >= stardust.width || y < 0 || y >= stardust.height) {
    throw new BadRequestException('Invalid cell');
  }
  return asCell(x, y);
}

export function parseColor(color: unknown): ColorIndex {
  if (!isInt(color) || color < 0 || color >= stardust.palette.length) {
    throw new BadRequestException('Invalid color');
  }
  return asColorIndex(color);
}

export function parsePlaceBody(body: unknown): {
  cell: Cell;
  color: ColorIndex;
} {
  if (body === null || typeof body !== 'object') {
    throw new BadRequestException('Invalid body');
  }
  const { x, y, color } = body as { x?: unknown; y?: unknown; color?: unknown };
  return { cell: parseCell(x, y), color: parseColor(color) };
}

export function clientAddress(
  forwardedFor: string | string[] | undefined,
  socketAddress: string | undefined,
): UnhashedIp {
  const header = Array.isArray(forwardedFor)
    ? forwardedFor.join(',')
    : (forwardedFor ?? '');
  const chain = header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (socketAddress) {
    chain.push(socketAddress);
  }
  const index = Math.max(0, chain.length - 1 - stardust.trustedProxyHops);
  const chosen = chain[index];
  if (!chosen) {
    throw new BadRequestException('Missing client address');
  }
  return asUnhashedIp(chosen);
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function mintToken(secret: string, idBytes?: Buffer): string {
  const id = idBytes ?? randomBytes(16);
  if (id.length !== 16) {
    throw new Error('idBytes must be 16 bytes');
  }
  const idPart = b64url(id);
  const payload = `1.${idPart}`;
  const mac = createHmac('sha256', secret).update(payload).digest();
  return `${payload}.${b64url(mac)}`;
}

export function tokenId(token: string, secret: string): AnonId {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== '1') {
    throw new UnauthorizedException('Invalid token');
  }
  const [, idPart, macPart] = parts;
  if (!idPart || !macPart) {
    throw new UnauthorizedException('Invalid token');
  }
  const expected = createHmac('sha256', secret)
    .update(`1.${idPart}`)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(macPart, 'base64url');
  } catch {
    throw new UnauthorizedException('Invalid token');
  }
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new UnauthorizedException('Invalid token');
  }
  return asAnonId(idPart);
}

export function hashIp(secret: string, ip: UnhashedIp): IpHash {
  return asIpHash(
    createHmac('sha256', secret).update(ip).digest('hex'),
  );
}

export function offset(cell: Cell): number {
  return cell.y * stardust.width + cell.x;
}

export function planCooldown(view: CooldownView, nowMs: number): CooldownPlan {
  const recent = view.ipHits.filter((t) => t > nowMs - stardust.ipWindowMs);
  const ipCount = recent.length;
  let ipWait = 0;
  if (ipCount >= stardust.ipLimit) {
    const oldest = Math.min(...recent);
    ipWait = oldest + stardust.ipWindowMs - nowMs;
  }
  const wait = Math.max(view.identityRemainingMs, ipWait);
  if (wait > 0) {
    return {
      ok: false,
      remainingMs: wait,
      nextAllowedAt: iso(nowMs + wait),
    };
  }

  const identityTtlMs = stardust.identityCooldownMs;
  const recordIpAtMs = nowMs;
  let nextAllowedAt: string;
  if (ipCount + 1 >= stardust.ipLimit) {
    const oldest = recent.length === 0 ? nowMs : Math.min(...recent);
    nextAllowedAt = iso(
      Math.max(nowMs + identityTtlMs, oldest + stardust.ipWindowMs),
    );
  } else {
    nextAllowedAt = iso(nowMs + identityTtlMs);
  }

  return {
    ok: true,
    identityTtlMs,
    recordIpAtMs,
    nextAllowedAt,
  };
}

export function paintAll(
  board: Buffer,
  records: Pick<StoredPlacement, 'x' | 'y' | 'color'>[],
): void {
  for (const row of records) {
    const cell = asCell(row.x, row.y);
    board[offset(cell)] = row.color;
  }
}

function parseHexRgb(hex: string): [number, number, number] {
  const raw = hex.startsWith('#') ? hex.slice(1) : hex;
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ];
}

export function encodeSnapshot(board: Buffer, seq: number): Buffer {
  const headerLen = 14 + stardust.palette.length * 3;
  const out = Buffer.alloc(headerLen + boardByteLength);
  out.write('STBD', 0, 4, 'ascii');
  out.writeUInt8(1, 4);
  out.writeUInt16BE(stardust.width, 5);
  out.writeUInt16BE(stardust.height, 7);
  out.writeUInt32BE(seq >>> 0, 9);
  out.writeUInt8(stardust.palette.length, 13);
  let at = 14;
  for (const hex of stardust.palette) {
    const [r, g, b] = parseHexRgb(hex);
    out.writeUInt8(r, at++);
    out.writeUInt8(g, at++);
    out.writeUInt8(b, at++);
  }
  board.copy(out, headerLen, 0, boardByteLength);
  return out;
}

export function readSnapshotSeq(buf: Buffer): number {
  if (buf.length < 13 || buf.toString('ascii', 0, 4) !== 'STBD') {
    throw new BadRequestException('Invalid snapshot');
  }
  return buf.readUInt32BE(9);
}

export function encodeRecord(pixel: LivePixel): Buffer {
  const out = Buffer.alloc(9);
  out.writeUInt32BE(pixel.seq >>> 0, 0);
  out.writeUInt16BE(pixel.x, 4);
  out.writeUInt16BE(pixel.y, 6);
  out.writeUInt8(pixel.color, 8);
  return out;
}

export function decodeRecord(buf: Buffer, start = 0): LivePixel {
  return {
    seq: buf.readUInt32BE(start),
    x: buf.readUInt16BE(start + 4),
    y: buf.readUInt16BE(start + 6),
    color: asColorIndex(buf.readUInt8(start + 8)),
  };
}

export function encodeDelta(pixels: LivePixel[]): Buffer {
  const byCell = new Map<string, LivePixel>();
  for (const pixel of pixels) {
    const key = `${pixel.x},${pixel.y}`;
    const prev = byCell.get(key);
    if (!prev || pixel.seq > prev.seq) {
      byCell.set(key, pixel);
    }
  }
  const collapsed = [...byCell.values()];
  const out = Buffer.alloc(7 + collapsed.length * 9);
  out.write('STPX', 0, 4, 'ascii');
  out.writeUInt8(1, 4);
  out.writeUInt16BE(collapsed.length, 5);
  let at = 7;
  for (const pixel of collapsed) {
    encodeRecord(pixel).copy(out, at);
    at += 9;
  }
  return out;
}

export function decodeDelta(buf: Buffer): LivePixel[] {
  if (buf.length < 7 || buf.toString('ascii', 0, 4) !== 'STPX') {
    throw new BadRequestException('Invalid delta');
  }
  const count = buf.readUInt16BE(5);
  const pixels: LivePixel[] = [];
  let at = 7;
  for (let i = 0; i < count; i++) {
    pixels.push(decodeRecord(buf, at));
    at += 9;
  }
  return pixels;
}
