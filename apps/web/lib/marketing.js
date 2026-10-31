import { activePlan } from './plans.js';
import { emailConfigured, sendEmail, accessEmail, announcementEmail, SITE_BASE, unsubscribeUrl } from './email.js';

// Lista de novidades (subscritores) e promoções por email.
// Regra de frequência: cada livro pode ser promovido N vezes por mês, conforme o plano do parceiro.
export const PROMO_QUOTA = { basic: 1, pro: 2, premium: 4 };
export const KULERA_QUOTA = 4; // livros da própria Kulera (sem plano de parceiro)
export const promoQuotaForPlan = (code) => PROMO_QUOTA[String(code || '').toLowerCase()] ?? 1;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase();

let ensured = false;
export async function ensureMarketingSchema(pool) {
  if (ensured) return;
  try {
    await pool.query(`alter table fair_orders add column if not exists marketing_opt_in boolean not null default false`);
    await pool.query(`alter table fair_orders add column if not exists access_email_sent_at timestamptz`);
    await pool.query(`create table if not exists fair_subscribers (
      email text primary key,
      name text,
      phone text,
      source text,
      consent_at timestamptz not null default now(),
      unsubscribed_at timestamptz,
      last_sent_at timestamptz
    )`);
    await pool.query(`create table if not exists fair_promotions (
      id uuid primary key default gen_random_uuid(),
      book_id uuid references fair_books (id) on delete cascade,
      channel text not null default 'email',
      recipients int not null default 0,
      sent_at timestamptz not null default now()
    )`);
  } catch {}
  ensured = true;
}

export async function subscribe(pool, email, { name = null, phone = null, source = 'purchase' } = {}) {
  const clean = normalizeEmail(email);
  if (!EMAIL_RE.test(clean)) return { ok: false, error: 'invalid_email' };
  await ensureMarketingSchema(pool);
  await pool.query(
    `insert into fair_subscribers (email, name, phone, source, consent_at, unsubscribed_at)
     values ($1,$2,$3,$4,now(),null)
     on conflict (email) do update set
       name = coalesce(excluded.name, fair_subscribers.name),
       phone = coalesce(excluded.phone, fair_subscribers.phone),
       unsubscribed_at = null`,
    [clean, name || null, phone || null, source],
  );
  return { ok: true };
}

export async function unsubscribe(pool, email) {
  const clean = normalizeEmail(email);
  if (!EMAIL_RE.test(clean)) return { ok: false, error: 'invalid_email' };
  await ensureMarketingSchema(pool);
  await pool.query('update fair_subscribers set unsubscribed_at = now() where email = $1', [clean]);
  return { ok: true };
}

export async function subscriberCount(pool) {
  try {
    const r = await pool.query('select count(*)::int as n from fair_subscribers where unsubscribed_at is null');
    return Number(r.rows[0]?.n || 0);
  } catch {
    return 0;
  }
}

export async function activeSubscribers(pool, limit = 200) {
  const r = await pool.query(
    'select email from fair_subscribers where unsubscribed_at is null order by consent_at desc limit $1',
    [limit],
  );
  return r.rows.map((x) => x.email);
}

export async function promotionsThisMonth(pool, bookId) {
  const r = await pool.query(
    "select count(*)::int as n from fair_promotions where book_id = $1 and sent_at > date_trunc('month', now())",
    [bookId],
  );
  return Number(r.rows[0]?.n || 0);
}

export async function logPromotion(pool, bookId, recipients) {
  await pool.query('insert into fair_promotions (book_id, channel, recipients) values ($1,$2,$3)', [bookId, 'email', recipients]);
}

/** Envia a novidade de um livro a todos os subscritores, respeitando a quota do plano do parceiro. */
export async function announceBook(pool, bookId) {
  await ensureMarketingSchema(pool);
  const r = await pool.query(
    'select id, title, author, price_minor, currency, cover_url, partner_id, status from fair_books where id = $1',
    [bookId],
  );
  const book = r.rows[0];
  if (!book) return { ok: false, error: 'book_not_found' };
  if (book.status !== 'published') return { ok: false, error: 'book_not_published' };

  const plan = book.partner_id ? await activePlan(book.partner_id).catch(() => null) : null;
  const quota = book.partner_id ? promoQuotaForPlan(plan?.code) : KULERA_QUOTA;
  const used = await promotionsThisMonth(pool, book.id);
  if (used >= quota) {
    return { ok: false, error: 'quota_exceeded', quota, used, plan: plan?.code ?? null };
  }

  const recipients = await activeSubscribers(pool);
  if (!recipients.length) return { ok: false, error: 'no_subscribers', quota, used };

  const link = `${SITE_BASE()}/livro/${encodeURIComponent(book.id)}`;
  let sent = 0;
  let failed = 0;
  for (const email of recipients) {
    const mail = announcementEmail({
      title: book.title,
      author: book.author,
      priceMinor: book.price_minor,
      currency: book.currency,
      link,
      email,
      coverUrl: book.cover_url && /^https?:\/\//i.test(book.cover_url) ? book.cover_url : null,
    });
    const res = await sendEmail({ to: email, ...mail, replyTo: '' });
    if (res.ok) sent++;
    else failed++;
  }
  if (sent) await logPromotion(pool, book.id, sent);
  return { ok: true, sent, failed, quota, used: used + 1, plan: plan?.code ?? null, total: recipients.length };
}

/**
 * Chamado depois de um pagamento confirmado: envia o link de acesso por email (uma única vez)
 * e, se o comprador autorizou, inscreve-o nas novidades.
 */
export async function onOrderPaid(pool, orderId) {
  if (!emailConfigured()) return { skipped: 'email_not_configured' };
  try {
    await ensureMarketingSchema(pool);
    const r = await pool.query(
      `select o.buyer_email, o.buyer_name, o.buyer_phone, o.token, o.sandbox, o.access_email_sent_at,
              o.marketing_opt_in, o.type, b.title
         from fair_orders o left join fair_books b on b.id = o.book_id where o.id = $1`,
      [orderId],
    );
    const order = r.rows[0];
    if (!order || !order.buyer_email || order.access_email_sent_at) return { skipped: 'nothing_to_send' };
    if (order.type === 'physical') return { skipped: 'physical' };

    const link = `${SITE_BASE()}/ler.html?t=${order.token}`;
    const mail = accessEmail({ name: order.buyer_name, bookTitle: order.title || 'Livro', link, email: order.buyer_email });
    const res = await sendEmail({ to: order.buyer_email, ...mail });
    if (res.ok) {
      await pool.query('update fair_orders set access_email_sent_at = now() where id = $1', [orderId]);
      if (order.marketing_opt_in) {
        await subscribe(pool, order.buyer_email, {
          name: order.buyer_name,
          phone: order.buyer_phone,
          source: 'purchase',
        }).catch(() => {});
      }
    }
    return res;
  } catch (e) {
    console.error('email.order.error', e?.message || String(e));
    return { ok: false, error: String(e?.message || e) };
  }
}

export { unsubscribeUrl };
