import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { InMemoryPaymentsRepository } from './payments/memoryRepository.ts';
import type { PaymentsRepository } from './payments/repository.ts';
import { handlePaysuiteWebhook } from './payments/webhookHandler.ts';

const MAX_BODY_BYTES = 1_000_000;

export interface ServerDeps {
  repo: PaymentsRepository;
  webhookSecret: string;
  now?: () => Date;
}

// Servidor HTTP mínimo (sem dependências) para o webhook e a verificação de saúde.
// A API completa (/v1/...) será montada sobre a framework escolhida no ADR-004.
export function createServer(deps: ServerDeps): Server {
  const now = deps.now ?? (() => new Date());

  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/v1/webhooks/paysuite') {
        const rawBody = await readRawBody(req);
        const signature = firstHeader(req.headers['x-signature']);
        const result = await handlePaysuiteWebhook(
          {
            repo: deps.repo,
            secret: deps.webhookSecret,
            now,
            log: (message, data) => console.log(JSON.stringify({ message, ...data })),
          },
          rawBody,
          signature,
        );
        return sendJson(res, result.status, result.body);
      }

      return sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return sendJson(res, 413, { ok: false, error: 'payload_too_large' });
      }
      console.error(JSON.stringify({ message: 'server.error', error: String(error) }));
      return sendJson(res, 500, { ok: false, error: 'internal_error' });
    }
  });
}

class PayloadTooLargeError extends Error {}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Arranque: node src/server.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  let repo: PaymentsRepository = new InMemoryPaymentsRepository(); // só para desenvolvimento local
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const { PgPaymentsRepository } = await import('./db/pgRepository.ts');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // Comissão global de reserva: a Kulera define o valor real (variável DEFAULT_COMMISSION_BPS).
    repo = new PgPaymentsRepository(pool, Number(process.env.DEFAULT_COMMISSION_BPS ?? 2000));
  }
  const server = createServer({ repo, webhookSecret: config.paysuiteWebhookSecret });
  server.listen(config.port, () => {
    console.log(JSON.stringify({ message: 'api.listening', port: config.port, instance: randomUUID() }));
  });
}
