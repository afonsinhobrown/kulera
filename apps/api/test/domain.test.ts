import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addMonthsUtc } from '../src/domain/dates.ts';
import { canAccess } from '../src/domain/entitlements.ts';
import type { WorkAccessInfo } from '../src/domain/entitlements.ts';
import { addMoney, money, sumMoney } from '../src/domain/money.ts';
import { decideTransition, isLateConfirmation } from '../src/domain/paymentState.ts';
import { computeSplit } from '../src/domain/split.ts';

describe('money', () => {
  it('só aceita inteiros', () => {
    assert.throws(() => money(10.5, 'MZN'), RangeError);
    assert.throws(() => money(NaN, 'MZN'), RangeError);
  });
  it('não soma moedas diferentes', () => {
    assert.throws(() => addMoney(money(1, 'MZN'), money(1, 'USD')), RangeError);
  });
  it('soma itens', () => {
    assert.equal(sumMoney([money(100, 'MZN'), money(250, 'MZN')], 'MZN').amount, 350);
  });
});

describe('split', () => {
  it('comissão + parceiro = bruto, sempre', () => {
    for (const gross of [1, 3, 99, 100, 12_345, 999_999]) {
      for (const bps of [0, 1, 333, 1500, 2000, 9999, 10_000]) {
        const s = computeSplit(money(gross, 'MZN'), bps);
        assert.equal(s.commission.amount + s.partner.amount, gross);
        assert.ok(s.commission.amount >= 0 && s.partner.amount >= 0);
      }
    }
  });
  it('calcula 20% de 500,00 MT', () => {
    const s = computeSplit(money(50_000, 'MZN'), 2000);
    assert.equal(s.commission.amount, 10_000);
    assert.equal(s.partner.amount, 40_000);
  });
  it('arredonda ao mais próximo', () => {
    // 15% de 1 centavo = 0,15 -> 0 ; 50% de 1 centavo = 0,5 -> 1
    assert.equal(computeSplit(money(1, 'MZN'), 1500).commission.amount, 0);
    assert.equal(computeSplit(money(1, 'MZN'), 5000).commission.amount, 1);
  });
  it('rejeita comissões inválidas', () => {
    assert.throws(() => computeSplit(money(100, 'MZN'), -1), RangeError);
    assert.throws(() => computeSplit(money(100, 'MZN'), 10_001), RangeError);
    assert.throws(() => computeSplit(money(100, 'MZN'), 12.5), RangeError);
  });
});

describe('dates', () => {
  it('31 Jan + 1 mês = fim de Fevereiro', () => {
    assert.equal(addMonthsUtc(new Date('2026-01-31T00:00:00Z'), 1).toISOString(), '2026-02-28T00:00:00.000Z');
    assert.equal(addMonthsUtc(new Date('2028-01-31T00:00:00Z'), 1).toISOString(), '2028-02-29T00:00:00.000Z');
  });
  it('passa de Dezembro para Janeiro', () => {
    assert.equal(addMonthsUtc(new Date('2026-12-15T08:30:00Z'), 1).toISOString(), '2027-01-15T08:30:00.000Z');
  });
});

describe('estados de pagamento', () => {
  it('fluxo normal', () => {
    assert.equal(decideTransition('created', 'pending'), 'apply');
    assert.equal(decideTransition('pending', 'paid'), 'apply');
    assert.equal(decideTransition('paid', 'refunded'), 'apply');
  });
  it('nunca recua', () => {
    assert.equal(decideTransition('paid', 'pending'), 'ignore');
    assert.equal(decideTransition('paid', 'failed'), 'ignore');
    assert.equal(decideTransition('paid', 'cancelled'), 'ignore');
    assert.equal(decideTransition('refunded', 'paid'), 'ignore');
  });
  it('mesmo estado é ignorado', () => {
    assert.equal(decideTransition('paid', 'paid'), 'ignore');
  });
  it('confirmação tardia vence falhado/cancelado', () => {
    assert.equal(decideTransition('failed', 'paid'), 'apply');
    assert.equal(decideTransition('cancelled', 'paid'), 'apply');
    assert.equal(isLateConfirmation('failed', 'paid'), true);
    assert.equal(isLateConfirmation('pending', 'paid'), false);
  });
  it('reembolso só de pagamentos pagos', () => {
    assert.equal(decideTransition('pending', 'refunded'), 'reject');
    assert.equal(decideTransition('failed', 'refunded'), 'reject');
  });
});

