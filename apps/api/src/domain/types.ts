import type { Money } from './money.ts';

export type PaymentStatus = 'created' | 'pending' | 'paid' | 'failed' | 'cancelled' | 'refunded';

export type TransactionItemKind = 'work' | 'plan' | 'order';

export interface TransactionItem {
  kind: TransactionItemKind;
  refId: string; // id da obra, do plano ou do pedido físico
  partnerId?: string; // editora/escritor dono da obra (para o split)
  amount: Money;
}

export interface Transaction {
  id: string;
  userId: string;
  reference: string; // referência enviada à PaySuite
  providerPaymentId: string | null;
  checkoutUrl: string | null;
  status: PaymentStatus;
  amount: Money;
  items: TransactionItem[];
  idempotencyKey: string;
  requestHash: string;
  paidAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
}

export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
