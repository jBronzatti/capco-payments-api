// Restrictive front door for testing Mercado Pago webhooks through a temporary public tunnel. It forwards exactly
// one route, POST /api/webhooks/mercado-pago (query string kept), to the local API and answers 404 to anything
// else, so the tunnel never reaches the payment endpoints, the health checks or the database.
// Usage: npm run webhook:proxy, then point the tunnel at http://127.0.0.1:8081 (WEBHOOK_PROXY_PORT to change).
// The API is expected on 127.0.0.1:3000; for another port (such as a non-default API_HOST_PORT under Compose):
// PORT=<port> npm run webhook:proxy.
import http from 'node:http';

const ROUTE = '/api/webhooks/mercado-pago';
const LISTEN_PORT = Number(process.env.WEBHOOK_PROXY_PORT ?? 8081);
const API_PORT = Number(process.env.PORT ?? 3000);
const MAX_BODY_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
// Only what the webhook reads; everything a tunnel or client adds (forwarding headers, cookies) is dropped.
const FORWARDED_HEADERS = ['content-type', 'x-signature', 'x-request-id'];

// Passed at construction so Node also lowers headersTimeout; a slow sender is cut after about 20–50 s.
const server = http.createServer({ requestTimeout: 20_000 }, (req, res) => {
  // The raw request target is compared as is: never parsed as a URL, so no normalisation (`..`, `//host`,
  // absolute form) can turn another target into the route, and no malformed target can throw.
  const target = req.url ?? '';
  const queryStart = target.indexOf('?');
  const path = queryStart === -1 ? target : target.slice(0, queryStart);
  if (req.method !== 'POST' || path !== ROUTE) return answer(res, 404, `refused ${req.method}`);
  const search = queryStart === -1 ? '' : target.slice(queryStart);
  readBody(req, res, (body) => forward(req, search, body, res));
});

function readBody(req, res, onBody) {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      answer(res, 413, 'refused oversized body');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => onBody(Buffer.concat(chunks)));
}

function forward(req, search, body, res) {
  // headersDistinct keeps repeated headers repeated, so the API can refuse them instead of seeing them joined.
  const headers = { 'content-length': body.length };
  for (const name of FORWARDED_HEADERS) {
    if (req.headersDistinct[name]) headers[name] = req.headersDistinct[name];
  }
  let upstream;
  try {
    upstream = http.request(
      { host: '127.0.0.1', port: API_PORT, method: 'POST', path: `${ROUTE}${search}`, headers },
      (response) => {
        response.resume();
        answer(res, response.statusCode ?? 502, 'forwarded');
      },
    );
  } catch {
    return answer(res, 400, 'refused unforwardable request');
  }
  let timedOut = false;
  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    timedOut = true;
    upstream.destroy(new Error('upstream timeout'));
  });
  upstream.on('error', (error) => {
    answer(res, timedOut ? 504 : 502, timedOut ? 'upstream timeout' : `upstream error ${error.code ?? ''}`);
  });
  upstream.end(body);
}

// Status only: the API's response body never leaves the machine.
function answer(res, status, note) {
  if (res.headersSent) return;
  res.writeHead(status).end();
  console.log(`${new Date().toISOString()} ${status} ${note}`);
}

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`Forwarding only POST ${ROUTE} from 127.0.0.1:${LISTEN_PORT} to 127.0.0.1:${API_PORT}`);
});
