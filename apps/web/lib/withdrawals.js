// Saques: dois tipos (editora e divisão de lucros), dois modos (automático e aprovado).
//
// Regras do promotor:
//  - o modo por omissão é "aprovado" e só a TecnoIncubadora o pode mudar;
//  - todos os pedidos de saque de editora vão para os dois administradores;
//  - no modo aprovado, os dois admins têm de autorizar;
//  - sócios só de 3 em 3 meses; editoras a qualquer momento;
//  - saque extraordinário (fora dos 3 meses) só a TecnoIncubadora autoriza;
//  - a taxa de 1% do gateway sai do valor levantado;
//  - o direito de cada um fica sempre registado, mesmo sem saque.

import { ZERO_ID, balanceOf } from './finance.js';

export const WITHDRAWAL_FEE_BPS = 100; // 1%
export const PROFIT_PERIOD_DAYS = 90; // 3 meses

export const KINDS = { PUBLISHER: 'publisher', PROFIT: 'profit_share' };
export const MODES = { AUTO: 'auto', APPROVED: 'approved' };
// A divisão de lucros sai do caixa da plataforma. O Emílio Cossa é dono, não é um
// sacador: não tem saldo nem pedido próprio — recebe a metade dele pela divisão.
export const PROFIT_ENTITIES = ['tecnoincubadora'];

const share = (amountMinor, bps) => Number((BigInt(amountMinor) * BigInt(bps) + 5000n) / 10000n);

export async function ensureWithdrawalSchema(db) {
  await db.query(`create table if not exists fair_withdrawals (
    id uuid primary key default gen_random_uuid(),
    batch_id uuid,
    kind text not null check (kind in ('publisher','profit_share')),
    entity text not null check (entity in ('publisher','tecnoincubadora','kulera','emilio')),
    entity_id uuid not null default '${ZERO_ID}',
    amount_minor bigint not null check (amount_minor > 0),
    fee_bps int not null default 100 check (fee_bps between 0 and 10000),
    fee_minor bigint not null default 0 check (fee_minor >= 0),
    net_minor bigint not null default 0 check (net_minor >= 0),
    currency char(3) not null default 'MZN',
    mode text not null default 'approved' check (mode in ('auto','approved')),
    extraordinary boolean not null default false,
    status text not null default 'requested' check (status in ('requested','approved','paid','rejected')),
    note text,
    requested_by text,
    requested_at timestamptz not null default now(),
    decided_at timestamptz,
    paid_at timestamptz
  )`);
  await db.query(`create table if not exists fair_withdrawal_approvals (
    withdrawal_id uuid not null references fair_withdrawals (id) on delete cascade,
    admin_username text not null,
    decision text not null check (decision in ('approve','reject')),
    created_at timestamptz not null default now(),
    primary key (withdrawal_id, admin_username)
  )`);
  await db.query(
    `create index if not exists fair_withdrawals_entity_idx on fair_withdrawals (entity, entity_id, status)`,
  );
  // Divisão societária: a metade de cada dono fica guardada no próprio saque.
  await db.query('alter table fair_withdrawals add column if not exists share_tech_minor bigint not null default 0');
  await db.query('alter table fair_withdrawals add column if not exists share_emilio_minor bigint not null default 0');
}

/** Modo vigente dos saques. Por omissão: aprovado. */
export async function withdrawalMode(db) {
  try {
    const r = await db.query("select value from fair_settings where key = 'withdrawal_mode'");
    const v = String(r.rows[0]?.value || '').trim();
    return v === MODES.AUTO ? MODES.AUTO : MODES.APPROVED;
  } catch {
    return MODES.APPROVED;
  }
}

