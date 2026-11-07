// Autenticação dos administradores da plataforma.
//
// Passam a existir dois utilizadores fixos — `tecnoincubadora` e `kulera` — em vez da
// chave única partilhada (fair_settings.admin_key). As senhas nunca são guardadas em
// texto: só o hash pbkdf2 com sal, no mesmo formato já usado pelos parceiros.
// As sessões vivem num cookie httpOnly; na base de dados fica apenas o hash do token.

import { createHash, randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

const ITERATIONS = 100000;
const KEY_LEN = 32;
const DIGEST = 'sha256';

export const COOKIE_NAME = 'kadm';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'kulera-admin';
export const MIN_PASSWORD_LENGTH = 8;

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 horas
export const MAX_FAILS = 8; // tentativas falhadas
export const LOCK_WINDOW_MS = 15 * 60 * 1000; // por janela de 15 minutos

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

/** Hash da senha: `pbkdf2$iterações$sal$hash`. Nunca se guarda a senha original. */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(String(password), salt, ITERATIONS, KEY_LEN, DIGEST).toString('hex');
  return `pbkdf2$${ITERATIONS}$${salt}$${hash}`;
}

/** Compara em tempo constante (não deixa adivinhar a senha pelo tempo de resposta). */
export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  let expected;
  try {
    expected = Buffer.from(parts[3], 'hex');
  } catch {
    return false;
  }
  if (!expected.length) return false;
  const got = pbkdf2Sync(String(password), parts[2], iterations, expected.length, DIGEST);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export const hashIp = (ip) => sha256(`ip:${String(ip || '')}`);

/** Cria as tabelas do painel (idempotente). Não cria utilizadores nem senhas. */
export async function ensureAdminSchema(pool) {
  await pool.query(`create table if not exists fair_admin_users (
    id uuid primary key default gen_random_uuid(),
    username text not null unique,
    password_hash text not null,
    role text not null check (role in ('tecnoincubadora','kulera')),
    display_name text not null,
    can_change_password boolean not null default true,
    status text not null default 'active' check (status in ('active','suspended')),
    last_login_at timestamptz,
    created_at timestamptz not null default now()
  )`);
  await pool.query(`create table if not exists fair_admin_sessions (
    token_hash text primary key,
    user_id uuid not null references fair_admin_users (id) on delete cascade,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
  )`);
  await pool.query(`create table if not exists fair_admin_bank (
    user_id uuid primary key references fair_admin_users (id) on delete cascade,
    holder text,
    bank_name text,
    account_number text,
    nib text,
    wallet text,
    updated_at timestamptz not null default now()
  )`);
  await pool.query(`create table if not exists fair_admin_bank_changes (
    id bigserial primary key,
    user_id uuid not null references fair_admin_users (id) on delete cascade,
    before jsonb,
    after jsonb,
    ip_hash text,
    created_at timestamptz not null default now()
  )`);
  await pool.query(`create table if not exists fair_admin_login_attempts (
    id bigserial primary key,
    username text not null,
    ip_hash text not null,
    ok boolean not null default false,
    created_at timestamptz not null default now()
  )`);
}

export async function findUser(pool, username) {
  const r = await pool.query(
    `select id, username, password_hash, role, display_name, can_change_password, status
       from fair_admin_users where username = $1`,
    [String(username ?? '').trim().toLowerCase()],
  );
  return r.rows[0] ?? null;
}

export async function countAdmins(pool) {
  const r = await pool.query('select count(*)::int as n from fair_admin_users');
  return Number(r.rows[0]?.n ?? 0);
}

/** Cria ou actualiza um administrador. Só o script de seed chama isto. */
export async function upsertAdmin(pool, { username, password, role, displayName, canChangePassword = true }) {
  if (!['tecnoincubadora', 'kulera'].includes(role)) throw new Error('role inválido');
  const name = String(username).trim().toLowerCase();
  const existing = await findUser(pool, name);
  const hash = hashPassword(password);
  if (existing) {
    await pool.query(
      `update fair_admin_users
          set password_hash = $2, role = $3, display_name = $4, can_change_password = $5, status = 'active'
        where username = $1`,
      [name, hash, role, displayName, canChangePassword],
    );
    return { created: false };
  }
  await pool.query(
    `insert into fair_admin_users (username, password_hash, role, display_name, can_change_password)
     values ($1, $2, $3, $4, $5)`,
    [name, hash, role, displayName, canChangePassword],
  );
  return { created: true };
}

