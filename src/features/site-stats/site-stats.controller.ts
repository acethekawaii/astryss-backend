import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { clientAddress } from '../stardust/stardust.invariants';
import type { UnhashedIp } from '../stardust/types/stardust.types';
import { HitLimiter } from './hit-limiter';
import { siteStats } from './site-stats.config';
import { isBot, parseHitBody } from './site-stats.invariants';
import type { VisitSummary } from './types/site-stats.types';
import { Visits } from './visits';

@Controller('stats')
export class SiteStatsController {
  constructor(
    private readonly visits: Visits,
    private readonly limiter: HitLimiter,
  ) {}

  @Post('visits/hit')
  @HttpCode(HttpStatus.NO_CONTENT)
  hit(@Body() body: unknown, @Req() req: Request): void {
    parseHitBody(body);
    const userAgent = req.headers['user-agent'];
    if (userAgent === undefined || isBot(userAgent)) {
      return;
    }
    let ip: UnhashedIp;
    try {
      ip = clientAddress(
        req.headers['x-forwarded-for'],
        req.socket.remoteAddress,
      );
    } catch {
      return;
    }
    const nowMs = Date.now();
    if (!this.limiter.allow(ip, nowMs)) {
      throw new HttpException('Too many hits', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.visits.track(ip, userAgent, nowMs);
  }

  @Get('visits')
  async getVisits(
    @Res({ passthrough: true }) res: Response,
  ): Promise<VisitSummary> {
    const summary = await this.visits.summary();
    // Set only on success, so a failed read is never cached as public.
    res.setHeader(
      'Cache-Control',
      `public, max-age=${siteStats.summaryTtlMs / 1000}`,
    );
    return summary;
  }
}
