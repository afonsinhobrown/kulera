import type { Money } from '../domain/money.ts';
import type { PaymentStatus, Transaction } from '../domain/types.ts';

export interface SaleRecord {
  transactionId: string;
  workId: string;
  partnerId: string;
  gross: Money;
  commission: Money;
  partnerShare: Money;
  commissionBps: number;
  reversedAt?: Date | null;
}

export interface AuditEntry {
  action: string;
  entity: string;
  entityId: string;
  data?: Record<string, unknown>;
}

export interface TransactionPatch {
  status?: PaymentStatus;
  paidAt?: Date | null;
  failureReason?: string | null;
  providerPaymentId?: string;
}

// Operações que têm de acontecer DENTRO de uma transacção de base de dados.
// Na implementação PostgreSQL: SELECT ... FOR UPDATE na transacção e restrição UNIQUE em event_key.
export interface PaymentsTx {
  recordWebhookEvent(event: { eventKey: string; eventType: string; payload: unknown }): Promise<boolean>; // true = novo
  markWebhookOutcome(eventKey: string, outcome: string): Promise<void>;
  findTransactionByProviderId(providerPaymentId: string): Promise<Transaction | null>;
  findTransactionByReference(reference: string): Promise<Transaction | null>;
  updateTransactionStatus(transactionId: string, patch: TransactionPatch): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;

  grantPurchase(args: { userId: string; workId: string; transactionId: string }): Promise<void>; // idempotente
  activateSubscription(args: { userId: string; planId: string; transactionId: string; now: Date }): Promise<void>;
  markOrderPaid(args: { orderId: string; transactionId: string }): Promise<void>;
  getCommissionBps(partnerId: string): Promise<number>;
  recordSale(sale: SaleRecord): Promise<void>;
  revokeAccess(transactionId: string, at: Date): Promise<void>;
  reverseSales(transactionId: string, at: Date): Promise<void>;
}

export interface PaymentsRepository {
  transaction<T>(fn: (tx: PaymentsTx) => Promise<T>): Promise<T>;
  findTransactionByIdempotencyKey(userId: string, key: string): Promise<Transaction | null>;
  createTransaction(transaction: Transaction): Promise<void>;
  // Só muda para «pending» se ainda estiver «created» (o webhook pode ter chegado primeiro).
  attachProviderPayment(transactionId: string, providerPaymentId: string, checkoutUrl: string): Promise<void>;
  listUnsettledBefore(cutoff: Date): Promise<Transaction[]>;
}
