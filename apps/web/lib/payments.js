import { randomBytes, randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { createPayment, resolvePaysuiteToken } from './paysuite.js';
import { computeSplit } from './split.js';
import { APP_BPS, EDITORS_BPS } from './pricing.js';
import { ensureReaderSchema, topupBonus } from './reader.js';

// Em modo sandbox TODOS os pagamentos cobram 10 MT (1000 minor, = 10,00 MZN).
export const SANDBOX_AMOUNT_MINOR = 1000;

let ensured = false;
export async function ensurePaymentSchema() {
  if (ensured) return;
  try {
    await pool.query(`create table if not exists fair_settings (key text primary key, value text, updated_at timestamptz not null default now())`);
    await pool.query(`alter table fair_orders add column if not exists partner_id uuid`);
    await pool.query(`alter table fair_orders add column if not exists list_amount_minor bigint`);
    await pool.query(`alter table fair_orders add column if not exists sandbox boolean not null default false`);
    await pool.query(`alter table fair_orders add column if not exists book_id uuid`);
    await pool.query(`alter table fair_orders add column if not exists plan_id uuid`);
    await pool.query(`alter table fair_orders add column if not exists type text not null default 'book'`);
    await pool.query(`alter table fair_orders drop constraint if exists fair_orders_type_check`);
    await pool.query(`alter table fair_orders add constraint fair_orders_type_check check (type in ('book','subscription','physical','publication','topup'))`);
    await pool.query(`alter table fair_orders add column if not exists reader_id uuid`);
    await pool.query(`alter table fair_orders add column if not exists wallet_minor bigint not null default 0`);
    await pool.query(`alter table fair_orders add column if not exists shipping_name text`);
    await pool.query(`alter table fair_orders add column if not exists shipping_phone text`);
    await pool.query(`alter table fair_orders add column if not exists shipping_address text`);
    await pool.query(`alter table fair_orders add column if not exists shipping_city text`);
    await pool.query(`alter table fair_orders add column if not exists shipped_at timestamptz`);
    await pool.query(`alter table fair_orders add column if not exists device_key_hash text`);
    await pool.query(`alter table fair_orders add column if not exists device_fingerprint_hash text`);
    await pool.query(`alter table fair_orders add column if not exists device_bound_at timestamptz`);
    await pool.query(`alter table fair_orders add column if not exists access_email_sent_at timestamptz`);
    await pool.query(`alter table fair_orders add column if not exists marketing_opt_in boolean not null default false`);
    await pool.query(`create table if not exists fair_device_requests (
      id uuid primary key default gen_random_uuid(),
      order_id uuid not null references fair_orders (id) on delete cascade,
      requested_key_hash text not null,
      requested_fingerprint_hash text,
      device_info jsonb,
      status text not null default 'pending' check (status in ('pending','approved','rejected')),
      created_at timestamptz not null default now(),
      resolved_at timestamptz
    )`);
    await pool.query(`alter table fair_sales add column if not exists app_bps int not null default 2000`);
    await pool.query(`alter table fair_sales add column if not exists editors_bps int not null default 1000`);
    await pool.query(`alter table fair_sales add column if not exists app_minor bigint`);
    await pool.query(`alter table fair_sales add column if not exists editors_minor bigint`);
    await pool.query(`create table if not exists fair_publication_fees (
      order_id uuid primary key references fair_orders (id),
      book_id uuid not null references fair_books (id) on delete cascade,
      partner_id uuid references fair_partners (id),
      amount_minor bigint not null check (amount_minor > 0),
      paid_at timestamptz,
      created_at timestamptz not null default now()
    )`);
    await ensureReaderSchema(pool);
  } catch {}
  ensured = true;
}

export async function isSandbox() {
  await ensurePaymentSchema();
  const r = await pool.query("select value from fair_settings where key='sandbox'");
  if (r.rows[0]?.value !== undefined) return r.rows[0].value === 'true';
  return process.env.SANDBOX === 'true';
}

export async function setSandbox(on) {
  await ensurePaymentSchema();
  await pool.query(
    `insert into fair_settings (key,value,updated_at) values ('sandbox',$1,now())
     on conflict (key) do update set value=excluded.value, updated_at=now()`,
    [on ? 'true' : 'false'],
  );
}

export async function getPaysuiteTokenFromDb() {
  await ensurePaymentSchema();
  try {
    const r = await pool.query("select value from fair_settings where key='paysuite_token'");
    const dbTok = r.rows[0]?.value?.trim();
    if (dbTok) return dbTok;
  } catch {}
  return resolvePaysuiteToken();
}

export async function getAdminKeyFromDb() {
  await ensurePaymentSchema();
  await pool.query("insert into fair_settings (key,value,updated_at) values ('admin_key','kulera',now()) on conflict (key) do nothing");
  const r = await pool.query("select value from fair_settings where key='admin_key'");
  return r.rows[0]?.value || 'kulera';
}

/** Valor efectivamente cobrado (10 MT em sandbox). */
export async function chargeAmount(listMinor) {
  return (await isSandbox()) ? SANDBOX_AMOUNT_MINOR : Number(listMinor);
}

export function resolveSiteUrl(req) {
  // O domínio de retorno é o do próprio pedido: quem paga volta para o site onde comprou.
  // (O SITE_URL fica só como reserva — uma env mal configurada já mandou clientes para outro site.)
  const origin = req?.headers?.origin;
  if (origin && /^https?:\/\//i.test(origin)) {
    return origin.replace(/\/+$/, '');
  }
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  if (host) {
    const proto = req?.headers?.['x-forwarded-proto'] || (String(host).startsWith('localhost') ? 'http' : 'https');
    return `${proto}://${host}`.replace(/\/+$/, '');
  }
  if (process.env.SITE_URL && /^https?:\/\//i.test(process.env.SITE_URL.trim())) {
    return process.env.SITE_URL.trim().replace(/\/+$/, '');
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`.replace(/\/+$/, '');
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`.replace(/\/+$/, '');
  }
  return 'https://kulera.tecnoincubadora.org';
}

/**
 * Cria a encomenda e o pagamento PaySuite. Ponto único de entrada para TODOS os pagamentos.
 * `extra` são colunas adicionais de fair_orders (book_id, plan_id, partner_id, shipping_*).
 */
export async function startPayment({ type, listAmountMinor, currency = 'MZN', name, phone, email, description, extra = {}, req }) {
  await ensurePaymentSchema();
  const sandbox = await isSandbox();
  const amountMinor = sandbox ? SANDBOX_AMOUNT_MINOR : Number(listAmountMinor);
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const reference = `KF${id.replaceAll('-', '').slice(0, 28)}`;
  const cols = ['id', 'token', 'reference', 'buyer_name', 'buyer_phone', 'buyer_email', 'amount_minor', 'list_amount_minor', 'sandbox', 'currency', 'type', ...Object.keys(extra)];
  const vals = [id, token, reference, name, phone, email || null, amountMinor, Number(listAmountMinor), sandbox, currency, type, ...Object.values(extra)];
  await pool.query(`insert into fair_orders (${cols.join(',')}) values (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
  const site = resolveSiteUrl(req);
  const apiToken = await getPaysuiteTokenFromDb();
  try {
    const { providerPaymentId, checkoutUrl } = await createPayment({
      reference,
      amountMinor,
      description: `${sandbox ? '[SANDBOX] ' : ''}${description}`.slice(0, 120),
      returnUrl: `${site}/pagamento.html?t=${token}`,
      callbackUrl: `${site}/api/webhook`,
      apiToken,
    });
    await pool.query(
      `update fair_orders set provider_payment_id=$2, checkout_url=$3,
         status = case when status='created' then 'pending' else status end where id=$1`,
      [id, providerPaymentId, checkoutUrl],
    );
    return { ok: true, id, token, reference, checkoutUrl, amountMinor, sandbox };
  } catch (error) {
    const detail = String(error?.message || error);
    console.error('payment.error', detail);
    // Se estiver em modo Sandbox e a conta PaySuite devolver 403 (company accounts)
    // ou não tiver token configurado, permite testar o fluxo completo via simulador local em /pagamento.html.
    if (sandbox && (/company accounts|403|Token da PaySuite/i.test(detail) || process.env.SANDBOX_SIMULATE === 'true')) {
      const simId = `sim_${id.replaceAll('-', '').slice(0, 16)}`;
      const simUrl = `/pagamento.html?t=${token}&sim=1`;
      await pool.query(
        `update fair_orders set provider_payment_id=$2, checkout_url=$3,
           status = case when status='created' then 'pending' else status end where id=$1`,
        [id, simId, simUrl],
      );
      return { ok: true, id, token, reference, checkoutUrl: simUrl, amountMinor, sandbox: true, simulated: true, providerWarning: detail };
    }
    await pool.query("update fair_orders set status='failed' where id=$1 and status in ('created','pending')", [id]);
    return { ok: false, id, errorDetail: detail };
  }
}

/**
 * Liquida uma encomenda confirmada como paga (usado pelo webhook e pela verificação activa de estado).
 */
export async function settleOrderPaid(client, orderId, providerId = null) {
  const upd = await client.query(
    `update fair_orders set status = 'paid', paid_at = coalesce(paid_at, now()),
       provider_payment_id = coalesce(provider_payment_id, $2) where id = $1 and status <> 'paid'`,
    [orderId, providerId],
  );
  if (upd.rowCount !== 1) return false;

  const r = await client.query(
    `select o.book_id, o.amount_minor, o.list_amount_minor, o.wallet_minor, o.reader_id, o.plan_id, o.type, b.partner_id, b.kind, b.content_html from fair_orders o
       left join fair_books b on b.id = o.book_id where o.id = $1`,
    [orderId],
  );
  const x = r.rows[0];
  if (!x) return true;

  if (x.type === 'topup' && x.reader_id) {
    // Carregamento de saldo: credita o valor escolhido (em sandbox cobra-se pouco, mas o
    // crédito é o valor pedido — é modo de teste) e o bónus, uma única vez.
    const credited = Number(x.list_amount_minor ?? x.amount_minor);
    await client.query(
      `insert into fair_reader_ledger (reader_id, kind, amount_minor, order_id, note) values ($1,'topup',$2,$3,$4)`,
      [x.reader_id, credited, orderId, 'Carregamento de saldo'],
    );
    const bonus = topupBonus(credited);
    if (bonus > 0) {
      await client.query(
        `insert into fair_reader_ledger (reader_id, kind, amount_minor, order_id, note) values ($1,'bonus',$2,$3,$4)`,
        [x.reader_id, bonus, orderId, 'Bónus de carregamento (10%)'],
      );
    }
    return true;
  }

  if (x.type === 'publication' && x.book_id) {
    await client.query(
      `insert into fair_publication_fees (order_id, book_id, partner_id, amount_minor, paid_at)
       values ($1,$2,$3,$4,now()) on conflict (order_id) do update set paid_at = coalesce(fair_publication_fees.paid_at, now())`,
      [orderId, x.book_id, x.partner_id, x.amount_minor],
    );
    await client.query(
      `update fair_books set publication_fee_paid_at = coalesce(publication_fee_paid_at, now()),
         status = case when status = 'published' then status
                       when kind = 'physical' or content_html is not null then 'published'
                       else status end
       where id = $1`,
      [x.book_id],
    );
  } else if (x.book_id) {
    // Compra pode ter parte paga com saldo (wallet_minor) + parte na PaySuite (amount_minor).
    const gross = Number(x.amount_minor) + Number(x.wallet_minor || 0);
    const sp = computeSplit(gross, !!x.partner_id);
    const editorsBps = x.partner_id ? EDITORS_BPS : 10000 - APP_BPS;
    const commissionBps = APP_BPS + editorsBps;
    await client.query(
      `insert into fair_sales (order_id, book_id, partner_id, gross_minor, commission_bps, commission_minor, partner_minor, app_bps, editors_bps, app_minor, editors_minor)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`,
      [orderId, x.book_id, x.partner_id, gross, commissionBps, sp.app + sp.editors, sp.partner, APP_BPS, editorsBps, sp.app, sp.editors],
    );
    if (Number(x.wallet_minor || 0) > 0) {
      await client.query(
        `update fair_reader_ledger set kind='purchase', note='Compra com saldo' where order_id=$1 and kind='hold'`,
        [orderId],
      );
    }
  }

  if (x.type === 'subscription' && x.plan_id) {
    const pl = await client.query('select interval from fair_plans where id=$1', [x.plan_id]);
    const days = pl.rows[0]?.interval === 'year' ? 365 : 30;
    const buyer = await client.query(
      "select buyer_name,buyer_phone,buyer_email,(to_jsonb(fair_orders)->>'partner_id')::uuid as partner_id from fair_orders where id=$1",
      [orderId],
    );
    const b = buyer.rows[0];
    if (b) {
      await client.query('alter table fair_subscriptions add column if not exists partner_id uuid');
      const cur = b.partner_id
        ? await client.query("select max(ends_at) e from fair_subscriptions where partner_id=$1 and status='active' and ends_at>now()", [b.partner_id])
        : { rows: [] };
      const start = cur.rows[0]?.e || null;
      await client.query(
        `insert into fair_subscriptions (buyer_name,buyer_phone,buyer_email,plan_id,order_id,status,starts_at,ends_at,partner_id)
         values ($1,$2,$3,$4,$5,'active',coalesce($7::timestamptz,now()),coalesce($7::timestamptz,now())+($6)::interval,$8)
         on conflict do nothing`,
        [b.buyer_name, b.buyer_phone, b.buyer_email, x.plan_id, orderId, days + ' days', start, b.partner_id],
      );
    }
  }
  return true;
}
