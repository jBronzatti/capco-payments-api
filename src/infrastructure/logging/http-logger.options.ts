import type { IncomingMessage } from 'node:http';
import type { Options } from 'pino-http';
import { LogLevel } from '../config/app-config';
import { serializeError, serializeRequest } from './log-serializers';

/**
 * Request logs carry id, method, path and query keys only: no headers (API keys), no bodies, no query values.
 * Errors keep type, code and stack frames only, because driver messages embed row values.
 */
export function httpLoggerOptions(level: LogLevel): Options {
  return {
    level,
    genReqId: (req: IncomingMessage) => req.id,
    wrapSerializers: false,
    serializers: {
      req: serializeRequest,
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      err: serializeError,
    },
    redact: { paths: ['headers', '*.headers', 'body', '*.body', 'cpf', '*.cpf'], censor: '[REDACTED]' },
    autoLogging: { ignore: (req) => req.url?.startsWith('/health/') ?? false },
    customLogLevel: (_req, res, error) => {
      if (error || res.statusCode >= 500) return 'error';
      return res.statusCode >= 400 ? 'warn' : 'info';
    },
  };
}
