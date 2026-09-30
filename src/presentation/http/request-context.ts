import { randomUUID } from 'node:crypto';
import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import { Problem, problem, writeProblem } from './problem/problem';

const MAX_JSON_BODY = '16kb';
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type BodyRejectionListener = (rejection: Problem, req: Request) => void;

/** Server-generated request id (client-supplied ids are ignored) and no caching of API responses. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  res.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * JSON parsing with a size limit. Prototype-related keys are refused while parsing, before any object
 * mapping runs. Parser errors are answered here because they happen before Nest's filters and request
 * logging are in play, so the listener records them.
 */
export function jsonBody(onRejected: BodyRejectionListener): RequestHandler {
  const parse = express.json({ limit: MAX_JSON_BODY, reviver: refusePrototypeKeys });
  return (req, res, next) =>
    parse(req, res, (error?: unknown) => {
      if (!error) return next();
      const rejection = { ...bodyProblem(error), requestId: String(req.id) };
      onRejected(rejection, req);
      writeProblem(res, rejection);
    });
}

function refusePrototypeKeys(key: string, value: unknown): unknown {
  if (FORBIDDEN_JSON_KEYS.has(key)) throw new SyntaxError('Forbidden key in JSON body');
  return value;
}

function bodyProblem(error: unknown): Problem {
  const type = (error as { type?: string }).type;
  if (type === 'entity.too.large') return problem(413, 'payload-too-large', 'Request body too large');
  if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
    return problem(415, 'unsupported-media-type', 'Unsupported request encoding');
  }
  return problem(400, 'malformed-body', 'Request body is not acceptable JSON');
}
