import { pool } from './db.js';

// Planos mensais para editoras/autores (Revisão V3).
// max_publications = null => catálogo ilimitado. showcase_priority maior => aparece primeiro na montra.
export const DEFAULT_PLANS = [
  {
    code: 'basic',
    name: 'Básico',
    price_minor: 50000, // 500,00 MT
    max_publications: 2,
    showcase_priority: 1,
    description: 'Até 2 livros activos · posição normal na montra',
  },
  {
    code: 'pro',
    name: 'Padrão',
    price_minor: 250000, // 2.500,00 MT
    max_publications: 15,
    showcase_priority: 2,
    description: 'Até 15 livros activos · carteira de clientes, relatórios e descontos',
  },
  {
    code: 'premium',
    name: 'Premium',
    price_minor: 750000, // 7.500,00 MT
    max_publications: null,
    showcase_priority: 3,
    description: 'Catálogo ilimitado · split automático, sub-contas e pré-vendas',
  },
];

// Preços da versão anterior: usados apenas para migrar instalações antigas uma única vez.
const LEGACY_PRICES = [300000, 500000, 700000];

let ensured = false;
export async function ensurePlanSchema() {
  if (ensured) return;
  await pool.query('alter table fair_plans add column if not exists max_publications int');
  await pool.query('alter table fair_plans add column if not exists showcase_priority int not null default 0');
  await pool.query('alter table fair_subscriptions add column if not exists partner_id uuid');
  await pool.query('alter table fair_subscriptions add column if not exists grace_ends_at timestamptz');
  await pool.query('alter table fair_subscriptions add column if not exists last_payment_failed_at timestamptz');
  await pool.query('alter table fair_subscriptions add column if not exists warning_72h_sent_at timestamptz');
  await pool.query('alter table fair_subscriptions add column if not exists warning_24h_sent_at timestamptz');
  await pool.query('alter table fair_orders add column if not exists partner_id uuid');
  // Garante os 3 planos oficiais (sem sobrescrever edições feitas no painel) e arquiva os antigos.
  for (const p of DEFAULT_PLANS) {
    await pool.query(
      `insert into fair_plans (code,name,description,price_minor,currency,interval,status,max_publications,showcase_priority)
       values ($1,$2,$3,$4,'MZN','month','active',$5,$6) on conflict (code) do nothing`,
      [p.code, p.name, p.description, p.price_minor, p.max_publications, p.showcase_priority]);
  }
  // Migração V3: actualiza apenas planos que ainda estão nos preços antigos de fábrica.
  for (const p of DEFAULT_PLANS) {
    await pool.query(
      `update fair_plans set name=$2, description=$3, price_minor=$4, max_publications=$5, showcase_priority=$6
        where code=$1 and price_minor = any($7::bigint[])`,
      [p.code, p.name, p.description, p.price_minor, p.max_publications, p.showcase_priority, LEGACY_PRICES]);
  }
  await pool.query("update fair_plans set status='archived' where code in ('mzn-month','mzn-year')");
  ensured = true;
}

/** Plano activo do parceiro (ou null). */
export async function activePlan(partnerId) {
  await ensurePlanSchema();
  const r = await pool.query(
    `select s.id as subscription_id, s.starts_at, s.ends_at, s.status as subscription_status,
            s.grace_ends_at, p.id, p.code, p.name, p.max_publications, p.showcase_priority
       from fair_subscriptions s join fair_plans p on p.id = s.plan_id
       where s.partner_id = $1 and s.status in ('active','past_due')
         and (
           s.ends_at > now()
           or (s.status = 'past_due'
               and coalesce(s.grace_ends_at, s.ends_at + interval '3 days') > now())
         )
      order by p.showcase_priority desc, s.ends_at desc limit 1`, [partnerId]);
  return r.rows[0] || null;
}

/** Livros activos neste momento (limite do plano é de livros activos simultâneos). */
export async function publicationsUsed(partnerId) {
  const r = await pool.query("select count(*)::int n from fair_books where partner_id=$1 and status='published'", [partnerId]);
  return r.rows[0].n;
}
