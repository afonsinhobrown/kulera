import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { emailConfigured } from './email.js';
import { newVerifyToken, sendVerification } from './verify.js';

// Contas de leitor + carteira de saldo (pré-pago).
// Modelo: o dinheiro entra sempre pela PaySuite (carregamento). O bónus de carregamento
// é dado UMA vez (não é desconto permanente por ter saldo parado).
export const TOPUP_BONUS_BPS = 1000; // 10%
export const TOPUP_BONUS_MIN_MINOR = 100000; // a partir de 1.000 MT

const sameKey = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};
const hash = (pw, salt) => pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('hex');
export const makeHash = (pw) => {
  const s = randomBytes(16).toString('hex');
  return `pbkdf2$100000$${s}$${hash(pw, s)}`;
};
export const verifyHash = (pw, stored) => {
  const p = String(stored || '').split('$');
  if (p[0] !== 'pbkdf2' || p.length < 4) return false;
  return sameKey(hash(pw, p[2]), p[3]);
};

export const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let ensured = false;
export async function ensureReaderSchema(pool) {
  if (ensured) return;
  try {
    await pool.query(`create table if not exists fair_readers (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      email text not null unique,
      phone text,
      password_hash text not null,
      status text not null default 'active',
      created_at timestamptz not null default now()
    )`);
    await pool.query(`create table if not exists fair_reader_ledger (
      id uuid primary key default gen_random_uuid(),
      reader_id uuid not null references fair_readers (id) on delete cascade,
      kind text not null check (kind in ('topup','bonus','grant','purchase','refund','hold')),
      amount_minor bigint not null,
      order_id uuid,
      note text,
      created_at timestamptz not null default now()
    )`);
    await pool.query(`alter table fair_readers add column if not exists email_verified_at timestamptz`);
    await pool.query(`alter table fair_readers add column if not exists email_token text`);
    await pool.query(`alter table fair_readers add column if not exists email_token_expires_at timestamptz`);
    await pool.query(`create table if not exists fair_reader_sessions (
      id uuid primary key default gen_random_uuid(),
      reader_id uuid not null references fair_readers (id) on delete cascade,
      token_hash text not null unique,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      revoked_at timestamptz
    )`);
  } catch {}
  ensured = true;
}

const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex');
const SESSION_DAYS = 90;

/** Cria uma sessão privada: devolve um token aleatório; só o hash fica na base de dados. */
export async function createSession(pool, readerId) {
  await ensureReaderSchema(pool);
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `insert into fair_reader_sessions (reader_id, token_hash, expires_at)
     values ($1,$2, now() + ($3)::int * interval '1 day')`,
    [readerId, sha256(token), SESSION_DAYS],
  );
  return token;
}

/** Resolve o leitor a partir do token de sessão (só ele vê o saldo e os pagamentos). */
export async function getReaderBySession(pool, token) {
  const clean = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(clean)) return null;
  await ensureReaderSchema(pool);
  const r = await pool.query(
    `select r.id, r.name, r.email, r.phone, r.status
       from fair_reader_sessions s join fair_readers r on r.id = s.reader_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and r.status = 'active'
      limit 1`,
    [sha256(clean)],
  );
  return r.rows[0] || null;
}

export async function revokeSession(pool, token) {
  const clean = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(clean)) return { ok: true };
  await ensureReaderSchema(pool);
  await pool.query('update fair_reader_sessions set revoked_at = now() where token_hash = $1', [sha256(clean)]);
  return { ok: true };
}

export const topupBonus = (amountMinor) =>
  Number(amountMinor) >= TOPUP_BONUS_MIN_MINOR ? Math.round((Number(amountMinor) * TOPUP_BONUS_BPS) / 10000) : 0;

export async function registerReader(pool, { name, email, phone, password }) {
  const cleanName = String(name ?? '').trim().slice(0, 80);
  const cleanEmail = normalizeEmail(email).slice(0, 120);
  const cleanPhone = String(phone ?? '').replace(/[^\d]/g, '').slice(0, 15);
  const pass = String(password ?? '');
  if (cleanName.length < 2) return { ok: false, error: 'invalid_name' };
  if (!EMAIL_RE.test(cleanEmail)) return { ok: false, error: 'invalid_email' };
  if (pass.length < 6) return { ok: false, error: 'weak_password' };
  await ensureReaderSchema(pool);
  const dup = await pool.query('select id from fair_readers where lower(email) = $1 limit 1', [cleanEmail]);
  if (dup.rows.length) return { ok: false, error: 'exists' };

  // A conta só fica activa depois de confirmar o email (se o envio estiver configurado).
  const configured = emailConfigured();
  const verifyToken = configured ? newVerifyToken() : null;
  const r = await pool.query(
    `insert into fair_readers (name, email, phone, password_hash, email_token, email_token_expires_at, email_verified_at)
     values ($1,$2,$3,$4,$5, now() + interval '24 hours', $6)
     returning id, name, email, phone, status`,
    [cleanName, cleanEmail, cleanPhone || null, makeHash(pass), verifyToken, configured ? null : new Date()],
  );
  const reader = r.rows[0];
  let mail = { ok: true };
  if (configured) {
    mail = await sendVerification({ to: cleanEmail, name: cleanName, token: verifyToken, kind: 'reader' });
    if (!mail.ok) {
      // Não deixar a conta presa: se o email falhar, fica verificada e o login funciona.
      await pool.query('update fair_readers set email_verified_at = now(), email_token = null where id = $1', [reader.id]);
    }
  }
  return { ok: true, reader, pending: configured && mail.ok, emailSent: Boolean(mail.ok) };
}

