import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type { UnhashedIp } from '../stardust/types/stardust.types';
import { VisitDay, VisitDayDocument } from './schemas/visit-day.schema';
import { Visitor, VisitorDocument } from './schemas/visitor.schema';
import { SITE_STATS_SECRET, siteStats } from './site-stats.config';
import { manilaDate, visitorHash } from './site-stats.invariants';
import type { ManilaDate, VisitSummary } from './types/site-stats.types';

type Totals = {
  total: number;
  todayPageviews: number;
  todayVisitors: number;
  since: ManilaDate;
};

@Injectable()
export class Visits implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Visits.name);
  private readonly pending = new Set<Promise<void>>();
  private summarized: {
    value: VisitSummary;
    date: ManilaDate;
    at: number;
  } | null = null;
  private summarizing: Promise<VisitSummary> | null = null;

  constructor(
    @InjectModel(VisitDay.name)
    private readonly days: Model<VisitDayDocument>,
    @InjectModel(Visitor.name)
    private readonly visitors: Model<VisitorDocument>,
    @Inject(SITE_STATS_SECRET) private readonly secret: string,
  ) {}

  // The unique indexes turn simultaneous first hits into one upserted document
  // instead of two, so they must exist before the first hit is counted.
  async onModuleInit(): Promise<void> {
    await Promise.all([this.days.init(), this.visitors.init()]);
  }

  async onModuleDestroy(): Promise<void> {
    await this.drain();
  }

  // Starts counting one page view and returns without waiting for Mongo, so
  // the hit can be answered at once. A failed write is logged, never thrown.
  track(ip: UnhashedIp, userAgent: string, nowMs = Date.now()): void {
    const write: Promise<void> = this.record(ip, userAgent, nowMs)
      .catch((err: unknown) => {
        this.logger.warn(`Page view not counted: ${String(err)}`);
      })
      .finally(() => {
        this.pending.delete(write);
      });
    this.pending.add(write);
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
  }

  // The homepage polls this, so one read serves every request for
  // summaryTtlMs, requests that arrive while it runs share it, and Manila
  // midnight starts a fresh read so "today" never shows yesterday.
  summary(nowMs = Date.now()): Promise<VisitSummary> {
    const date = manilaDate(nowMs);
    const cached = this.summarized;
    if (
      cached &&
      cached.date === date &&
      nowMs - cached.at < siteStats.summaryTtlMs
    ) {
      return Promise.resolve(cached.value);
    }
    this.summarizing ??= this.summarize(date)
      .then((value) => {
        this.summarized = { value, date, at: nowMs };
        return value;
      })
      .finally(() => {
        this.summarizing = null;
      });
    return this.summarizing;
  }

  private async record(
    ip: UnhashedIp,
    userAgent: string,
    nowMs: number,
  ): Promise<void> {
    const date = manilaDate(nowMs);
    const hash = visitorHash(this.secret, date, ip, userAgent);
    const seen = await this.visitors
      .updateOne(
        { date, hash },
        { $setOnInsert: { at: new Date(nowMs) } },
        { upsert: true },
      )
      .exec();
    const firstToday = seen.upsertedCount === 1;
    await this.days
      .updateOne(
        { date },
        { $inc: { pageviews: 1, visitors: firstToday ? 1 : 0 } },
        { upsert: true },
      )
      .exec();
  }

  // The lifetime total is summed from the day documents, not kept in a
  // counter of its own: a hit then makes one write instead of two, so the
  // total can never drift from the days, and there is one document per day.
  private async summarize(today: ManilaDate): Promise<VisitSummary> {
    const isToday = { $eq: ['$date', today] };
    const [row] = await this.days
      .aggregate<Totals>([
        {
          $group: {
            _id: null,
            total: { $sum: '$pageviews' },
            todayPageviews: { $sum: { $cond: [isToday, '$pageviews', 0] } },
            todayVisitors: { $sum: { $cond: [isToday, '$visitors', 0] } },
            since: { $min: '$date' },
          },
        },
      ])
      .exec();
    return {
      totalPageviews: row?.total ?? 0,
      todayPageviews: row?.todayPageviews ?? 0,
      todayVisitors: row?.todayVisitors ?? 0,
      since: row?.since ?? null,
    };
  }
}
