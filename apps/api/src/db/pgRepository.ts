import pg from 'pg';
import { addMonthsUtc } from '../domain/dates.ts';
import { money } from '../domain/money.ts';
import type { CurrencyCode } from '../domain/money.ts';
import type { PaymentStatus, Transaction } from '../domain/types.ts';
import type {
  AuditEntry,
  PaymentsRepository,
  PaymentsTx,
  SaleRecord,
  TransactionPatch,
} from '../payments/repository.ts';

type Queryable = Pick<pg.PoolClient, 'query'>;

function toTransaction(r: Record<string, unknown>): Transaction {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    reference: r.reference as string,
    providerPaymentId: (r.provider_payment_id as string | null) ?? null,
    checkoutUrl: (r.checkout_url as string | null) ?? null,
    status: r.status as PaymentStatus,
    amount: money(Number(r.amount_minor), r.currency as CurrencyCode),
    items: r.items as Transaction['items'],
    idempotencyKey: r.idempotency_key as string,
    requestHash: r.request_hash as string,
    paidAt: (r.paid_at as Date | null) ?? null,
    failureReason: (r.failure_reason as string | null) ?? null,
    createdAt: r.created_at as Date,
  };
}

// Implementação PostgreSQL (Neon) do contrato em payments/repository.ts.
export class PgPaymentsRepository implements PaymentsRepository {
  private readonly pool: pg.Pool;
  private readonly defaultCommissionBps: number;

  constructor(pool: pg.Pool, defaultCommissionBps: number) {
    this.pool = pool;
    this.defaultCommissionBps = defaultCommissionBps;
  }

