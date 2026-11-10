import { Inject, Injectable } from '@nestjs/common';

import { hashIp } from '../stardust/stardust.invariants';
import type { UnhashedIp } from '../stardust/types/stardust.types';
import { SITE_STATS_SECRET, siteStats } from './site-stats.config';

type Window = { startedAt: number; count: number };

// Allows hitLimit hits per IP in each fixed window. It keeps the counts in
// process memory: the API runs as one container, a restart only forgives the
// current minute, and the check never waits on the network.
@Injectable()
export class HitLimiter {
  private readonly windows = new Map<string, Window>();
  private sweptAt = 0;

  constructor(@Inject(SITE_STATS_SECRET) private readonly secret: string) {}

  allow(ip: UnhashedIp, nowMs: number): boolean {
    this.sweep(nowMs);
    const key = hashIp(this.secret, ip);
    const window = this.windows.get(key);
    if (!window || nowMs - window.startedAt >= siteStats.hitWindowMs) {
      this.windows.set(key, { startedAt: nowMs, count: 1 });
      return true;
    }
    if (window.count >= siteStats.hitLimit) {
      return false;
    }
    window.count += 1;
    return true;
  }

  private sweep(nowMs: number): void {
    if (nowMs - this.sweptAt < siteStats.hitWindowMs) {
      return;
    }
    this.sweptAt = nowMs;
    for (const [key, window] of this.windows) {
      if (nowMs - window.startedAt >= siteStats.hitWindowMs) {
        this.windows.delete(key);
      }
    }
  }
}
