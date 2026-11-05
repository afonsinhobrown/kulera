import { pool } from './db.js';

// Créditos de publicação temporária (Revisão V3).
// O prazo conta a partir da activação do livro (dias activos), não da compra.
export const CREDIT_PACKS = [
  { code: 'bronze', name: 'Bronze', priceMinor: 20000, slots: 1, days: 10, label: 'Bronze · 200 MT · 1 livro · 10 dias' },
  { code: 'prata', name: 'Prata', priceMinor: 60000, slots: 2, days: 15, label: 'Prata · 600 MT · 2 livros · 15 dias' },
  { code: 'ouro', name: 'Ouro', priceMinor: 100000, slots: 5, days: 20, label: 'Ouro · 1.000 MT · 5 livros · 20 dias' },
];

// Códigos antigos (compras já registadas) continuam a ser reconhecidos.
const LEGACY_PACKS = { p200: 'bronze', p600: 'prata', p1000: 'ouro' };

export const packByCode = (code) => {
  const key = LEGACY_PACKS[String(code)] || String(code);
  return CREDIT_PACKS.find((p) => p.code === key) || null;
};
export const packByPrice = (amountMinor) =>
  CREDIT_PACKS.find((p) => p.priceMinor === Number(amountMinor)) || null;

let ensured = false;
export async function ensureCreditSchema(p = pool) {
  if (ensured) return;
  try {
    await p.query(`create table if not exists fair_partner_credits (
      id uuid primary key default gen_random_uuid(),
      partner_id uuid not null references fair_partners (id) on delete cascade,
      pack text not null,
      price_minor bigint not null,
      gateway_minor bigint not null default 0,
      net_minor bigint,
      slots_total int not null,
      slots_used int not null default 0,
      days int not null,
      purchased_at timestamptz not null default now()
    )`);
    await p.query(`alter table fair_partner_credits add column if not exists gateway_minor bigint not null default 0`);
    await p.query(`alter table fair_partner_credits add column if not exists net_minor bigint`);
    await p.query(`alter table fair_books add column if not exists active_until timestamptz`);
    await p.query(`alter table fair_books add column if not exists suspended_at timestamptz`);
    await p.query(`alter table fair_books add column if not exists suspended_reason text`);
    await p.query(`alter table fair_books add column if not exists warning_72h_sent_at timestamptz`);
    await p.query(`alter table fair_books add column if not exists warning_24h_sent_at timestamptz`);
    await p.query(`create table if not exists fair_book_status_events (
      id bigserial primary key,
      book_id uuid not null references fair_books (id) on delete cascade,
      from_status text,
      to_status text not null,
      reason text,
      created_at timestamptz not null default now()
    )`);
  } catch {}
  ensured = true;
}

/** Crédito com vagas livres, mais antigo primeiro. */
export async function availableCredit(p = pool, partnerId) {
  const r = await p.query(
    `select id, pack, slots_total, slots_used, days, purchased_at
       from fair_partner_credits
      where partner_id = $1 and slots_used < slots_total
      order by purchased_at asc limit 1`,
    [partnerId],
  );
  const c = r.rows[0];
  return c ? { ...c, remaining: Number(c.slots_total) - Number(c.slots_used) } : null;
}

/** Activa (ou reactiva) um livro do parceiro usando uma vaga de crédito. */
export async function activateBook(p, partnerId, bookId) {
  await ensureCreditSchema(p);
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const book = (await client.query(
      'select id, status, content_html, kind, publication_fee_minor, publication_fee_paid_at from fair_books where id = $1 and partner_id = $2 for update',
      [bookId, partnerId],
    )).rows[0];
    if (!book) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'book_not_found' };
    }
    if (Number(book.publication_fee_minor || 0) > 0 && !book.publication_fee_paid_at) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'fee_pending' };
    }
    const credit = (await client.query(
      `select id, days, slots_total, slots_used from fair_partner_credits
        where partner_id = $1 and slots_used < slots_total
        order by purchased_at asc limit 1 for update`,
      [partnerId],
    )).rows[0];
    if (!credit) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'no_credits' };
    }
    await client.query('update fair_partner_credits set slots_used = slots_used + 1 where id = $1', [credit.id]);
    await client.query(
      `update fair_books set status = 'published', suspended_at = null, suspended_reason = null,
         warning_72h_sent_at = null, warning_24h_sent_at = null,
         active_until = greatest(coalesce(active_until, now()), now()) + ($2)::int * interval '1 day'
       where id = $1`,
      [bookId, credit.days],
    );
    await client.query(
      `insert into fair_book_status_events (book_id, from_status, to_status, reason)
       values ($1,$2,'published','credit_activated')`,
      [bookId, book.status],
    );
    await client.query('COMMIT');
    return { ok: true, days: credit.days };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: String(e?.message || e) };
  } finally {
    client.release();
  }
}

/**
 * Expira créditos vencidos: passa os livros a SUSPENSO sem apagar ficheiros nem histórico.
 * Um livro coberto por assinatura activa (ou em tolerância) não é suspenso.
 */
export async function expireCredits(p = pool, now = new Date()) {
  await ensureCreditSchema(p);
  const r = await p.query(
    `with expired as (
       update fair_books b
          set status = 'suspended', suspended_at = $1, suspended_reason = 'credit_expired', updated_at = now()
        where b.partner_id is not null
          and b.status = 'published'
          and b.active_until is not null
          and b.active_until <= $1
          and not exists (
            select 1 from fair_subscriptions s
             where s.partner_id = b.partner_id
               and (
                 (s.status = 'active' and s.ends_at > $1)
                 or (s.status = 'past_due'
                     and coalesce(s.grace_ends_at, s.ends_at + interval '3 days') > $1)
               )
          )
        returning b.id
     ), logged as (
       insert into fair_book_status_events (book_id, from_status, to_status, reason, created_at)
       select id, 'published', 'suspended', 'credit_expired', $1 from expired
       returning book_id
     )
     select count(*)::int as n from expired`,
    [now],
  );
  return { suspended: Number(r.rows[0]?.n || 0) };
}