  async transaction<T>(fn: (tx: PaymentsTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgTx(client, this.defaultCommissionBps));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findTransactionByIdempotencyKey(userId: string, key: string): Promise<Transaction | null> {
    const { rows } = await this.pool.query(
      'select * from transactions where user_id = $1 and idempotency_key = $2',
      [userId, key],
    );
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  async createTransaction(t: Transaction): Promise<void> {
    await this.pool.query(
      `insert into transactions
        (id, user_id, reference, status, amount_minor, currency, items, idempotency_key, request_hash, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [t.id, t.userId, t.reference, t.status, t.amount.amount, t.amount.currency,
       JSON.stringify(t.items), t.idempotencyKey, t.requestHash, t.createdAt],
    );
  }

  async attachProviderPayment(id: string, providerPaymentId: string, checkoutUrl: string): Promise<void> {
    // Só passa a «pending» se ainda estiver «created» (o webhook pode ter chegado primeiro).
    await this.pool.query(
      `update transactions
         set provider_payment_id = $2, checkout_url = $3,
             status = case when status = 'created' then 'pending' else status end
       where id = $1`,
      [id, providerPaymentId, checkoutUrl],
    );
  }

  async listUnsettledBefore(cutoff: Date): Promise<Transaction[]> {
    const { rows } = await this.pool.query(
      `select * from transactions
        where status in ('created','pending') and provider_payment_id is not null and created_at < $1
        order by created_at limit 200`,
      [cutoff],
    );
    return rows.map(toTransaction);
  }
}

class PgTx implements PaymentsTx {
  private readonly db: Queryable;
  private readonly defaultCommissionBps: number;

  constructor(db: Queryable, defaultCommissionBps: number) {
    this.db = db;
    this.defaultCommissionBps = defaultCommissionBps;
  }

  async recordWebhookEvent(e: { eventKey: string; eventType: string; payload: unknown }): Promise<boolean> {
    const res = await this.db.query(
      `insert into payment_events (event_key, event_type, payload) values ($1,$2,$3)
       on conflict (event_key) do nothing`,
      [e.eventKey, e.eventType, JSON.stringify(e.payload)],
    );
    return res.rowCount === 1;
  }

  async markWebhookOutcome(eventKey: string, outcome: string): Promise<void> {
    await this.db.query('update payment_events set outcome = $2 where event_key = $1', [eventKey, outcome]);
  }

  // FOR UPDATE: dois webhooks do mesmo pagamento nunca correm em paralelo.
  async findTransactionByProviderId(id: string): Promise<Transaction | null> {
    const { rows } = await this.db.query('select * from transactions where provider_payment_id = $1 for update', [id]);
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  async findTransactionByReference(reference: string): Promise<Transaction | null> {
    const { rows } = await this.db.query('select * from transactions where reference = $1 for update', [reference]);
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  async updateTransactionStatus(id: string, patch: TransactionPatch): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.paidAt !== undefined) add('paid_at', patch.paidAt);
    if (patch.failureReason !== undefined) add('failure_reason', patch.failureReason);
    if (patch.providerPaymentId !== undefined) add('provider_payment_id', patch.providerPaymentId);
    if (sets.length === 0) return;
    await this.db.query(`update transactions set ${sets.join(', ')} where id = $1`, values);
  }

  async appendAudit(a: AuditEntry): Promise<void> {
    await this.db.query('insert into audit_log (action, entity, entity_id, data) values ($1,$2,$3,$4)',
      [a.action, a.entity, a.entityId, JSON.stringify(a.data ?? {})]);
  }

  async grantPurchase(a: { userId: string; workId: string; transactionId: string }): Promise<void> {
    await this.db.query(
      `insert into purchases (user_id, work_id, transaction_id) values ($1,$2,$3)
       on conflict (user_id, work_id) where revoked_at is null do nothing`,
      [a.userId, a.workId, a.transactionId],
    );
  }

  async activateSubscription(a: { userId: string; planId: string; transactionId: string; now: Date }): Promise<void> {
    const { rows } = await this.db.query(
      'select current_period_end, status from subscriptions where user_id = $1 and plan_id = $2 for update',
      [a.userId, a.planId],
    );
    const existing = rows[0] as { current_period_end: Date; status: string } | undefined;
    const running = existing && existing.status !== 'expired' && existing.current_period_end.getTime() > a.now.getTime();
    const start = running ? existing.current_period_end : a.now; // renovação prolonga o período actual
    const end = addMonthsUtc(start, 1);
    await this.db.query(
      `insert into subscriptions (user_id, plan_id, status, current_period_start, current_period_end, last_transaction_id)
       values ($1,$2,'active',$3,$4,$5)
       on conflict (user_id, plan_id) do update
         set status = 'active', current_period_start = excluded.current_period_start,
             current_period_end = excluded.current_period_end, last_transaction_id = excluded.last_transaction_id`,
      [a.userId, a.planId, start, end, a.transactionId],
    );
  }

  async markOrderPaid(a: { orderId: string; transactionId: string }): Promise<void> {
    await this.db.query(
      "update orders set status = 'paid', transaction_id = $2 where id = $1 and status = 'received'",
      [a.orderId, a.transactionId],
    );
  }

  async getCommissionBps(partnerId: string): Promise<number> {
    const { rows } = await this.db.query('select commission_bps from partners where id = $1', [partnerId]);
    const value = rows[0]?.commission_bps as number | null | undefined;
    return value ?? this.defaultCommissionBps;
  }

  async recordSale(s: SaleRecord): Promise<void> {
    await this.db.query(
      `insert into sales (transaction_id, work_id, partner_id, gross_minor, commission_bps, commission_minor, partner_minor, currency)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [s.transactionId, s.workId, s.partnerId, s.gross.amount, s.commissionBps,
       s.commission.amount, s.partnerShare.amount, s.gross.currency],
    );
  }

  async revokeAccess(transactionId: string, at: Date): Promise<void> {
    await this.db.query('update purchases set revoked_at = $2 where transaction_id = $1 and revoked_at is null', [transactionId, at]);
    await this.db.query("update subscriptions set status = 'expired', current_period_end = $2 where last_transaction_id = $1", [transactionId, at]);
  }

  async reverseSales(transactionId: string, at: Date): Promise<void> {
    await this.db.query('update sales set reversed_at = $2 where transaction_id = $1 and reversed_at is null', [transactionId, at]);
  }
}
