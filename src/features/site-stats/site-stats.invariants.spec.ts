import { BadRequestException } from '@nestjs/common';

import type { UnhashedIp } from '../stardust/types/stardust.types';
import { HitLimiter } from './hit-limiter';
import { siteStats } from './site-stats.config';
import {
  isBot,
  manilaDate,
  parseHitBody,
  visitorHash,
} from './site-stats.invariants';
import type { ManilaDate } from './types/site-stats.types';

const SECRET = 'site-stats-test-secret-0123456789abcdef';
const IP = '203.0.113.7' as UnhashedIp;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0';

describe('manilaDate', () => {
  it('starts the day at 00:00 Asia/Manila, 16:00 UTC the day before', () => {
    expect(manilaDate(Date.UTC(2026, 10, 10, 15, 59, 59, 999))).toBe(
      '2026-11-10',
    );
    expect(manilaDate(Date.UTC(2026, 10, 10, 16, 0, 0, 0))).toBe('2026-11-11');
  });

  it('rolls the year at Manila midnight', () => {
    expect(manilaDate(Date.UTC(2026, 11, 31, 16, 0, 0, 0))).toBe('2027-01-01');
  });
});

describe('isBot', () => {
  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0)',
    'Mozilla/5.0 (compatible; Baiduspider/2.0)',
    'Sogou web spider/4.0',
    'SomeCrawler/1.0',
    'Mozilla/5.0 (compatible; Discordbot/2.0)',
    'Slackbot-LinkExpanding 1.0',
    'WhatsApp/2.23 Link Preview',
    '',
    '   ',
  ])('treats %j as a bot', (userAgent) => {
    expect(isBot(userAgent)).toBe(true);
  });

  it.each([
    UA,
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
  ])('counts %j', (userAgent) => {
    expect(isBot(userAgent)).toBe(false);
  });
});

describe('parseHitBody', () => {
  it('accepts a path', () => {
    expect(parseHitBody({ path: '/release' })).toEqual({ path: '/release' });
  });

  it.each<[string, unknown]>([
    ['no body', undefined],
    ['null', null],
    ['a string body', 'path'],
    ['no path', {}],
    ['a number path', { path: 42 }],
    ['a relative path', { path: 'release' }],
    ['an over-long path', { path: `/${'a'.repeat(siteStats.maxPathLength)}` }],
  ])('rejects %s', (_label, body) => {
    expect(() => parseHitBody(body)).toThrow(BadRequestException);
  });
});

describe('visitorHash', () => {
  const day = '2026-11-10' as ManilaDate;
  const nextDay = '2026-11-11' as ManilaDate;

  it('is the same for one browser all day and holds no raw input', () => {
    const hash = visitorHash(SECRET, day, IP, UA);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(visitorHash(SECRET, day, IP, UA)).toBe(hash);
    expect(hash).not.toContain(IP);
  });

  it('differs for another IP, user agent, day, or secret', () => {
    const hash = visitorHash(SECRET, day, IP, UA);
    const others = [
      visitorHash(SECRET, day, '203.0.113.8' as UnhashedIp, UA),
      visitorHash(SECRET, day, IP, `${UA} Edg/130.0`),
      visitorHash(SECRET, nextDay, IP, UA),
      visitorHash(`${SECRET}-rotated`, day, IP, UA),
    ];
    expect(new Set([hash, ...others]).size).toBe(5);
  });
});

describe('HitLimiter', () => {
  const start = Date.UTC(2026, 10, 10, 4, 0, 0);

  it('allows hitLimit hits per IP per window, then the next window', () => {
    const limiter = new HitLimiter(SECRET);
    const results = Array.from({ length: siteStats.hitLimit + 5 }, (_, i) =>
      limiter.allow(IP, start + i),
    );
    expect(results.filter(Boolean)).toHaveLength(siteStats.hitLimit);
    expect(results.slice(siteStats.hitLimit).every((ok) => !ok)).toBe(true);

    expect(limiter.allow('203.0.113.8' as UnhashedIp, start + 100)).toBe(true);
    expect(limiter.allow(IP, start + siteStats.hitWindowMs - 1)).toBe(false);
    expect(limiter.allow(IP, start + siteStats.hitWindowMs)).toBe(true);
  });

  it('keys its memory by a hash, not the raw IP', () => {
    const limiter = new HitLimiter(SECRET);
    limiter.allow(IP, start);
    const keys = [
      ...(
        limiter as unknown as { windows: Map<string, unknown> }
      ).windows.keys(),
    ];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(IP);
  });
});
