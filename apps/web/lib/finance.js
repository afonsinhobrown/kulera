// Financeiro: autores, ligação livro↔autor, livro de razão e saldos por entidade.
//
// Todas as quantias são inteiros em centavos (nunca vírgula flutuante).
// O livro de razão (fair_ledger) é a fonte de verdade de cada movimento; os saldos
// (fair_balances) acumulam o direito de cada entidade.

import { SCENARIOS, goldenRule } from './split.js';

// Entidade da plataforma sem id próprio; usa-se este uuid sentinela para a chave.
export const ZERO_ID = '00000000-0000-0000-0000-000000000000';
// O Emílio é uma pessoa identificada: id fixo para o poder referir sem depender do nome.
export const EMILIO_ID = '00000000-0000-4000-8000-00000000e111';

export async function ensureFinanceSchema(db) {
  await db.query(`create table if not exists fair_authors (
    id uuid primary key default gen_random_uuid(),
    full_name text not null,
    pen_name text,
    nuit text,
    bi_number text,
    bi_copy_url text,
    class text not null default 'national' check (class in ('national','foreign')),
    status text not null default 'stub' check (status in ('stub','claimed','verified')),
    account_user_id uuid,
    is_related boolean not null default false,      -- parte relacionada (Emílio Cossa)
    private_to_partner boolean not null default false, -- estrangeiro não residente
    owner_partner_id uuid references fair_partners (id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`);
  await db.query(
    `create unique index if not exists fair_authors_nuit_uq on fair_authors (nuit) where nuit is not null`,
  );

  await db.query(`create table if not exists fair_book_authors (
    book_id uuid not null references fair_books (id) on delete cascade,
    author_id uuid not null references fair_authors (id) on delete restrict,
    role text not null default 'author' check (role in ('author','coauthor','translator','illustrator')),
    share_bps int not null default 0 check (share_bps between 0 and 10000),
    amount_minor bigint,                               -- valor acordado por livro
    created_at timestamptz not null default now(),
    primary key (book_id, author_id)
  )`);

  await db.query(`create table if not exists fair_ledger (
    id bigserial primary key,
    entry_key text unique,
    kind text not null check (kind in ('sale','gateway_fee','payout','withdrawal','adjustment')),
    entity text not null check (entity in ('tecnoincubadora','kulera','emilio','publisher','author','gateway')),
    entity_id uuid,
    order_id uuid,
    book_id uuid,
    direction text not null check (direction in ('credit','debit')),
    amount_minor bigint not null check (amount_minor >= 0),
    currency char(3) not null default 'MZN',
    meta jsonb,
    created_at timestamptz not null default now()
  )`);
  await db.query(
    `create index if not exists fair_ledger_entity_idx on fair_ledger (entity, entity_id, created_at)`,
  );

  await db.query(`create table if not exists fair_balances (
    entity text not null,
    entity_id uuid not null default '${ZERO_ID}',
    currency char(3) not null default 'MZN',
    accrued_minor bigint not null default 0,
    paid_minor bigint not null default 0,
    updated_at timestamptz not null default now(),
    primary key (entity, entity_id, currency)
  )`);

  // A venda passa a guardar também a parte do autor.
  await db.query('alter table fair_sales add column if not exists author_minor bigint not null default 0');

  // A soma das partes tem de dar o bruto: plataforma + Kulera + editora + autor + gateway.
  // A restrição antiga (comissão + editora = bruto) deixou de fazer sentido: o gateway e o
  // autor passaram a ser parcelas próprias. Fica NOT VALID para não invalidar vendas antigas.
  await db.query('alter table fair_sales drop constraint if exists fair_sales_check');
  await db.query('alter table fair_sales drop constraint if exists fair_sales_three_way_check');
  await db.query(`do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'fair_sales_five_way_check') then
      alter table fair_sales add constraint fair_sales_five_way_check
        check (coalesce(app_minor,0) + coalesce(editors_minor,0) + coalesce(partner_minor,0)
               + coalesce(author_minor,0) + coalesce(gateway_minor,0) = gross_minor) not valid;
    end if;
  end $$`);
}

