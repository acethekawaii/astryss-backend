import { DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { HitLimiter } from './hit-limiter';
import { VisitDay, VisitDaySchema } from './schemas/visit-day.schema';
import { Visitor, VisitorSchema } from './schemas/visitor.schema';
import { SITE_STATS_SECRET } from './site-stats.config';
import { SiteStatsController } from './site-stats.controller';
import { Visits } from './visits';

export type SiteStatsModuleOptions = {
  secret: string;
};

@Module({})
export class SiteStatsModule {
  static forRoot(options: SiteStatsModuleOptions): DynamicModule {
    if (!options.secret) {
      throw new Error('SITE_STATS_SECRET is required');
    }
    if (options.secret.length < 32) {
      throw new Error('SITE_STATS_SECRET must be at least 32 characters');
    }
    return {
      module: SiteStatsModule,
      imports: [
        MongooseModule.forFeature([
          { name: VisitDay.name, schema: VisitDaySchema },
          { name: Visitor.name, schema: VisitorSchema },
        ]),
      ],
      controllers: [SiteStatsController],
      providers: [
        { provide: SITE_STATS_SECRET, useValue: options.secret },
        HitLimiter,
        Visits,
      ],
    };
  }
}
