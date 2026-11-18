import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ApiHealth } from '@ado/shared';

@Controller()
class HealthController {
  @Get('health')
  health(): ApiHealth {
    return { service: 'ado-api', status: 'ok' };
  }
}

@Module({ controllers: [HealthController] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3101), '0.0.0.0');
}

void bootstrap();
