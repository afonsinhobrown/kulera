import { pool } from './db.js';

// Planos mensais para editoras/autores: variam no nº de publicações por mês e na prioridade na montra.
// max_publications = null => ilimitado. showcase_priority maior => aparece primeiro na montra.
export const DEFAULT_PLANS = [
  { code: 'basic',   name: 'Básico',       price_minor: 300000, max_publications: 3,    showcase_priority: 1, description: 'Até 3 publicações por mês · posição normal na montra' },
  { code: 'pro',     name: 'Profissional', price_minor: 500000, max_publications: 10,   showcase_priority: 2, description: 'Até 10 publicações por mês · prioridade na montra' },
  { code: 'premium', name: 'Premium',      price_minor: 700000, max_publications: null, showcase_priority: 3, description: 'Publicações ilimitadas · destaque no topo da montra' },
];

let ensured = false;
export async function ensurePlanSchema() {
  if (ensured) return;
  await pool.query('alter table fair_plans add column if not exists max_publications int');
  await pool.query('alter table fair_plans add column if not exists showcase_priority int not null default 0');
  await pool.query('alter table fair_subscriptions add column if not exists partner_id uuid');
  await pool.query('alter table fair_orders add column if not exists partner_id uuid');
  // Garante os 3 planos oficiais (sem sobrescrever edições feitas no painel) e arquiva os antigos.
  for (const p of DEFAULT_PLANS) {
    await pool.query(
      `insert into fair_plans (code,name,description,price_minor,currency,interval,status,max_publications,showcase_priority)
       values ($1,$2,$3,$4,'MZN','month','active',$5,$6) on conflict (code) do nothing`,
      [p.code, p.name, p.description, p.price_minor, p.max_publications, p.showcase_priority]);
  }
  await pool.query("update fair_plans set status='archived' where code in ('mzn-month','mzn-year')");
  ensured = true;
}

/** Plano activo do parceiro (ou null). */
export async function activePlan(partnerId) {
  await ensurePlanSchema();
  const r = await pool.query(
    `select s.id as subscription_id, s.starts_at, s.ends_at, p.id, p.code, p.name, p.max_publications, p.showcase_priority
       from fair_subscriptions s join fair_plans p on p.id = s.plan_id
      where s.partner_id = $1 and s.status = 'active' and s.ends_at > now()
      order by p.showcase_priority desc, s.ends_at desc limit 1`, [partnerId]);
  return r.rows[0] || null;
}

/** Publicações usadas no mês corrente (submissões feitas nos últimos 30 dias). */
export async function publicationsUsed(partnerId) {
  const r = await pool.query("select count(*)::int n from fair_submissions where partner_id=$1 and created_at > now() - interval '30 days'", [partnerId]);
  return r.rows[0].n;
}
