import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ApiHealth } from '@ado/shared';
import { ArtifactStore, ArtifactsController, ArtifactsService } from './artifacts';
import { AuthController, AuthService, SessionGuard } from './auth';
import { Database } from './database';
import { DeliveriesController, DeliveriesService, GIT_PUBLISH } from './deliveries';
import { pushCandidate } from './git-delivery';
import { ExecutionsController, ExecutionsService } from './executions';
import { GitHubApp, RepositoriesController } from './github';
import { GitHubWebhookController } from './github-webhook';
import { ProjectsController, ProjectsService } from './projects';
import { TasksController, TasksService } from './tasks';
import { WorkerGateway } from './worker-gateway';
import { WorkersController, WorkersService } from './workers';

@Controller()
class HealthController {
  @Get('health')
  health(): ApiHealth {
    return { service: 'ado-api', status: 'ok' };
  }
}

@Module({
  controllers: [HealthController, AuthController, ProjectsController, RepositoriesController, TasksController, WorkersController,
    ExecutionsController, ArtifactsController, DeliveriesController, GitHubWebhookController],
  providers: [Database, AuthService, SessionGuard, ProjectsService, GitHubApp, TasksService, WorkersService, WorkerGateway,
    ExecutionsService, ArtifactStore, ArtifactsService, DeliveriesService, { provide: GIT_PUBLISH, useValue: pushCandidate }],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.get(WorkerGateway).attach(app.getHttpServer());
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3101), '0.0.0.0');
}

void bootstrap();
