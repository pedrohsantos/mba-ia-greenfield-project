import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { ChannelsService } from '../../src/channels/channels.service';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { User } from '../../src/users/entities/user.entity';
import { applyVideoTestEnv } from '../../src/test/video-test-env';

export interface VideosE2eContext {
  app: INestApplication<App>;
  moduleRef: TestingModule;
  dataSource: DataSource;
}

/** Boots the full API like main.ts does (global pipe + filters) with video test env applied. */
export async function bootstrapVideosApp(): Promise<VideosE2eContext> {
  applyVideoTestEnv();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  return { app, moduleRef, dataSource: moduleRef.get(DataSource) };
}

export interface AuthenticatedUser {
  userId: string;
  channelId: string;
  token: string;
}

/**
 * Creates a confirmed user with its channel and signs an access token with the
 * app's JwtService (the auth flow itself is covered by auth.e2e-spec.ts).
 */
export async function createAuthenticatedUser(
  ctx: VideosE2eContext,
): Promise<AuthenticatedUser> {
  const email = `videos_${randomUUID().slice(0, 8)}@example.com`;
  const user = await ctx.dataSource.getRepository(User).save({
    email,
    password: 'not-used-in-video-tests',
    is_confirmed: true,
  });
  const channel = await ctx.moduleRef
    .get(ChannelsService)
    .createChannel(user.id, email);
  const token = await ctx.moduleRef
    .get(JwtService)
    .signAsync({ sub: user.id, email });
  return { userId: user.id, channelId: channel.id, token };
}

/** PUTs a part straight to storage through its presigned URL and returns the ETag. */
export async function putPart(url: string, body: Buffer): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  if (res.status !== 200) {
    throw new Error(`PUT part failed with ${res.status}: ${await res.text()}`);
  }
  return res.headers.get('etag') as string;
}
