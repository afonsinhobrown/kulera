// Contas de autor.
//
// Um autor que entra pela primeira vez fica OBRIGADO a completar os dados antes de usar
// qualquer outra funcionalidade: NUIT, BI, percentagem na venda e conta de recebimento
// (M-Pesa, e-Mola ou NIB).
//
// Ao completar o NUIT, o sistema reconcilia com o registo que uma editora possa ter criado
// antes: os livros passam para a conta do autor em vez de ficarem duplicados.

import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from './admin-auth.js';
import { normalizeNuit } from './finance.js';

export const AUTHOR_COOKIE = 'kaut';
export const PAYOUT_METHODS = ['mpesa', 'emola', 'nib'];
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex');

export async function ensureAuthorSchema(db) {
  await db.query(`create table if not exists fair_author_accounts (
    id uuid primary key default gen_random_uuid(),
    author_id uuid not null references fair_authors (id) on delete cascade,
    email text not null unique,
    password_hash text not null,
    status text not null default 'active' check (status in ('active','suspended')),
    created_at timestamptz not null default now(),
    last_login_at timestamptz
  )`);
  await db.query(`create table if not exists fair_author_sessions (
    token_hash text primary key,
    account_id uuid not null references fair_author_accounts (id) on delete cascade,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
  )`);
  await db.query('alter table fair_authors add column if not exists default_share_bps int not null default 0');
  await db.query('alter table fair_authors add column if not exists payout_method text');
  await db.query('alter table fair_authors add column if not exists payout_account text');
  await db.query('alter table fair_authors add column if not exists payout_holder text');
  await db.query('alter table fair_authors add column if not exists data_completed_at timestamptz');
}

/**
 * O que falta ao autor. Enquanto a lista não estiver vazia, a conta fica bloqueada
 * no formulário de completação.
 */
export function missingFields(author) {
  const faltas = [];
  if (!author) return ['registo'];
  if (!normalizeNuit(author.nuit)) faltas.push('NUIT');
  if (!String(author.bi_number || '').trim()) faltas.push('BI');
  // O Emílio é parte relacionada: os royalties dele são 0 por regra, não é dado em falta.
  if (!author.is_related && !(Number(author.default_share_bps) > 0)) faltas.push('percentagem na venda');
  if (!PAYOUT_METHODS.includes(String(author.payout_method || ''))) faltas.push('forma de recebimento');
  if (!String(author.payout_account || '').trim()) faltas.push('conta de recebimento');
  return faltas;
}

export const isComplete = (author) => missingFields(author).length === 0;

export async function createAuthorAccount(db, { email, password, fullName }) {
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new Error('email inválido');
  if (String(password || '').length < 8) throw new Error('a senha precisa de pelo menos 8 caracteres');
  const name = String(fullName || '').trim();
  if (name.length < 2) throw new Error('indique o nome');

  const existe = await db.query('select id from fair_author_accounts where email = $1', [mail]);
  if (existe.rows[0]) throw new Error('já existe uma conta com este email');

  // Nasce como registo inicial, sem NUIT: a completação preenche o resto.
  const a = await db.query(
    `insert into fair_authors (full_name, class, status) values ($1, 'national', 'stub') returning id`,
    [name],
  );
  const authorId = a.rows[0].id;
  const acc = await db.query(
    `insert into fair_author_accounts (author_id, email, password_hash) values ($1,$2,$3) returning id`,
    [authorId, mail, hashPassword(password)],
  );
  return { accountId: acc.rows[0].id, authorId };
}

export async function findAccountByEmail(db, email) {
  const r = await db.query(
    `select acc.id as account_id, acc.email, acc.password_hash, acc.status,
            a.id as author_id, a.full_name, a.nuit, a.bi_number, a.is_related,
            a.default_share_bps, a.payout_method, a.payout_account, a.payout_holder, a.data_completed_at
       from fair_author_accounts acc
       join fair_authors a on a.id = acc.author_id
      where acc.email = $1`,
    [String(email || '').trim().toLowerCase()],
  );
  return r.rows[0] ?? null;
}