export async function loginReader(pool, { email, password }) {
  const cleanEmail = normalizeEmail(email);
  await ensureReaderSchema(pool);
  const r = await pool.query(
    'select id, name, email, phone, status, password_hash, email_verified_at, email_token from fair_readers where lower(email) = $1 limit 1',
    [cleanEmail],
  );
  const reader = r.rows[0];
  if (!reader || reader.status !== 'active' || !verifyHash(password, reader.password_hash)) {
    return { ok: false, error: 'unauthorized' };
  }
  if (reader.email_token && !reader.email_verified_at) return { ok: false, error: 'unverified' };
  const { password_hash, email_token, ...safe } = reader;
  const session = await createSession(pool, reader.id);
  return { ok: true, reader: safe, token: session };
}

/** Reenvia o link de confirmação (só se ainda estiver pendente). Resposta sempre neutra. */
export async function resendReaderVerification(pool, email) {
  const cleanEmail = normalizeEmail(email);
  if (!EMAIL_RE.test(cleanEmail)) return { ok: true };
  await ensureReaderSchema(pool);
  const r = await pool.query(
    'select id, name, email, email_token, email_verified_at from fair_readers where lower(email) = $1 limit 1',
    [cleanEmail],
  );
  const reader = r.rows[0];
  if (!reader || !reader.email_token || reader.email_verified_at) return { ok: true };
  const token = newVerifyToken();
  await pool.query("update fair_readers set email_token = $2, email_token_expires_at = now() + interval '24 hours' where id = $1", [reader.id, token]);
  await sendVerification({ to: reader.email, name: reader.name, token, kind: 'reader' });
  return { ok: true };
}

/** Devolve ao saldo a reserva de uma compra que falhou/foi cancelada. */
export async function releaseHold(pool, orderId) {
  try {
    await ensureReaderSchema(pool);
    const r = await pool.query("select reader_id, amount_minor from fair_reader_ledger where order_id = $1 and kind = 'hold'", [orderId]);
    for (const h of r.rows) {
      await pool.query("delete from fair_reader_ledger where order_id = $1 and kind = 'hold'", [orderId]);
      await pool.query(
        "insert into fair_reader_ledger (reader_id, kind, amount_minor, order_id, note) values ($1,'refund',$2,$3,$4)",
        [h.reader_id, Math.abs(Number(h.amount_minor)), orderId, 'Reserva devolvida'],
      );
    }
  } catch {}
}

export async function getReader(pool, id) {
  const r = await pool.query('select id, name, email, phone, status from fair_readers where id = $1', [id]);
  const reader = r.rows[0];
  return reader && reader.status === 'active' ? reader : null;
}

export async function readerBalance(pool, readerId) {
  const r = await pool.query('select coalesce(sum(amount_minor),0)::bigint as balance from fair_reader_ledger where reader_id = $1', [readerId]);
  return Number(r.rows[0]?.balance || 0);
}

export async function readerLedger(pool, readerId, limit = 100) {
  const r = await pool.query(
    'select kind, amount_minor, note, order_id, created_at from fair_reader_ledger where reader_id = $1 order by created_at desc limit $2',
    [readerId, limit],
  );
  return r.rows.map((x) => ({ ...x, amount_minor: Number(x.amount_minor) }));
}

export async function grantCredit(pool, { readerId, amountMinor, note, kind = 'grant' }) {
  await ensureReaderSchema(pool);
  const amount = Math.round(Number(amountMinor));
  if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) return { ok: false, error: 'invalid_amount' };
  await pool.query(
    'insert into fair_reader_ledger (reader_id, kind, amount_minor, note) values ($1,$2,$3,$4)',
    [readerId, kind === 'bonus' ? 'bonus' : 'grant', amount, String(note ?? '').slice(0, 200) || 'Crédito atribuído pela Kulera'],
  );
  return { ok: true, balance: await readerBalance(pool, readerId) };
}