describe('canAccess', () => {
  const now = new Date('2026-10-26T10:00:00Z');
  const work: WorkAccessInfo = { id: 'w1', kind: 'ebook', status: 'published', access: 'paid', planIds: ['plan-premium'] };
  const future = new Date('2026-11-26T10:00:00Z');
  const past = new Date('2026-10-01T10:00:00Z');

  it('livro pago sem compra nem plano: negado', () => {
    const d = canAccess({ now, work, purchases: [], subscription: null });
    assert.deepEqual(d, { allowed: false, reason: 'no_entitlement' });
  });
  it('compra permite sempre', () => {
    const d = canAccess({ now, work, purchases: [{ workId: 'w1', revokedAt: null }], subscription: null });
    assert.deepEqual(d, { allowed: true, reason: 'purchased' });
  });
  it('compra reembolsada não permite', () => {
    const d = canAccess({ now, work, purchases: [{ workId: 'w1', revokedAt: past }], subscription: null });
    assert.equal(d.allowed, false);
  });
  it('subscrição activa do plano certo permite', () => {
    const d = canAccess({ now, work, purchases: [], subscription: { planId: 'plan-premium', status: 'active', currentPeriodEnd: future } });
    assert.deepEqual(d, { allowed: true, reason: 'subscription' });
  });
  it('subscrição cancelada mantém acesso até ao fim do período', () => {
    const d = canAccess({ now, work, purchases: [], subscription: { planId: 'plan-premium', status: 'cancelled', currentPeriodEnd: future } });
    assert.equal(d.allowed, true);
  });
  it('subscrição com período terminado: negado', () => {
    const d = canAccess({ now, work, purchases: [], subscription: { planId: 'plan-premium', status: 'active', currentPeriodEnd: past } });
    assert.equal(d.allowed, false);
  });
  it('subscrição de outro plano: negado', () => {
    const d = canAccess({ now, work, purchases: [], subscription: { planId: 'plan-basic', status: 'active', currentPeriodEnd: future } });
    assert.equal(d.allowed, false);
  });
  it('subscrição pendente ou expirada: negado', () => {
    for (const status of ['pending', 'expired'] as const) {
      const d = canAccess({ now, work, purchases: [], subscription: { planId: 'plan-premium', status, currentPeriodEnd: future } });
      assert.equal(d.allowed, false);
    }
  });
  it('obra não publicada: negado, mesmo com compra', () => {
    const d = canAccess({ now, work: { ...work, status: 'suspended' }, purchases: [{ workId: 'w1', revokedAt: null }], subscription: null });
    assert.deepEqual(d, { allowed: false, reason: 'not_published' });
  });
  it('livro físico não se lê na plataforma', () => {
    const d = canAccess({ now, work: { ...work, kind: 'physical' }, purchases: [{ workId: 'w1', revokedAt: null }], subscription: null });
    assert.deepEqual(d, { allowed: false, reason: 'not_readable' });
  });
  it('conta bloqueada: negado', () => {
    const d = canAccess({ now, userBlocked: true, work: { ...work, access: 'free' }, purchases: [], subscription: null });
    assert.deepEqual(d, { allowed: false, reason: 'account_blocked' });
  });
  it('obra grátis publicada: permitido', () => {
    const d = canAccess({ now, work: { ...work, access: 'free' }, purchases: [], subscription: null });
    assert.deepEqual(d, { allowed: true, reason: 'free' });
  });
});
