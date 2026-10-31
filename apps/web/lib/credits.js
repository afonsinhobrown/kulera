import { pool } from './db.js';

// Créditos de publicação (parceiros). Pacotes definidos aqui; o Admin pode alterar os preços
// em Configurações (settings.publication_fee_minor) — os pacotes são a base de venda.
export const CREDIT_PACKS = [
  { code: 'p200', priceMinor: 20000, slots: 1, days: 10, label: '200 MT · 1 livro · 10 dias' },
  { code: 'p600', priceMinor: 60000, slots: 3, days: 15, label: '600 MT · 3 livros · 15 dias' },
  { code: 'p1000', priceMinor: 100000, slots: 3, days: 20, label: '1000 MT · 3 livros · 20 dias' },
];

export const packByCode = (code) => CREDIT_PACKS.find((p) => p.code === String(code)) || null;
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
      slots_total int not null,
      slots_used int not null default 0,
      days int not null,
      purchased_at timestamptz not null default now()
    )`);
    await p.query(`alter table fair_books add column if not exists active_until timestamptz`);
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
      `update fair_books set status = 'published',
         active_until = greatest(coalesce(active_until, now()), now()) + ($2)::int * interval '1 day'
       where id = $1`,
      [bookId, credit.days],
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
