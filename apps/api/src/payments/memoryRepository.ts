import { addMonthsUtc } from '../domain/dates.ts';
import type { Transaction } from '../domain/types.ts';
import type {
  AuditEntry,
  PaymentsRepository,
  PaymentsTx,
  SaleRecord,
  TransactionPatch,
} from './repository.ts';

interface PurchaseRow {
  userId: string;
  workId: string;
  transactionId: string;
  revokedAt: Date | null;
}

interface SubscriptionRow {
  userId: string;
  planId: string;
  status: 'active' | 'cancelled' | 'expired';
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  lastTransactionId: string;
}

interface EventRow {
  eventType: string;
  payload: unknown;
  outcome: string | null;
}

interface State {
  transactions: Map<string, Transaction>;
  events: Map<string, EventRow>;
  purchases: PurchaseRow[];
  subscriptions: Map<string, SubscriptionRow>;
  paidOrders: Set<string>;
  sales: SaleRecord[];
  audit: AuditEntry[];
  commissions: Map<string, number>;
}

function emptyState(): State {
  return {
    transactions: new Map(),
    events: new Map(),
    purchases: [],
    subscriptions: new Map(),
    paidOrders: new Set(),
    sales: [],
    audit: [],
    commissions: new Map(),
  };
}

// Repositório em memória: serve testes e desenvolvimento local. NÃO usar em produção.
// A versão PostgreSQL tem de respeitar o mesmo contrato (repository.ts).
export class InMemoryPaymentsRepository implements PaymentsRepository {
  state: State = emptyState();
  // Valor de teste. A comissão real é definida pela Kulera (ERS, RN-04).
  defaultCommissionBps = 2000;

  async transaction<T>(fn: (tx: PaymentsTx) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await fn(new InMemoryTx(this));
    } catch (error) {
      this.state = snapshot; // rollback
      throw error;
    }
  }

  async findTransactionByIdempotencyKey(userId: string, key: string): Promise<Transaction | null> {
    for (const t of this.state.transactions.values()) {
      if (t.userId === userId && t.idempotencyKey === key) return structuredClone(t);
    }
    return null;
  }

  async createTransaction(transaction: Transaction): Promise<void> {
    this.state.transactions.set(transaction.id, structuredClone(transaction));
  }

  async attachProviderPayment(
    transactionId: string,
    providerPaymentId: string,
    checkoutUrl: string,
  ): Promise<void> {
    const t = this.state.transactions.get(transactionId);
    if (!t) throw new Error('Transacção não encontrada');
    t.providerPaymentId = providerPaymentId;
    t.checkoutUrl = checkoutUrl;
    if (t.status === 'created') t.status = 'pending';
  }

  async listUnsettledBefore(cutoff: Date): Promise<Transaction[]> {
    return [...this.state.transactions.values()]
      .filter(
        (t) =>
          (t.status === 'created' || t.status === 'pending') &&
          t.providerPaymentId !== null &&
          t.createdAt.getTime() < cutoff.getTime(),
      )
      .map((t) => structuredClone(t));
  }
}

class InMemoryTx implements PaymentsTx {
  private readonly repo: InMemoryPaymentsRepository;

  constructor(repo: InMemoryPaymentsRepository) {
    this.repo = repo;
  }

  private get state(): State {
    return this.repo.state;
  }

  async recordWebhookEvent(event: { eventKey: string; eventType: string; payload: unknown }): Promise<boolean> {
    if (this.state.events.has(event.eventKey)) return false;
    this.state.events.set(event.eventKey, {
      eventType: event.eventType,
      payload: event.payload,
      outcome: null,
    });
    return true;
  }

  async markWebhookOutcome(eventKey: string, outcome: string): Promise<void> {
    const row = this.state.events.get(eventKey);
    if (row) row.outcome = outcome;
  }

  async findTransactionByProviderId(providerPaymentId: string): Promise<Transaction | null> {
    for (const t of this.state.transactions.values()) {
      if (t.providerPaymentId === providerPaymentId) return structuredClone(t);
    }
    return null;
  }

  async findTransactionByReference(reference: string): Promise<Transaction | null> {
    for (const t of this.state.transactions.values()) {
      if (t.reference === reference) return structuredClone(t);
    }
    return null;
  }

  async updateTransactionStatus(transactionId: string, patch: TransactionPatch): Promise<void> {
    const t = this.state.transactions.get(transactionId);
    if (!t) throw new Error('Transacção não encontrada');
    if (patch.status !== undefined) t.status = patch.status;
    if (patch.paidAt !== undefined) t.paidAt = patch.paidAt;
    if (patch.failureReason !== undefined) t.failureReason = patch.failureReason;
    if (patch.providerPaymentId !== undefined) t.providerPaymentId = patch.providerPaymentId;
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.state.audit.push(entry);
  }

  async grantPurchase(args: { userId: string; workId: string; transactionId: string }): Promise<void> {
    const exists = this.state.purchases.some(
      (p) => p.userId === args.userId && p.workId === args.workId && p.revokedAt === null,
    );
    if (exists) return; // idempotente
    this.state.purchases.push({ ...args, revokedAt: null });
  }

  async activateSubscription(args: {
    userId: string;
    planId: string;
    transactionId: string;
    now: Date;
  }): Promise<void> {
    const key = `${args.userId}:${args.planId}`;
    const existing = this.state.subscriptions.get(key);
    const stillRunning =
      existing !== undefined &&
      existing.status !== 'expired' &&
      existing.currentPeriodEnd.getTime() > args.now.getTime();

    if (existing && stillRunning) {
      // Renovação: prolonga a partir do fim do período actual.
      existing.currentPeriodStart = existing.currentPeriodEnd;
      existing.currentPeriodEnd = addMonthsUtc(existing.currentPeriodEnd, 1);
      existing.status = 'active';
      existing.lastTransactionId = args.transactionId;
      return;
    }
    this.state.subscriptions.set(key, {
      userId: args.userId,
      planId: args.planId,
      status: 'active',
      currentPeriodStart: args.now,
      currentPeriodEnd: addMonthsUtc(args.now, 1),
      lastTransactionId: args.transactionId,
    });
  }

  async markOrderPaid(args: { orderId: string; transactionId: string }): Promise<void> {
    this.state.paidOrders.add(args.orderId);
  }

  async getCommissionBps(partnerId: string): Promise<number> {
    return this.state.commissions.get(partnerId) ?? this.repo.defaultCommissionBps;
  }

  async recordSale(sale: SaleRecord): Promise<void> {
    this.state.sales.push({ ...sale, reversedAt: null });
  }

  async revokeAccess(transactionId: string, at: Date): Promise<void> {
    for (const p of this.state.purchases) {
      if (p.transactionId === transactionId && p.revokedAt === null) p.revokedAt = at;
    }
    for (const s of this.state.subscriptions.values()) {
      if (s.lastTransactionId === transactionId) {
        s.status = 'expired';
        s.currentPeriodEnd = at;
      }
    }
  }

  async reverseSales(transactionId: string, at: Date): Promise<void> {
    for (const sale of this.state.sales) {
      if (sale.transactionId === transactionId && !sale.reversedAt) sale.reversedAt = at;
    }
  }
}
