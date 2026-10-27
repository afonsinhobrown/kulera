import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { createServer } from '../src/server.ts';
import { NOW, SECRET, makeTransaction, repoWith, sign, webhookBody } from './helpers.ts';

describe('servidor HTTP', () => {
  let server: Server;
  let base = '';
  let repo: Awaited<ReturnType<typeof repoWith>>;

  before(async () => {
    repo = await repoWith(makeTransaction());
    server = createServer({ repo, webhookSecret: SECRET, now: () => NOW });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('GET /health', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('rota desconhecida: 404', async () => {
    assert.equal((await fetch(`${base}/nada`)).status, 404);
  });

  it('webhook sem assinatura válida: 401', async () => {
    const body = webhookBody('payment.success', { id: 'pay_1' });
    const res = await fetch(`${base}/v1/webhooks/paysuite`, { method: 'POST', body, headers: { 'x-signature': 'errada' } });
    assert.equal(res.status, 401);
    assert.equal(repo.state.purchases.length, 0);
  });

  it('webhook válido: 200 e acesso activado; repetido: duplicado', async () => {
    const body = webhookBody('payment.success', { id: 'pay_1' });
    const headers = { 'x-signature': sign(body), 'content-type': 'application/json' };
    const first = await fetch(`${base}/v1/webhooks/paysuite`, { method: 'POST', body, headers });
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { result: string }).result, 'applied');
    const second = await fetch(`${base}/v1/webhooks/paysuite`, { method: 'POST', body, headers });
    assert.equal(((await second.json()) as { result: string }).result, 'duplicate');
    assert.equal(repo.state.purchases.length, 1);
  });

  it('corpo demasiado grande: 413', async () => {
    const res = await fetch(`${base}/v1/webhooks/paysuite`, { method: 'POST', body: 'x'.repeat(1_100_000) }).catch(() => null);
    // O servidor pode fechar a ligação ao detectar o excesso; ambos os resultados são aceitáveis.
    assert.ok(res === null || res.status === 413);
  });
});
