import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { money } from '../src/domain/money.ts';
import { DomainError } from '../src/domain/types.ts';
import { createCheckout } from '../src/payments/checkout.ts';
import { InMemoryPaymentsRepository } from '../src/payments/memoryRepository.ts';
import { FakePaymentProvider } from '../src/payments/provider.ts';
import { reconcilePending } from '../src/payments/reconcile.ts';
import { verifySignature } from '../src/payments/signature.ts';
import { handlePaysuiteWebhook } from '../src/payments/webhookHandler.ts';
import { NOW, SECRET, makeTransaction, repoWith, sign, webhookBody } from './helpers.ts';

const deps = (repo: InMemoryPaymentsRepository) => ({ repo, secret: SECRET, now: () => NOW });
const send = (repo: InMemoryPaymentsRepository, body: string, signature: string | undefined = sign(body)) =>
  handlePaysuiteWebhook(deps(repo), body, signature);

describe('assinatura do webhook', () => {
  const body = '{"event":"payment.success"}';
  it('aceita assinatura válida (hex, com e sem prefixo)', () => {
    assert.equal(verifySignature(body, sign(body), SECRET), true);
    assert.equal(verifySignature(body, `sha256=${sign(body)}`, SECRET), true);
    assert.equal(verifySignature(body, sign(body).toUpperCase(), SECRET), true);
  });
  it('rejeita assinatura errada, ausente ou de outro corpo', () => {
    assert.equal(verifySignature(body, sign(body, 'outro-segredo'), SECRET), false);
    assert.equal(verifySignature(body, undefined, SECRET), false);
    assert.equal(verifySignature(body, '', SECRET), false);
    assert.equal(verifySignature(body + ' ', sign(body), SECRET), false);
    assert.equal(verifySignature(body, 'abc', SECRET), false);
  });
  it('rejeita tudo se o segredo estiver vazio', () => {
    assert.equal(verifySignature(body, sign(body, ''), ''), false);
  });
});

