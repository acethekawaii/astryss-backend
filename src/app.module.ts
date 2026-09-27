import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import * as dotenv from 'dotenv';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EntriesModule } from './features/entries/entries.module';
import { StardustModule } from './features/stardust/stardust.module';

dotenv.config();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MongooseModule.forRoot(process.env.MONGO_URI!),
    EntriesModule,
    StardustModule.forRoot({
      redisUrl: process.env.REDIS_URL!,
      secret: process.env.STARDUST_SECRET!,
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
