import type { Response } from 'express';

export interface FieldProblem {
  field: string;
  message: string;
}

/** RFC 9457 problem document. `type` is a relative URI; nothing from the request is echoed back. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  requestId?: string;
  errors?: FieldProblem[];
}

export function problem(status: number, slug: string, title: string, extra: Partial<Problem> = {}): Problem {
  return { type: `/problems/${slug}`, title, status, ...extra };
}

export function writeProblem(res: Response, body: Problem): void {
  res.status(body.status).type('application/problem+json').send(JSON.stringify(body));
}
