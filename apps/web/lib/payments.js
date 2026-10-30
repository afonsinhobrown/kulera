import { randomBytes, randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { createPayment } from './paysuite.js';

// Em modo sandbox TODOS os pagamentos cobram 10 MT.
export const SANDBOX_AMOUNT_MINOR = 1000;

let ensured = false;
export async function ensurePaymentSchema() {
  if (ensured) return;
  await pool.query(`create table if not exists fair_settings (key text primary key, value text, updated_at timestamptz not null default now())`);
  await pool.query(`alter table fair_orders add column if not exists partner_id uuid`);
  await pool.query(`alter table fair_orders add column if not exists list_amount_minor bigint`);
  await pool.query(`alter table fair_orders add column if not exists sandbox boolean not null default false`);
  ensured = true;
}

export async function isSandbox() {
  await ensurePaymentSchema();
  const r = await pool.query("select value from fair_settings where key='sandbox'");
  return r.rows[0]?.value === 'true';
}

export async function setSandbox(on) {
  await ensurePaymentSchema();
  await pool.query(
    `insert into fair_settings (key,value,updated_at) values ('sandbox',$1,now())
     on conflict (key) do update set value=excluded.value, updated_at=now()`, [on ? 'true' : 'false']);
}

/** Valor efectivamente cobrado (10 MT em sandbox). */
export async function chargeAmount(listMinor) {
  return (await isSandbox()) ? SANDBOX_AMOUNT_MINOR : Number(listMinor);
}

/**
 * Cria a encomenda e o pagamento PaySuite. Ponto único de entrada para TODOS os pagamentos.
 * `extra` são colunas adicionais de fair_orders (book_id, plan_id, partner_id, shipping_*).
 */
export async function startPayment({ type, listAmountMinor, currency = 'MZN', name, phone, email, description, extra = {} }) {
  await ensurePaymentSchema();
  const sandbox = await isSandbox();
  const amountMinor = sandbox ? SANDBOX_AMOUNT_MINOR : Number(listAmountMinor);
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const reference = `KF${id.replaceAll('-', '').slice(0, 28)}`;
  const cols = ['id', 'token', 'reference', 'buyer_name', 'buyer_phone', 'buyer_email', 'amount_minor', 'list_amount_minor', 'sandbox', 'currency', 'type', ...Object.keys(extra)];
  const vals = [id, token, reference, name, phone, email || null, amountMinor, Number(listAmountMinor), sandbox, currency, type, ...Object.values(extra)];
  await pool.query(`insert into fair_orders (${cols.join(',')}) values (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
  const site = process.env.SITE_URL;
  try {
    const { providerPaymentId, checkoutUrl } = await createPayment({
      reference, amountMinor, description: `${sandbox ? '[SANDBOX] ' : ''}${description}`.slice(0, 120),
      returnUrl: `${site}/pagamento.html?t=${token}`, callbackUrl: `${site}/api/webhook`,
    });
    await pool.query(
      `update fair_orders set provider_payment_id=$2, checkout_url=$3,
         status = case when status='created' then 'pending' else status end where id=$1`, [id, providerPaymentId, checkoutUrl]);
    return { ok: true, id, token, reference, checkoutUrl, amountMinor, sandbox };
  } catch (error) {
    console.error('payment.error', String(error));
    await pool.query("update fair_orders set status='failed' where id=$1 and status in ('created','pending')", [id]);
    return { ok: false, id };
  }
}
