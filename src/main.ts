import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as dotenv from 'dotenv';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { getAllowedOrigins } from './config/allowed-origins';

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v2');

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
    }),
  );

  app.enableCors({
    origin: getAllowedOrigins(),
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  app.useGlobalFilters(new HttpExceptionFilter());
}

async function bootstrap() {
  dotenv.config();
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is required');
  }
  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL is required');
  }
  if (!process.env.STARDUST_SECRET) {
    throw new Error('STARDUST_SECRET is required');
  }
  if (!process.env.CORS_ALLOWED_ORIGINS) {
    throw new Error('CORS_ALLOWED_ORIGINS is required');
  }
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(process.env.PORT ?? 8000);
}

const isEntrypoint =
  typeof require !== 'undefined' && require.main === module;

if (isEntrypoint) {
  void bootstrap();
}
