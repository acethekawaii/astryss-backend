import {
  clientAddress,
  decodeDelta,
  encodeDelta,
  encodeSnapshot,
  mintToken,
  planCooldown,
  readSnapshotSeq,
  tokenId,
} from './stardust.invariants';
import { boardByteLength, stardust } from './stardust.config';
import { LivePixel } from './stardust.types';

describe('stardust invariants', () => {
  const secret = 'a'.repeat(32);

  it('ignores a spoofed left-most X-Forwarded-For hop', () => {
    expect(clientAddress('1.1.1.1, 203.0.113.9', '10.0.0.1')).toBe(
      '203.0.113.9',
    );
  });

  it('denies when identityRemainingMs is 12000', () => {
    const plan = planCooldown(
      { identityRemainingMs: 12000, ipHits: [] },
      1_000_000,
    );
    expect(plan).toEqual({
      ok: false,
      remainingMs: 12000,
      nextAllowedAt: new Date(1_000_000 + 12000).toISOString(),
    });
  });

  it('allows with 9 hits and sets nextAllowedAt to now + 30000 when the hit fills the IP cap', () => {
    const now = 2_000_000;
    const hits = Array.from({ length: 9 }, (_, i) => now - 1000 * (i + 1));
    const plan = planCooldown(
      { identityRemainingMs: 0, ipHits: hits },
      now,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    const oldest = Math.min(...hits);
    expect(plan.nextAllowedAt).toBe(
      new Date(
        Math.max(now + 30000, oldest + stardust.ipWindowMs),
      ).toISOString(),
    );
    expect(plan.identityTtlMs).toBe(30000);
    expect(plan.recordIpAtMs).toBe(now);
  });

  it('denies about 10 seconds when 10 hits have oldest 50 seconds ago', () => {
    const now = 3_000_000;
    const oldest = now - 50_000;
    const hits = Array.from({ length: 10 }, (_, i) => oldest + i * 100);
    const plan = planCooldown(
      { identityRemainingMs: 0, ipHits: hits },
      now,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    expect(plan.remainingMs).toBe(10_000);
    expect(plan.nextAllowedAt).toBe(
      new Date(now + 10_000).toISOString(),
    );
  });

  it('throws on a tampered token', () => {
    const token = mintToken(secret);
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(() => tokenId(tampered, secret)).toThrow();
  });

  it('encodes a snapshot with pixel 12 set to color 5', () => {
    const board = Buffer.alloc(boardByteLength, 0);
    board[12] = 5;
    const seq = 42;
    const snap = encodeSnapshot(board, seq);
    expect(snap.toString('ascii', 0, 4)).toBe('STBD');
    expect(readSnapshotSeq(snap)).toBe(42);
    const headerLen = 14 + stardust.palette.length * 3;
    expect(snap[headerLen + 12]).toBe(5);
  });

  it('collapses two live pixels for the same cell to the greater seq', () => {
    const pixels: LivePixel[] = [
      { seq: 1, x: 3, y: 4, color: 2 as never },
      { seq: 5, x: 3, y: 4, color: 9 as never },
      { seq: 3, x: 3, y: 4, color: 1 as never },
    ];
    const frame = encodeDelta(pixels);
    const decoded = decodeDelta(frame);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual({ seq: 5, x: 3, y: 4, color: 9 });
  });
});
