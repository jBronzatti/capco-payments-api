import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger, PinoLogger } from 'nestjs-pino';
import { AppModule, AppOverrides } from './app.module';
import { AppConfig } from './infrastructure/config/app-config';
import { jsonBody, requestContext } from './presentation/http/request-context';
import { createValidationPipe } from './presentation/http/validation';

/** Shared by main.ts and the e2e tests, so tests exercise the real HTTP wiring. */
export async function createApp(
  config: AppConfig,
  overrides: AppOverrides = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config, overrides), {
    bodyParser: false,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  const bodyLogger = await app.resolve(PinoLogger);
  app.disable('x-powered-by');
  app.use(
    requestContext,
    helmet(),
    // The `req` key goes through the same redacting serializer as request logs.
    jsonBody((rejection, req) =>
      bodyLogger.warn(
        { event: 'request.body_rejected', req, status: rejection.status, problem: rejection.type },
        'Request body rejected',
      ),
    ),
  );
  app.useGlobalPipes(createValidationPipe());
  app.enableShutdownHooks();
  return app;
}
