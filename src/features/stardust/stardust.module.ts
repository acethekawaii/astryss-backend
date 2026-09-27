import { DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Canvas, STARDUST_REDIS_URL, STARDUST_SECRET } from './canvas';
import { LiveGateway } from './live.gateway';
import { Placement, PlacementSchema } from './schemas/placement.schema';
import { StardustController } from './stardust.controller';

export type StardustModuleOptions = {
  redisUrl: string;
  secret: string;
};

@Module({})
export class StardustModule {
  static forRoot(options: StardustModuleOptions): DynamicModule {
    if (!options.redisUrl) {
      throw new Error('REDIS_URL is required');
    }
    if (!options.secret) {
      throw new Error('STARDUST_SECRET is required');
    }
    return {
      module: StardustModule,
      imports: [
        MongooseModule.forFeature([
          { name: Placement.name, schema: PlacementSchema },
        ]),
      ],
      controllers: [StardustController],
      providers: [
        { provide: STARDUST_REDIS_URL, useValue: options.redisUrl },
        { provide: STARDUST_SECRET, useValue: options.secret },
        Canvas,
        LiveGateway,
      ],
      exports: [Canvas],
    };
  }
}
