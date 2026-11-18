import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ApiHealth } from '@ado/shared';
import { AuthController, AuthService, SessionGuard } from './auth';
import { Database } from './database';
import { GitHubApp, RepositoriesController } from './github';
import { ProjectsController, ProjectsService } from './projects';
import { TasksController, TasksService } from './tasks';

@Controller()
class HealthController {
  @Get('health')
  health(): ApiHealth {
    return { service: 'ado-api', status: 'ok' };
  }
}

@Module({
  controllers: [HealthController, AuthController, ProjectsController, RepositoriesController, TasksController],
  providers: [Database, AuthService, SessionGuard, ProjectsService, GitHubApp, TasksService],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3101), '0.0.0.0');
}

void bootstrap();