describe('webhook PaySuite', () => {
  it('pagamento confirmado activa a compra e regista o split', async () => {
    const repo = await repoWith(makeTransaction());
    const res = await send(repo, webhookBody('payment.success', { id: 'pay_1', reference: 'KPREF1' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'applied');
    assert.equal(repo.state.transactions.get('tx-1')?.status, 'paid');
    assert.equal(repo.state.purchases.length, 1);
    assert.equal(repo.state.sales.length, 1);
    assert.equal(repo.state.sales[0]?.commission.amount, 10_000);
    assert.equal(repo.state.sales[0]?.partnerShare.amount, 40_000);
  });

  it('assinatura inválida: 401 e nada muda', async () => {
    const repo = await repoWith(makeTransaction());
    const body = webhookBody('payment.success', { id: 'pay_1' });
    const res = await send(repo, body, sign(body, 'errado'));
    assert.equal(res.status, 401);
    assert.equal(repo.state.transactions.get('tx-1')?.status, 'pending');
    assert.equal(repo.state.purchases.length, 0);
  });

  it('sem assinatura: 401', async () => {
    const repo = await repoWith(makeTransaction());
    const res = await handlePaysuiteWebhook(deps(repo), webhookBody('payment.success', { id: 'pay_1' }), undefined);
    assert.equal(res.status, 401);
    assert.equal(repo.state.purchases.length, 0);
  });

  it('JSON inválido ou sem evento: 400', async () => {
    const repo = await repoWith(makeTransaction());
    assert.equal((await send(repo, 'não é json')).status, 400);
    assert.equal((await send(repo, JSON.stringify({ data: { id: 'pay_1' } }))).status, 400);
  });

  it('webhook repetido não duplica nada', async () => {
    const repo = await repoWith(makeTransaction());
    const body = webhookBody('payment.success', { id: 'pay_1' });
    const first = await send(repo, body);
    const second = await send(repo, body);
    const third = await send(repo, body);
    assert.equal(first.body.result, 'applied');
    assert.equal(second.body.result, 'duplicate');
    assert.equal(third.body.result, 'duplicate');
    assert.equal(repo.state.purchases.length, 1);
    assert.equal(repo.state.sales.length, 1);
  });

  it('pagamento cancelado ou falhado não activa nada', async () => {
    for (const event of ['payment.cancelled', 'payment.failed']) {
      const repo = await repoWith(makeTransaction());
      const res = await send(repo, webhookBody(event, { id: 'pay_1' }));
      assert.equal(res.status, 200);
      assert.equal(repo.state.purchases.length, 0);
      assert.equal(repo.state.sales.length, 0);
      assert.notEqual(repo.state.transactions.get('tx-1')?.status, 'paid');
    }
  });

  it('confirmação tardia depois de «falhado» activa e fica auditada', async () => {
    const repo = await repoWith(makeTransaction());
    await send(repo, webhookBody('payment.failed', { id: 'pay_1' }));
    const res = await send(repo, webhookBody('payment.success', { id: 'pay_1' }));
    assert.equal(res.body.result, 'applied_late_confirmation');
    assert.equal(repo.state.transactions.get('tx-1')?.status, 'paid');
    assert.equal(repo.state.purchases.length, 1);
    assert.ok(repo.state.audit.some((a) => a.action === 'payment.late_confirmation'));
  });

  it('«falhado» chegado depois de «pago» é ignorado', async () => {
    const repo = await repoWith(makeTransaction());
    await send(repo, webhookBody('payment.success', { id: 'pay_1' }));
    const res = await send(repo, webhookBody('payment.failed', { id: 'pay_1' }));
    assert.equal(res.body.result, 'ignored');
    assert.equal(repo.state.transactions.get('tx-1')?.status, 'paid');
    assert.equal(repo.state.purchases.length, 1);
  });

  it('webhook antes de guardarmos o id do pagamento: encontra pela referência', async () => {
    const repo = await repoWith(makeTransaction({ providerPaymentId: null, status: 'created' }));
    const res = await send(repo, webhookBody('payment.success', { id: 'pay_9', reference: 'KPREF1' }));
    assert.equal(res.status, 200);
    const t = repo.state.transactions.get('tx-1');
    assert.equal(t?.status, 'paid');
    assert.equal(t?.providerPaymentId, 'pay_9');
  });

  it('transacção desconhecida: 404 e evento NÃO registado (reenvio ainda funciona)', async () => {
    const repo = new InMemoryPaymentsRepository();
    const body = webhookBody('payment.success', { id: 'pay_x', reference: 'KPX' });
    const res = await send(repo, body);
    assert.equal(res.status, 404);
    assert.equal(repo.state.events.size, 0);
    await repo.createTransaction(makeTransaction({ providerPaymentId: 'pay_x', reference: 'KPX' }));
    assert.equal((await send(repo, body)).body.result, 'applied');
  });

  it('evento desconhecido: 200 sem efeitos', async () => {
    const repo = await repoWith(makeTransaction());
    const res = await send(repo, webhookBody('payout.failed', { id: 'pay_1' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'unknown_event');
    assert.equal(repo.state.transactions.get('tx-1')?.status, 'pending');
  });

  it('reembolso retira o acesso e reverte o split', async () => {
    const repo = await repoWith(makeTransaction());
    await send(repo, webhookBody('payment.success', { id: 'pay_1' }));
    const res = await send(repo, webhookBody('refund.success', { payment_id: 'pay_1' }));
    assert.equal(res.body.result, 'applied');
    assert.equal(repo.state.transactions.get('tx-1')?.status, 'refunded');
    assert.ok(repo.state.purchases.every((p) => p.revokedAt !== null));
    assert.ok(repo.state.sales.every((s) => s.reversedAt));
  });

  it('subscrição: activa 1 mês e renova a partir do fim do período', async () => {
    const plan = (id: string, key: string, provider: string, ref: string) =>
      makeTransaction({
        id,
        idempotencyKey: key,
        providerPaymentId: provider,
        reference: ref,
        items: [{ kind: 'plan', refId: 'plan-premium', amount: money(50_000, 'MZN') }],
      });
    const repo = new InMemoryPaymentsRepository();
    await repo.createTransaction(plan('tx-a', 'k1', 'pay_a', 'KPA'));
    await repo.createTransaction(plan('tx-b', 'k2', 'pay_b', 'KPB'));

    await send(repo, webhookBody('payment.success', { id: 'pay_a' }));
    const first = repo.state.subscriptions.get('user-1:plan-premium');
    assert.equal(first?.currentPeriodEnd.toISOString(), '2026-11-26T10:00:00.000Z');

    await send(repo, webhookBody('payment.success', { id: 'pay_b' }));
    const renewed = repo.state.subscriptions.get('user-1:plan-premium');
    assert.equal(renewed?.currentPeriodEnd.toISOString(), '2026-12-26T10:00:00.000Z');
    assert.equal(repo.state.sales.length, 0); // planos não têm split de parceiro
  });

  it('erro a meio faz rollback total', async () => {
    const repo = await repoWith(makeTransaction());
    const original = repo.defaultCommissionBps;
    repo.defaultCommissionBps = 20_000; // comissão inválida -> computeSplit lança erro
    await assert.rejects(() => send(repo, webhookBody('payment.success', { id: 'pay_1' })));
    repo.defaultCommissionBps = original;
    assert.equal(repo.state.transactions.get('tx-1')?.status, 'pending');
    assert.equal(repo.state.purchases.length, 0);
    assert.equal(repo.state.events.size, 0); // o reenvio ainda pode ser processado
    assert.equal((await send(repo, webhookBody('payment.success', { id: 'pay_1' }))).body.result, 'applied');
  });
});

describe('checkout', () => {
  const makeDeps = () => {
    const repo = new InMemoryPaymentsRepository();
    const provider = new FakePaymentProvider();
    let n = 0;
    return {
      repo,
      provider,
      deps: {
        repo,
        provider,
        now: () => NOW,
        newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
        // Preço do servidor: 500,00 MT por obra, 1.000,00 MT por plano.
        resolveItem: async (item: { kind: 'work' | 'plan'; refId: string }, currency: 'MZN' | 'USD' | 'EUR' | 'BRL') => ({
          amount: money(item.kind === 'plan' ? 100_000 : 50_000, currency),
          title: item.refId,
          ...(item.kind === 'work' ? { partnerId: 'partner-1' } : {}),
        }),
      },
    };
  };

  it('cria transacção com preço do servidor e envia à PaySuite', async () => {
    const { deps: d, provider, repo } = makeDeps();
    const { transaction, checkoutUrl } = await createCheckout(d, {
      userId: 'u1',
      items: [{ kind: 'work', refId: 'w1' }, { kind: 'work', refId: 'w2' }],
      currency: 'MZN',
      idempotencyKey: 'abc',
    });
    assert.equal(transaction.amount.amount, 100_000);
    assert.equal(transaction.status, 'pending');
    assert.ok(checkoutUrl?.startsWith('https://'));
    assert.equal(provider.created.length, 1);
    assert.ok(provider.created[0]!.reference.length <= 30);
    assert.equal(repo.state.transactions.get(transaction.id)?.providerPaymentId, 'fake_1');
  });

  it('mesma Idempotency-Key e mesmo pedido: não cria segundo pagamento', async () => {
    const { deps: d, provider } = makeDeps();
    const input = { userId: 'u1', items: [{ kind: 'plan' as const, refId: 'p1' }], currency: 'MZN' as const, idempotencyKey: 'k' };
    const a = await createCheckout(d, input);
    const b = await createCheckout(d, input);
    assert.equal(a.transaction.id, b.transaction.id);
    assert.equal(b.checkoutUrl, a.checkoutUrl);
    assert.equal(provider.created.length, 1);
  });

  it('mesma chave com outro pedido: conflito', async () => {
    const { deps: d } = makeDeps();
    await createCheckout(d, { userId: 'u1', items: [{ kind: 'work', refId: 'w1' }], currency: 'MZN', idempotencyKey: 'k' });
    await assert.rejects(
      () => createCheckout(d, { userId: 'u1', items: [{ kind: 'work', refId: 'w2' }], currency: 'MZN', idempotencyKey: 'k' }),
      (e: unknown) => e instanceof DomainError && e.code === 'idempotency_conflict',
    );
  });

  it('pedido vazio, sem chave ou com moeda errada: erro', async () => {
    const { deps: d } = makeDeps();
    const base = { userId: 'u1', currency: 'MZN' as const };
    await assert.rejects(() => createCheckout(d, { ...base, items: [], idempotencyKey: 'k' }));
    await assert.rejects(() => createCheckout(d, { ...base, items: [{ kind: 'work', refId: 'w' }], idempotencyKey: '' }));
    await assert.rejects(
      () => createCheckout({ ...d, resolveItem: async () => ({ amount: money(100, 'USD'), title: 't' }) }, { ...base, items: [{ kind: 'work', refId: 'w' }], idempotencyKey: 'x' }),
      (e: unknown) => e instanceof DomainError && e.code === 'currency_mismatch',
    );
  });

  it('falha da PaySuite: transacção fica «falhada» e o erro é claro', async () => {
    const { deps: d, provider, repo } = makeDeps();
    provider.failNext = true;
    await assert.rejects(
      () => createCheckout(d, { userId: 'u1', items: [{ kind: 'work', refId: 'w1' }], currency: 'MZN', idempotencyKey: 'k' }),
      (e: unknown) => e instanceof DomainError && e.code === 'provider_unavailable',
    );
    const [t] = [...repo.state.transactions.values()];
    assert.equal(t?.status, 'failed');
    assert.equal(t?.failureReason, 'provider_error');
  });
});

describe('reconciliação', () => {
  it('corrige pagamentos pendentes cujo webhook não chegou', async () => {
    const repo = await repoWith(makeTransaction());
    const provider = new FakePaymentProvider();
    provider.statuses.set('pay_1', 'paid');
    const result = await reconcilePending({ repo, provider, now: () => NOW, minAgeMs: 10 * 60_000 });
    assert.deepEqual(result, { checked: 1, changed: 1 });
    assert.equal(repo.state.transactions.get('tx-1')?.status, 'paid');
    assert.equal(repo.state.purchases.length, 1);
  });

  it('não mexe em pagamentos recentes nem ainda pendentes na PaySuite', async () => {
    const recent = makeTransaction({ createdAt: new Date(NOW.getTime() - 60_000) });
    const repo = await repoWith(recent);
    const provider = new FakePaymentProvider();
    provider.statuses.set('pay_1', 'paid');
    const r1 = await reconcilePending({ repo, provider, now: () => NOW, minAgeMs: 10 * 60_000 });
    assert.equal(r1.checked, 0);

    provider.statuses.set('pay_1', 'pending');
    const r2 = await reconcilePending({ repo, provider, now: () => NOW, minAgeMs: 0 });
    assert.deepEqual(r2, { checked: 1, changed: 0 });
  });

  it('reconciliar depois do webhook não duplica', async () => {
    const repo = await repoWith(makeTransaction());
    await send(repo, webhookBody('payment.success', { id: 'pay_1' }));
    const provider = new FakePaymentProvider();
    provider.statuses.set('pay_1', 'paid');
    await reconcilePending({ repo, provider, now: () => NOW, minAgeMs: 0 });
    assert.equal(repo.state.purchases.length, 1);
    assert.equal(repo.state.sales.length, 1);
  });
});
