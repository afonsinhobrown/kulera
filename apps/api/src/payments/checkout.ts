import { createHash } from 'node:crypto';
import { sumMoney } from '../domain/money.ts';
import type { CurrencyCode, Money } from '../domain/money.ts';
import { DomainError } from '../domain/types.ts';
import type { Transaction, TransactionItem } from '../domain/types.ts';
import type { PaymentProvider } from './provider.ts';
import type { PaymentsRepository } from './repository.ts';

export interface CheckoutItemInput {
  kind: 'work' | 'plan';
  refId: string;
}

export interface ResolvedItem {
  amount: Money;
  partnerId?: string;
  title: string;
}

export interface CheckoutDeps {
  repo: PaymentsRepository;
  provider: PaymentProvider;
  // Preço vem SEMPRE do servidor (catálogo). O cliente nunca envia valores.
  resolveItem: (item: CheckoutItemInput, currency: CurrencyCode) => Promise<ResolvedItem>;
  now: () => Date;
  newId: () => string;
}

export interface CheckoutInput {
  userId: string;
  items: CheckoutItemInput[];
  currency: CurrencyCode;
  idempotencyKey: string;
  returnUrl?: string;
}

const MAX_ITEMS = 20;

export async function createCheckout(
  deps: CheckoutDeps,
  input: CheckoutInput,
): Promise<{ transaction: Transaction; checkoutUrl: string | null }> {
  if (input.items.length === 0 || input.items.length > MAX_ITEMS) {
    throw new DomainError('invalid_items', `O pedido deve ter entre 1 e ${MAX_ITEMS} itens`);
  }
  if (!input.idempotencyKey || input.idempotencyKey.length > 100) {
    throw new DomainError('invalid_idempotency_key', 'Idempotency-Key em falta ou demasiado longa');
  }

  const requestHash = hashRequest(input);

  // Mesma chave + mesmo pedido = devolve a mesma transacção (sem cobrar duas vezes).
  const existing = await deps.repo.findTransactionByIdempotencyKey(input.userId, input.idempotencyKey);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new DomainError('idempotency_conflict', 'Idempotency-Key já usada com outro pedido');
    }
    return { transaction: existing, checkoutUrl: existing.checkoutUrl };
  }

  const items: TransactionItem[] = [];
  const titles: string[] = [];
  for (const item of input.items) {
    const resolved = await deps.resolveItem(item, input.currency);
    if (resolved.amount.currency !== input.currency) {
      throw new DomainError('currency_mismatch', 'O preço do item não está na moeda pedida');
    }
    if (resolved.amount.amount <= 0) {
      throw new DomainError('invalid_amount', 'O valor do item tem de ser positivo');
    }
    items.push({
      kind: item.kind,
      refId: item.refId,
      amount: resolved.amount,
      ...(resolved.partnerId ? { partnerId: resolved.partnerId } : {}),
    });
    titles.push(resolved.title);
  }

  const id = deps.newId();
  const transaction: Transaction = {
    id,
    userId: input.userId,
    // Referência curta e alfanumérica (CONFIRMAR limites com a PaySuite).
    reference: `KP${id.replaceAll('-', '').slice(0, 28)}`,
    providerPaymentId: null,
    checkoutUrl: null,
    status: 'created',
    amount: sumMoney(items.map((i) => i.amount), input.currency),
    items,
    idempotencyKey: input.idempotencyKey,
    requestHash,
    paidAt: null,
    failureReason: null,
    createdAt: deps.now(),
  };

  await deps.repo.createTransaction(transaction);

  try {
    const result = await deps.provider.createPayment({
      reference: transaction.reference,
      amount: transaction.amount,
      description: `Kulera+: ${titles.join(', ')}`.slice(0, 120),
      ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
    });
    await deps.repo.attachProviderPayment(transaction.id, result.providerPaymentId, result.checkoutUrl);
    return {
      transaction: { ...transaction, providerPaymentId: result.providerPaymentId, checkoutUrl: result.checkoutUrl, status: 'pending' },
      checkoutUrl: result.checkoutUrl,
    };
  } catch {
    await deps.repo.transaction((tx) =>
      tx.updateTransactionStatus(transaction.id, { status: 'failed', failureReason: 'provider_error' }),
    );
    throw new DomainError('provider_unavailable', 'Não foi possível iniciar o pagamento. Tente novamente.');
  }
}

function hashRequest(input: CheckoutInput): string {
  const normalised = JSON.stringify({
    currency: input.currency,
    items: [...input.items].sort((a, b) => `${a.kind}:${a.refId}`.localeCompare(`${b.kind}:${b.refId}`)),
  });
  return createHash('sha256').update(normalised).digest('hex');
}
