import { createHash, createHmac } from 'crypto';
import { BadRequestException } from '@nestjs/common';

import type { UnhashedIp } from '../stardust/types/stardust.types';
import { siteStats } from './site-stats.config';
import type { ManilaDate, VisitorHash } from './types/site-stats.types';

export function manilaDate(nowMs: number): ManilaDate {
  return new Date(nowMs + siteStats.manilaOffsetMs)
    .toISOString()
    .slice(0, 10) as ManilaDate;
}

export function isBot(userAgent: string): boolean {
  return userAgent.trim() === '' || siteStats.botUserAgent.test(userAgent);
}

export function parseHitBody(body: unknown): { path: string } {
  if (body === null || typeof body !== 'object') {
    throw new BadRequestException('Invalid body');
  }
  const { path } = body as { path?: unknown };
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.length > siteStats.maxPathLength
  ) {
    throw new BadRequestException('Invalid path');
  }
  return { path };
}

// The salt changes at Manila midnight and is never stored, so a stored hash
// ties a visitor to one day only, and without the secret nobody can hash every
// IPv4 address to find whose it is.
export function dailySalt(secret: string, date: ManilaDate): string {
  return createHmac('sha256', secret)
    .update(`site-stats:visitor:${date}`)
    .digest('hex');
}

export function visitorHash(
  secret: string,
  date: ManilaDate,
  ip: UnhashedIp,
  userAgent: string,
): VisitorHash {
  return createHash('sha256')
    .update(`${ip}\n${userAgent}\n${dailySalt(secret, date)}`)
    .digest('hex') as VisitorHash;
}