/** Só a TecnoIncubadora muda o modo. */
export async function setWithdrawalMode(db, { admin, mode }) {
  if (admin !== 'tecnoincubadora') throw new Error('só a TecnoIncubadora pode alterar o modo dos saques');
  if (!Object.values(MODES).includes(mode)) throw new Error('modo inválido');
  await db.query(
    `insert into fair_settings (key, value, updated_at) values ('withdrawal_mode', $1, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [mode],
  );
  return mode;
}

/** Último saque de lucros já pago, para contar os 3 meses. */
export async function lastProfitWithdrawalAt(db, { entity, entityId = ZERO_ID }) {
  const r = await db.query(
    `select paid_at from fair_withdrawals
      where kind = 'profit_share' and entity = $1 and entity_id = $2 and status = 'paid'
      order by paid_at desc limit 1`,
    [entity, entityId],
  );
  return r.rows[0]?.paid_at ?? null;
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Quando é que aquele sócio pode voltar a levantar lucros. */
export async function nextProfitWithdrawalAt(db, { entity, entityId = ZERO_ID }) {
  const last = await lastProfitWithdrawalAt(db, { entity, entityId });
  return last ? addDays(last, PROFIT_PERIOD_DAYS) : null;
}

/**
 * Cria um pedido de saque. Não paga nada: só abre o pedido (ou aprova-o, no modo automático).
 */
export async function createWithdrawal(db, { kind, entity, entityId = ZERO_ID, amountMinor, requestedBy, extraordinary = false, note = null, now = new Date() }) {
  if (!Object.values(KINDS).includes(kind)) throw new Error('tipo de saque inválido');
  if (kind === KINDS.PUBLISHER && entity !== 'publisher') throw new Error('saque de editora exige entidade publisher');
  if (kind === KINDS.PROFIT && !PROFIT_ENTITIES.includes(entity)) throw new Error('saque de lucros exige um sócio');

  const amount = Math.round(Number(amountMinor));
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('valor inválido');

  // Só a TecnoIncubadora abre saque extraordinário.
  if (extraordinary && requestedBy !== 'tecnoincubadora') {
    throw new Error('saque extraordinário só a TecnoIncubadora autoriza');
  }

  const saldo = await balanceOf(db, { entity, entityId });
  if (amount > saldo.available) throw new Error(`valor acima do disponível (${saldo.available} centavos)`);

  if (kind === KINDS.PROFIT && !extraordinary) {
    const nextAt = await nextProfitWithdrawalAt(db, { entity, entityId });
    if (nextAt && new Date(nextAt) > now) {
      throw new Error(`sócio só pode levantar lucros a partir de ${new Date(nextAt).toISOString().slice(0, 10)}`);
    }
  }

  const mode = await withdrawalMode(db);
  const fee = share(amount, WITHDRAWAL_FEE_BPS);
  const status = mode === MODES.AUTO ? 'approved' : 'requested';

  const r = await db.query(
    `insert into fair_withdrawals (kind, entity, entity_id, amount_minor, fee_bps, fee_minor, net_minor, mode, extraordinary, status, note, requested_by, decided_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [kind, entity, entityId, amount, WITHDRAWAL_FEE_BPS, fee, amount - fee, mode, extraordinary, status, note, requestedBy, status === 'approved' ? now : null],
  );
  return r.rows[0];
}

/**
 * Divisão de lucros: o caixa da plataforma é repartido 50/50 entre os dois donos.
 * É um único pedido (a sociedade não pede duas vezes): fica registado quanto vai para
 * cada um, e o pagamento é aprovado pelos dois admins como qualquer saque.
 * O Emílio recebe a metade dele daqui — não tem saldo nem pedido próprio.
 */
export async function createProfitDivision(db, { totalMinor, requestedBy, extraordinary = false, note = null, now = new Date(), currency = 'MZN' }) {
  const total = Math.round(Number(totalMinor));
  if (!Number.isInteger(total) || total <= 0) throw new Error('valor inválido');

  const saldo = await balanceOf(db, { entity: 'tecnoincubadora', currency });
  if (total > saldo.available) throw new Error(`valor acima do disponível (${saldo.available} centavos)`);

  const half = Math.floor(total / 2);
  const rest = total - half; // o cêntimo ímpar fica com o Emílio
  const mode = await withdrawalMode(db);
  const fee = share(total, WITHDRAWAL_FEE_BPS);

  const r = await db.query(
    `insert into fair_withdrawals
       (kind, entity, entity_id, amount_minor, fee_bps, fee_minor, net_minor, mode, extraordinary, status, note, requested_by, decided_at, share_tech_minor, share_emilio_minor)
     values ('profit_share','tecnoincubadora',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [
      ZERO_ID,
      total,
      WITHDRAWAL_FEE_BPS,
      fee,
      total - fee,
      mode,
      extraordinary,
      mode === MODES.AUTO ? 'approved' : 'requested',
      note ?? 'Divisão de lucros 50/50',
      requestedBy,
      mode === MODES.AUTO ? now : null,
      half,
      rest,
    ],
  );
  return r.rows[0];
}

/** Registo de aprovação (ou recusa) de um admin. Precisa dos dois para aprovar. */
export async function decideWithdrawal(db, { id, admin, decision, now = new Date() }) {
  if (!['approve', 'reject'].includes(decision)) throw new Error('decisão inválida');
  const cur = await db.query('select * from fair_withdrawals where id = $1', [id]);
  const w = cur.rows[0];
  if (!w) throw new Error('saque inexistente');
  if (w.status !== 'requested') throw new Error('este saque já não está à espera de decisão');

  await db.query(
    `insert into fair_withdrawal_approvals (withdrawal_id, admin_username, decision, created_at)
     values ($1,$2,$3,$4)
     on conflict (withdrawal_id, admin_username) do update set decision = excluded.decision, created_at = excluded.created_at`,
    [id, admin, decision, now],
  );

  if (decision === 'reject') {
    await db.query("update fair_withdrawals set status = 'rejected', decided_at = $2 where id = $1", [id, now]);
    return { status: 'rejected', approvals: 0 };
  }

  const approvals = await db.query(
    `select count(distinct admin_username)::int as n from fair_withdrawal_approvals
      where withdrawal_id = $1 and decision = 'approve'`,
    [id],
  );
  const n = Number(approvals.rows[0]?.n ?? 0);
  // Os dois administradores têm de autorizar.
  if (n >= 2) {
    await db.query("update fair_withdrawals set status = 'approved', decided_at = $2 where id = $1", [id, now]);
    return { status: 'approved', approvals: n };
  }
  return { status: 'requested', approvals: n };
}

/**
 * Paga: debita o saldo da entidade e deixa no razão o valor bruto e a taxa de 1%.
 * É o único ponto que mexe no dinheiro de um saque.
 */
export async function payWithdrawal(db, { id, admin, now = new Date(), currency = 'MZN' }) {
  const cur = await db.query('select * from fair_withdrawals where id = $1', [id]);
  const w = cur.rows[0];
  if (!w) throw new Error('saque inexistente');
  if (w.status !== 'approved') throw new Error('o saque ainda não está aprovado');

  const saldo = await balanceOf(db, { entity: w.entity, entityId: w.entity_id, currency: w.currency });
  if (Number(w.amount_minor) > saldo.available) throw new Error('saldo insuficiente para pagar este saque');

  await db.query(
    `insert into fair_ledger (entry_key, kind, entity, entity_id, direction, amount_minor, currency, meta)
     values ($1,'withdrawal',$2,$3,'debit',$4,$5,$6) on conflict (entry_key) do nothing`,
    [`withdrawal:${w.id}`, w.entity, w.entity_id, Number(w.amount_minor), w.currency, JSON.stringify({ by: admin })],
  );
  // Numa divisão de lucros, a metade do Emílio sai daqui: é pagamento a um dono, não
  // um saldo dele (ele não tem conta corrente na plataforma).
  if (Number(w.share_emilio_minor || 0) > 0) {
    await db.query(
      `insert into fair_ledger (entry_key, kind, entity, direction, amount_minor, currency, meta)
       values ($1,'payout','emilio','credit',$2,$3,$4) on conflict (entry_key) do nothing`,
      [`withdrawal:${w.id}:emilio`, Number(w.share_emilio_minor), w.currency, JSON.stringify({ divisao: w.id })],
    );
  }
  if (Number(w.share_tech_minor || 0) > 0) {
    await db.query(
      `insert into fair_ledger (entry_key, kind, entity, direction, amount_minor, currency, meta)
       values ($1,'payout','tecnoincubadora','credit',$2,$3,$4) on conflict (entry_key) do nothing`,
      [`withdrawal:${w.id}:tech`, Number(w.share_tech_minor), w.currency, JSON.stringify({ divisao: w.id })],
    );
  }
  if (Number(w.fee_minor) > 0) {
    await db.query(
      `insert into fair_ledger (entry_key, kind, entity, direction, amount_minor, currency, meta)
       values ($1,'gateway_fee','gateway','debit',$2,$3,$4) on conflict (entry_key) do nothing`,
      [`withdrawal:${w.id}:fee`, Number(w.fee_minor), w.currency, JSON.stringify({ by: admin })],
    );
  }
  await db.query(
    `insert into fair_balances (entity, entity_id, currency, paid_minor)
     values ($1,$2,$3,$4)
     on conflict (entity, entity_id, currency) do update
       set paid_minor = fair_balances.paid_minor + excluded.paid_minor, updated_at = now()`,
    [w.entity, w.entity_id, w.currency, Number(w.amount_minor)],
  );
  await db.query("update fair_withdrawals set status = 'paid', paid_at = $2 where id = $1", [id, now]);
  return { ...w, status: 'paid', paid_at: now };
}

/** Lista para o painel: pedidos e histórico. */
export async function listWithdrawals(db, { status = null, limit = 200 } = {}) {
  const r = await db.query(
    `select w.*, (select count(*)::int from fair_withdrawal_approvals a where a.withdrawal_id = w.id and a.decision = 'approve') as approvals
       from fair_withdrawals w
      where ($1::text is null or w.status = $1)
      order by w.requested_at desc
      limit $2`,
    [status, limit],
  );
  return r.rows;
}