/** O Emílio tem de existir como autor para o cenário B ser reconhecido. */
export async function ensureRelatedAuthor(db) {
  await db.query(
    `insert into fair_authors (id, full_name, class, status, is_related)
     values ($1, 'Emílio Cossa', 'national', 'verified', true)
     on conflict (id) do update set is_related = true, full_name = excluded.full_name`,
    [EMILIO_ID],
  );
}

const onlyDigits = (v) => String(v ?? '').replace(/\D+/g, '');

/** Normaliza o NUIT: só dígitos. Vazio conta como ausente. */
export const normalizeNuit = (v) => onlyDigits(v) || null;

/**
 * Cria (ou devolve) um autor pelo NUIT. Um NUIT, um autor: se já existir, devolve o
 * existente em vez de duplicar.
 *
 * `allowMissingNuit` existe para a importação dos livros antigos, que têm só o nome do
 * autor: esses ficam como registo inicial, à espera de documentos.
 */
export async function upsertAuthor(db, { fullName, penName = null, nuit = null, biNumber = null, class: klass = 'national', ownerPartnerId = null, privateToPartner = false, isRelated = false, allowMissingNuit = false }) {
  const name = String(fullName ?? '').trim();
  if (!name) throw new Error('nome do autor é obrigatório');
  const n = normalizeNuit(nuit);
  if (klass === 'national' && !privateToPartner && !n && !allowMissingNuit) {
    throw new Error('NUIT é obrigatório para autor moçambicano');
  }
  if (n) {
    const found = await db.query('select id, nuit from fair_authors where nuit = $1', [n]);
    if (found.rows[0]) return { id: found.rows[0].id, created: false };
  } else {
    // Sem NUIT, o nome é a única forma de não duplicar na importação.
    const found = await db.query('select id from fair_authors where nuit is null and lower(full_name) = lower($1)', [name]);
    if (found.rows[0]) return { id: found.rows[0].id, created: false };
  }
  const r = await db.query(
    `insert into fair_authors (full_name, pen_name, nuit, bi_number, class, owner_partner_id, private_to_partner, is_related)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [name, penName, n, biNumber, klass, ownerPartnerId, privateToPartner, isRelated],
  );
  return { id: r.rows[0].id, created: true };
}

/**
 * Declara o valor que o autor recebe num livro.
 * A regra de ouro é verificada aqui: o lado Kulera não pode ficar acima da plataforma.
 */
export async function setBookAuthor(db, { bookId, authorId, role = 'author', shareBps = 0, amountMinor = null }) {
  const bps = Math.round(Number(shareBps) || 0);
  if (bps < 0 || bps > 10000) throw new Error('percentagem inválida');
  const amount = amountMinor == null ? null : Math.round(Number(amountMinor));
  if (amount != null && amount < 0) throw new Error('valor inválido');

  const a = await db.query('select is_related from fair_authors where id = $1', [authorId]);
  if (!a.rows[0]) throw new Error('autor inexistente');
  if (a.rows[0].is_related && ((amount ?? 0) > 0 || bps > 0)) {
    throw new Error('o Emílio Cossa não recebe royalties: a percentagem tem de ser 0');
  }

  await db.query(
    `insert into fair_book_authors (book_id, author_id, role, share_bps, amount_minor)
     values ($1,$2,$3,$4,$5)
     on conflict (book_id, author_id) do update
       set role = excluded.role, share_bps = excluded.share_bps, amount_minor = excluded.amount_minor`,
    [bookId, authorId, role, bps, amount],
  );
  return { shareBps: bps, amountMinor: amount };
}

/**
 * Descobre o cenário de um livro e o valor declarado do autor.
 * `publisherId` nulo significa livro publicado pela própria Kulera.
 */
export async function resolveSaleScenario(db, { bookId, publisherId }) {
  const links = await db.query(
    `select ba.author_id, ba.share_bps, ba.amount_minor, a.is_related, a.default_share_bps
       from fair_book_authors ba
       join fair_authors a on a.id = ba.author_id
      where ba.book_id = $1`,
    [bookId],
  );
  const rows = links.rows;
  const related = rows.some((r) => r.is_related);
  const scenario = related ? SCENARIOS.RELATED_AUTHOR : publisherId ? SCENARIOS.MARKET : SCENARIOS.KULERA_AUTHOR;

  const declared = rows.filter((r) => !r.is_related);
  const amountSum = declared.reduce((sum, r) => sum + Number(r.amount_minor ?? 0), 0);
  // Valor declarado no livro; se não houver, vale a percentagem que o autor definiu na conta.
  const bpsSum = declared.reduce((sum, r) => {
    const doLivro = Number(r.share_bps) > 0 ? Number(r.share_bps) : Number(r.default_share_bps || 0);
    return sum + doLivro;
  }, 0);

  return {
    scenario,
    authorId: declared[0]?.author_id ?? null,
    authorShareBps: Math.min(bpsSum, 10000),
    authorAmountMinor: amountSum > 0 ? amountSum : null,
  };
}

/**
 * Regista uma venda no livro de razão e actualiza os saldos.
 * Idempotente: a mesma venda não entra duas vezes (chave por encomenda e entidade).
 */
export async function postSale(db, { orderId, bookId, publisherId = null, authorId = null, split, currency = 'MZN', meta = null }) {
  if (!split?.golden?.ok) {
    throw new Error('regra de ouro violada: a Kulera ficaria acima da TecnoIncubadora');
  }

  const movements = [
    { entity: 'tecnoincubadora', entityId: ZERO_ID, amount: split.techNet },
    { entity: 'kulera', entityId: ZERO_ID, amount: split.kulera },
    { entity: 'emilio', entityId: ZERO_ID, amount: split.emilio },
    { entity: 'publisher', entityId: publisherId, amount: split.publisher },
    { entity: 'author', entityId: authorId, amount: split.author },
  ].filter((m) => m.amount > 0 && (m.entity !== 'publisher' && m.entity !== 'author' ? true : Boolean(m.entityId)));

  for (const m of movements) {
    const key = `sale:${orderId}:${m.entity}:${m.entityId ?? 'tech'}`;
    const ins = await db.query(
      `insert into fair_ledger (entry_key, kind, entity, entity_id, order_id, book_id, direction, amount_minor, currency, meta)
       values ($1,'sale',$2,$3,$4,$5,'credit',$6,$7,$8)
       on conflict (entry_key) do nothing
       returning id`,
      [key, m.entity, m.entityId, orderId, bookId, m.amount, currency, meta ? JSON.stringify(meta) : null],
    );
    if (ins.rows.length === 0) continue; // já registado

    await db.query(
      `insert into fair_balances (entity, entity_id, currency, accrued_minor)
       values ($1,$2,$3,$4)
       on conflict (entity, entity_id, currency) do update
         set accrued_minor = fair_balances.accrued_minor + excluded.accrued_minor, updated_at = now()`,
      [m.entity, m.entityId, currency, m.amount],
    );
  }

  // A taxa do gateway fica registada como custo, para o painel a poder somar.
  if (split.gateway > 0) {
    await db.query(
      `insert into fair_ledger (entry_key, kind, entity, order_id, book_id, direction, amount_minor, currency)
       values ($1,'gateway_fee','gateway',$2,$3,'debit',$4,$5)
       on conflict (entry_key) do nothing`,
      [`sale:${orderId}:gateway`, orderId, bookId, split.gateway, currency],
    );
  }
  return { movements: movements.length };
}

/** Saldo de uma entidade (direito adquirido e já pago). */
export async function balanceOf(db, { entity, entityId = ZERO_ID, currency = 'MZN' }) {
  const r = await db.query(
    'select accrued_minor, paid_minor from fair_balances where entity = $1 and entity_id = $2 and currency = $3',
    [entity, entityId, currency],
  );
  const row = r.rows[0];
  return {
    accrued: Number(row?.accrued_minor ?? 0),
    paid: Number(row?.paid_minor ?? 0),
    available: Number(row?.accrued_minor ?? 0) - Number(row?.paid_minor ?? 0),
  };
}

export { goldenRule };