export async function recentFailures(pool, username, ip) {
  const since = new Date(Date.now() - LOCK_WINDOW_MS);
  const r = await pool.query(
    `select count(*)::int as n from fair_admin_login_attempts
      where ok = false and username = $1 and ip_hash = $2 and created_at > $3`,
    [String(username).toLowerCase(), hashIp(ip), since],
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function recordAttempt(pool, username, ip, ok) {
  await pool.query(
    'insert into fair_admin_login_attempts (username, ip_hash, ok) values ($1, $2, $3)',
    [String(username).toLowerCase(), hashIp(ip), ok === true],
  );
}

export async function createSession(pool, userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    'insert into fair_admin_sessions (token_hash, user_id, expires_at) values ($1, $2, $3)',
    [sha256(token), userId, expires],
  );
  return { token, expires };
}

export async function sessionUser(pool, token) {
  if (!token) return null;
  const r = await pool.query(
    `select s.token_hash, u.id, u.username, u.password_hash, u.role, u.display_name,
            u.can_change_password, u.status
       from fair_admin_sessions s
       join fair_admin_users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row || row.status !== 'active') return null;
  return row;
}

export async function destroySession(pool, token) {
  if (!token) return;
  await pool.query('delete from fair_admin_sessions where token_hash = $1', [sha256(token)]);
}

export async function destroyOtherSessions(pool, userId, keepToken) {
  await pool.query('delete from fair_admin_sessions where user_id = $1 and token_hash <> $2', [
    userId,
    sha256(keepToken),
  ]);
}

export function readCookie(req, name) {
  const raw = String(req.headers?.cookie || '');
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return null;
}

export function sessionToken(req) {
  return readCookie(req, COOKIE_NAME);
}

const cookieSecure = () =>
  process.env.NODE_ENV === 'production' || String(process.env.SITE_URL || '').trim().startsWith('https');

function cookie(value, maxAge) {
  const bits = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (cookieSecure()) bits.push('Secure');
  return bits.join('; ');
}

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', cookie(token, Math.floor(SESSION_TTL_MS / 1000)));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', cookie('', 0));
}

/**
 * Sessão válida para o pedido, ou null. Nunca lança: falha de base de dados
 * devolve null e o chamador responde 401.
 */
export async function requireAdmin(pool, req) {
  try {
    const token = sessionToken(req);
    if (!token) return null;
    const user = await sessionUser(pool, token);
    if (!user) return null;
    return { user, token, tokenHash: sha256(token) };
  } catch (e) {
    console.error('admin.session.error', e?.message || String(e));
    return null;
  }
}

export function publicUser(user) {
  return {
    username: user.username,
    role: user.role,
    displayName: user.display_name,
    canChangePassword: user.can_change_password !== false,
  };
}

const clipText = (value, max) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);

export async function bankOf(pool, userId) {
  const r = await pool.query(
    'select holder, bank_name, account_number, nib, wallet, updated_at from fair_admin_bank where user_id = $1',
    [userId],
  );
  return r.rows[0] ?? null;
}

/**
 * Guarda os dados bancários do próprio admin. Só a sessão desse admin chega aqui:
 * o `userId` vem sempre da sessão, nunca do corpo do pedido. Cada alteração deixa
 * registo do antes e do depois.
 */
export async function saveBank(pool, userId, input, ip) {
  const next = {
    holder: clipText(input?.holder, 120) || null,
    bank_name: clipText(input?.bank_name, 80) || null,
    account_number: clipText(input?.account_number, 34) || null,
    nib: clipText(input?.nib, 30) || null,
    wallet: clipText(input?.wallet, 20) || null,
  };
  const before = await bankOf(pool, userId);
  await pool.query(
    `insert into fair_admin_bank (user_id, holder, bank_name, account_number, nib, wallet, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (user_id) do update
       set holder = excluded.holder, bank_name = excluded.bank_name,
           account_number = excluded.account_number, nib = excluded.nib,
           wallet = excluded.wallet, updated_at = now()`,
    [userId, next.holder, next.bank_name, next.account_number, next.nib, next.wallet],
  );
  await pool.query(
    'insert into fair_admin_bank_changes (user_id, before, after, ip_hash) values ($1, $2, $3, $4)',
    [userId, before ? JSON.stringify(before) : null, JSON.stringify(next), hashIp(ip)],
  );
  return next;
}