export async function loginAuthor(db, { email, password }) {
  const row = await findAccountByEmail(db, email);
  if (!row || row.status !== 'active' || !verifyPassword(String(password ?? ''), row.password_hash)) {
    return null;
  }
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await db.query('insert into fair_author_sessions (token_hash, account_id, expires_at) values ($1,$2,$3)', [
    sha256(token),
    row.account_id,
    expires,
  ]);
  await db.query('update fair_author_accounts set last_login_at = now() where id = $1', [row.account_id]);
  return { token, expires, author: row };
}

export async function authorByToken(db, token) {
  if (!token) return null;
  const r = await db.query(
    `select s.token_hash, acc.id as account_id, acc.email, acc.status,
            a.id as author_id, a.full_name, a.nuit, a.bi_number, a.is_related,
            a.default_share_bps, a.payout_method, a.payout_account, a.payout_holder, a.data_completed_at
       from fair_author_sessions s
       join fair_author_accounts acc on acc.id = s.account_id
       join fair_authors a on a.id = acc.author_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row || row.status !== 'active') return null;
  return row;
}

export async function logoutAuthor(db, token) {
  if (!token) return;
  await db.query('delete from fair_author_sessions where token_hash = $1', [sha256(token)]);
}

export function authorCookie(token, maxAgeSeconds) {
  const bits = [`${AUTHOR_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (process.env.NODE_ENV === 'production' || String(process.env.SITE_URL || '').startsWith('https')) bits.push('Secure');
  return bits.join('; ');
}

export function readAuthorCookie(req) {
  const raw = String(req.headers?.cookie || '');
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === AUTHOR_COOKIE) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return null;
}

/**
 * Completa os dados do autor. Se o NUIT já existir noutro registo (criado por uma editora),
 * reconcilia: os livros passam para este autor e o registo antigo desaparece.
 */
export async function completeAuthorProfile(db, authorId, data) {
  const author = (await db.query('select * from fair_authors where id = $1', [authorId])).rows[0];
  if (!author) throw new Error('autor inexistente');

  const nuit = normalizeNuit(data.nuit);
  if (!nuit) throw new Error('NUIT é obrigatório');
  const bi = String(data.bi || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 30);
  if (!bi) throw new Error('BI é obrigatório');

  const shareBps = Math.round(Number(data.shareBps) || 0);
  if (!author.is_related && (shareBps <= 0 || shareBps > 10000)) {
    throw new Error('indique a percentagem que recebe na venda');
  }

  const method = String(data.payoutMethod || '').trim();
  if (!PAYOUT_METHODS.includes(method)) throw new Error('escolha M-Pesa, e-Mola ou NIB');
  const account = String(data.payoutAccount || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (account.length < 6) throw new Error('indique a conta que vai receber o valor');
  const holder = String(data.payoutHolder || author.full_name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);

  // Reconciliação: mesmo NUIT noutro registo?
  const outro = (await db.query('select id from fair_authors where nuit = $1 and id <> $2', [nuit, authorId])).rows[0];
  if (outro) {
    // Os livros passam para o registo com conta; o registo antigo fica vazio.
    // Primeiro tiram-se as ligações que ficariam duplicadas (mesmo livro nos dois autores).
    await db.query(
      `delete from fair_book_authors a
        where a.author_id = $2
          and exists (select 1 from fair_book_authors b where b.author_id = $1 and b.book_id = a.book_id)`,
      [authorId, outro.id],
    );
    await db.query('update fair_book_authors set author_id = $1 where author_id = $2', [authorId, outro.id]);
    await db.query('update fair_ledger set entity_id = $1 where entity = $2 and entity_id = $3', [authorId, 'author', outro.id]);
    await db.query('delete from fair_authors where id = $1', [outro.id]);
  }

  await db.query(
    `update fair_authors
        set nuit = $2, bi_number = $3, default_share_bps = $4, payout_method = $5,
            payout_account = $6, payout_holder = $7, status = 'claimed', data_completed_at = now(), updated_at = now()
      where id = $1`,
    [authorId, nuit, bi, author.is_related ? 0 : shareBps, method, account, holder],
  );

  return (await db.query('select * from fair_authors where id = $1', [authorId])).rows[0];
}
