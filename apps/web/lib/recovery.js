import { createHash } from 'node:crypto';
import { isSandbox } from './payments.js';

const MAX_FAILED_ATTEMPTS = 8;
const WINDOW_MINUTES = 15;

const normalizePhone = (v) => {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.startsWith('258') && digits.length > 9 ? digits.slice(3) : digits;
};

const normalizeName = (v) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const words = (v) => normalizeName(v).split(' ').filter(Boolean);

const isPrefix = (a, b) => a.length <= b.length && a.every((w, i) => w === b[i]);

const nameMatches = (typed, stored) => {
  const a = words(typed);
  const b = words(stored);
  if (!a.length || !b.length) return false;
  return isPrefix(a, b) || isPrefix(b, a);
};

const hash = (v) => createHash('sha256').update(String(v ?? '')).digest('hex');

let schemaReady;
const ensureSchema = async (pool) => {
  schemaReady ??= pool
    .query(
      `create table if not exists fair_recovery_attempts (
         id bigserial primary key,
         phone_hash text not null,
         ip_hash text not null,
         ok boolean not null default false,
         created_at timestamptz not null default now()
       )`,
    )
    .catch(() => {});
  await schemaReady;
};

async function rateLimited(pool, phoneHash, ipHash) {
  try {
    await ensureSchema(pool);
    const r = await pool.query(
      `select count(*)::int as n from fair_recovery_attempts
        where ok = false and created_at > now() - ($1 || ' minutes')::interval
          and (phone_hash = $2 or ip_hash = $3)`,
      [WINDOW_MINUTES, phoneHash, ipHash],
    );
    return Number(r.rows[0]?.n || 0) >= MAX_FAILED_ATTEMPTS;
  } catch {
    return false;
  }
}

async function recordAttempt(pool, phoneHash, ipHash, ok) {
  try {
    await ensureSchema(pool);
    await pool.query('insert into fair_recovery_attempts (phone_hash, ip_hash, ok) values ($1,$2,$3)', [phoneHash, ipHash, ok]);
  } catch {}
}

const ORDER_SQL = `select o.token, o.buyer_name, o.paid_at, o.created_at, o.sandbox, coalesce(b.title, 'Livro') as title
                      from fair_orders o
                      left join fair_books b on b.id = o.book_id
                     where o.buyer_phone = $1
                       and o.status = 'paid'
                       and coalesce(o.type, 'book') = 'book'
                     order by coalesce(o.paid_at, o.created_at) desc
                     limit 30`;

export async function recoverAccess({ pool, phone, name, ip }) {
  const cleanPhone = normalizePhone(phone);
  const cleanName = String(name ?? '').trim().slice(0, 80);
  if (!/^\d{9,15}$/.test(cleanPhone)) return { status: 400, body: { error: 'invalid_phone' } };
  if (normalizeName(cleanName).length < 2) return { status: 400, body: { error: 'invalid_name' } };

  const phoneHash = hash(cleanPhone);
  const ipHash = hash(ip);
  if (await rateLimited(pool, phoneHash, ipHash)) {
    return { status: 429, body: { error: 'too_many_attempts' } };
  }

  const sandboxOn = await isSandbox().catch(() => false);
  let rows = [];
  try {
    const r = await pool.query(ORDER_SQL, [cleanPhone]);
    rows = r.rows;
  } catch {
    const r = await pool.query(
      `select o.token, o.buyer_name, o.paid_at, o.created_at, o.sandbox, coalesce(b.title, 'Livro') as title
         from fair_orders o
         left join fair_books b on b.id = o.book_id
        where o.buyer_phone = $1 and o.status = 'paid'
        order by coalesce(o.paid_at, o.created_at) desc
        limit 30`,
      [cleanPhone],
    );
    rows = r.rows;
  }

  const matches = rows.filter(
    (o) =>
      /^[a-f0-9]{64}$/.test(String(o.token || '')) &&
      (sandboxOn || !o.sandbox) &&
      nameMatches(cleanName, o.buyer_name),
  );

  await recordAttempt(pool, phoneHash, ipHash, matches.length > 0);

  if (!matches.length) return { status: 404, body: { error: 'not_found' } };

  const seen = new Set();
  const books = [];
  for (const o of matches) {
    const title = String(o.title || 'Livro');
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    books.push({
      title,
      paidAt: o.paid_at || o.created_at || null,
      url: `/ler.html?t=${o.token}`,
    });
  }

  return { status: 200, body: { ok: true, books } };
}
