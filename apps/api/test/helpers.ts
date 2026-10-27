import { createHmac } from 'node:crypto';
import { money } from '../src/domain/money.ts';
import type { Transaction } from '../src/domain/types.ts';
import { InMemoryPaymentsRepository } from '../src/payments/memoryRepository.ts';

export const SECRET = 'test-secret';
export const NOW = new Date('2026-10-26T10:00:00.000Z');

export function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function webhookBody(event: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ event, data: fields });
}

export function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    userId: 'user-1',
    reference: 'KPREF1',
    providerPaymentId: 'pay_1',
    checkoutUrl: 'https://pay.example.test/1',
    status: 'pending',
    amount: money(50_000, 'MZN'),
    items: [{ kind: 'work', refId: 'work-1', partnerId: 'partner-1', amount: money(50_000, 'MZN') }],
    idempotencyKey: 'key-1',
    requestHash: 'hash-1',
    paidAt: null,
    failureReason: null,
    createdAt: new Date('2026-10-26T09:00:00.000Z'),
    ...overrides,
  };
}

export async function repoWith(transaction: Transaction): Promise<InMemoryPaymentsRepository> {
  const repo = new InMemoryPaymentsRepository();
  await repo.createTransaction(transaction);
  return repo;
}
