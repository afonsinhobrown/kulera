import { pool } from './db.js';
import { ensureCreditSchema, expireCredits } from './credits.js';
import { GATEWAY_BPS, SUBSCRIPTION_GRACE_DAYS, EXPIRY_WARNING_HOURS } from './pricing.js';
import { emailConfigured, expiryWarningEmail, sendEmail, subscriptionFailedEmail, SITE_BASE } from './email.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);
export const addHours = (date, hours) => new Date(date.getTime() + hours * HOUR_MS);

/** Fim do período de tolerância de 3 dias (a contar da falha/fim da assinatura). */
export const graceDeadline = (from) => addDays(from, SUBSCRIPTION_GRACE_DAYS);

/** Escolhe o aviso devido (72h ou 24h) antes de uma expiração. */
export function warningDue(expiresAt, now, sent = {}) {
  const msLeft = new Date(expiresAt).getTime() - new Date(now).getTime();
  if (msLeft <= 0) return null;
  if (msLeft <= EXPIRY_WARNING_HOURS[1] * HOUR_MS) return sent.h24 ? null : 24;
  if (msLeft <= EXPIRY_WARNING_HOURS[0] * HOUR_MS) return sent.h72 ? null : 72;
  return null;
}

let ensured = false;
export async function ensureLifecycleSchema(p = pool) {
  if (ensured) return;
  await ensureCreditSchema(p);
  try {
    await p.query(`alter table fair_subscriptions add column if not exists grace_ends_at timestamptz`);
    await p.query(`alter table fair_subscriptions add column if not exists last_payment_failed_at timestamptz`);
    await p.query(`alter table fair_subscriptions add column if not exists warning_72h_sent_at timestamptz`);
    await p.query(`alter table fair_subscriptions add column if not exists warning_24h_sent_at timestamptz`);
    await p.query(`alter table fair_subscriptions drop constraint if exists fair_subscriptions_status_check`);
    await p.query(`alter table fair_subscriptions add constraint fair_subscriptions_status_check
      check (status in ('active','past_due','cancelled','expired'))`);
  } catch {}
  ensured = true;
}

// Assinatura continua a dar acesso durante a tolerância (past_due) ou até ao fim do período pago.
export const subscriptionCovers = (sub, now) => {
  if (!sub) return false;
  if (sub.status === 'active') return new Date(sub.ends_at).getTime() > new Date(now).getTime();
  if (sub.status === 'past_due') {
    const grace = sub.grace_ends_at ? new Date(sub.grace_ends_at) : graceDeadline(new Date(sub.ends_at));
    return grace.getTime() > new Date(now).getTime();
  }
  return false;
};

/** Suspende as obras do parceiro sem apagar ficheiros nem histórico. */
export async function suspendPartnerBooks(p, partnerId, now, reason) {
  const r = await p.query(
    `with suspended as (
       update fair_books b
          set status = 'suspended', suspended_at = $2, suspended_reason = $3, updated_at = now()
        where b.partner_id = $1
          and b.status = 'published'
          and (b.active_until is null or b.active_until <= $2)
          and not exists (
            select 1 from fair_subscriptions s
             where s.partner_id = b.partner_id
               and (
                 (s.status = 'active' and s.ends_at > $2)
                 or (s.status = 'past_due'
                     and coalesce(s.grace_ends_at, s.ends_at + ($4)::int * interval '1 day') > $2)
               )
          )
        returning b.id
     ), logged as (
       insert into fair_book_status_events (book_id, from_status, to_status, reason, created_at)
       select id, 'published', 'suspended', $3, $2 from suspended
       returning book_id
     )
     select count(*)::int as n from suspended`,
    [partnerId, now, reason, SUBSCRIPTION_GRACE_DAYS],
  );
  return Number(r.rows[0]?.n || 0);
}

/** Reactiva obras suspensas por expiração assim que exista plano activo, sem passar do limite. */
export async function resumePartnerBooks(p, partnerId, now = new Date()) {
  await ensureLifecycleSchema(p);
  const plan = (await p.query(
    `select p.max_publications
       from fair_subscriptions s join fair_plans p on p.id = s.plan_id
      where s.partner_id = $1 and s.status in ('active','past_due')
        and (
          s.ends_at > $2
          or (s.status = 'past_due'
              and coalesce(s.grace_ends_at, s.ends_at + ($3)::int * interval '1 day') > $2)
        )
      order by p.showcase_priority desc, s.ends_at desc limit 1`,
    [partnerId, now, SUBSCRIPTION_GRACE_DAYS],
  )).rows[0];
  if (!plan) return 0;
  const r = await p.query(
    `with current as (
       select count(*)::int n from fair_books where partner_id = $1 and status = 'published'
     ), candidates as (
       select id, status from fair_books
        where partner_id = $1 and status = 'suspended'
          and suspended_reason in ('subscription_expired','credit_expired')
        order by updated_at asc nulls last
        limit greatest(0, coalesce($2::int, 2147483647) - (select n from current))
     ), resumed as (
       update fair_books b
          set status = 'published', suspended_at = null, suspended_reason = null, updated_at = now()
         from candidates c where b.id = c.id
        returning b.id, c.status
     ), logged as (
       insert into fair_book_status_events (book_id, from_status, to_status, reason, created_at)
       select id, status, 'published', 'subscription_recovered', $3 from resumed
       returning book_id
     )
     select count(*)::int as n from resumed`,
    [partnerId, plan.max_publications, now],
  );
  return Number(r.rows[0]?.n || 0);
}

/** Regista uma falha de cobrança e inicia a tolerância de 3 dias. */
export async function markSubscriptionPaymentFailed(p = pool, subscriptionId, now = new Date()) {
  await ensureLifecycleSchema(p);
  const r = await p.query(
    `update fair_subscriptions
        set last_payment_failed_at = $2,
            grace_ends_at = coalesce(grace_ends_at, $2 + ($3)::int * interval '1 day'),
            status = case when status = 'active' then 'past_due' else status end
      where id = $1 and status in ('active','past_due')
      returning id, status, grace_ends_at, buyer_name, buyer_email`,
    [subscriptionId, now, SUBSCRIPTION_GRACE_DAYS],
  );
  const sub = r.rows[0] || null;
  if (sub && emailConfigured()) {
    const mail = subscriptionFailedEmail({
      name: sub.buyer_name,
      graceEndsAt: sub.grace_ends_at,
      link: `${SITE_BASE()}/planos.html`,
    });
    try {
      await sendEmail({ to: sub.buyer_email, ...mail });
    } catch {}
  }
  return sub;
}

/** Confirma a regularização e renova o período. */
export async function markSubscriptionPaymentRecovered(p = pool, subscriptionId, now = new Date(), days = 30) {
  await ensureLifecycleSchema(p);
  const r = await p.query(
    `update fair_subscriptions
        set status = 'active',
            grace_ends_at = null,
            last_payment_failed_at = null,
            warning_72h_sent_at = null,
            warning_24h_sent_at = null,
            ends_at = greatest(coalesce(ends_at, $2), $2) + ($3)::int * interval '1 day'
      where id = $1 and status in ('active','past_due','expired')
      returning id, status, ends_at, partner_id`,
    [subscriptionId, now, days],
  );
  const sub = r.rows[0] || null;
  if (sub?.partner_id) await resumePartnerBooks(p, sub.partner_id, now);
  return sub;
}

async function notifySubscription(sub, planName, hoursLeft) {
  if (!emailConfigured() || !sub.buyer_email) return false;
  const mail = expiryWarningEmail({
    name: sub.buyer_name,
    title: planName ? `Plano ${planName}` : 'Assinatura Kulera+',
    endsAt: sub.ends_at,
    hoursLeft,
    kind: 'subscription',
    link: `${SITE_BASE()}/planos.html`,
  });
  const res = await sendEmail({ to: sub.buyer_email, ...mail });
  return Boolean(res.ok);
}

/** Passa assinaturas vencidas a past_due, expira após a tolerância e avisa 72h/24h antes. */
export async function processSubscriptions(p = pool, now = new Date()) {
  await ensureLifecycleSchema(p);
  const out = { warnings72: 0, warnings24: 0, pastDue: 0, expired: 0, suspendedBooks: 0 };
  const rows = (await p.query(
    `select s.id, s.status, s.ends_at, s.grace_ends_at, s.buyer_name, s.buyer_email,
            s.warning_72h_sent_at, s.warning_24h_sent_at, s.partner_id, pl.name as plan_name
       from fair_subscriptions s
       left join fair_plans pl on pl.id = s.plan_id
      where s.status in ('active','past_due')
      order by s.ends_at asc`,
  )).rows;

  for (const sub of rows) {
    const endsAt = new Date(sub.ends_at);
    if (sub.status === 'active') {
      if (endsAt.getTime() <= now.getTime()) {
        const graceEndsAt = graceDeadline(endsAt);
        await p.query(
          `update fair_subscriptions
              set status = 'past_due',
                  grace_ends_at = coalesce(grace_ends_at, ends_at + ($2)::int * interval '1 day')
            where id = $1 and status = 'active'`,
          [sub.id, SUBSCRIPTION_GRACE_DAYS],
        );
        out.pastDue++;
        if (emailConfigured() && sub.buyer_email) {
          const mail = subscriptionFailedEmail({
            name: sub.buyer_name,
            graceEndsAt,
            link: `${SITE_BASE()}/planos.html`,
          });
          try {
            await sendEmail({ to: sub.buyer_email, ...mail });
          } catch {}
        }
        continue;
      }
      const due = warningDue(endsAt, now, {
        h72: Boolean(sub.warning_72h_sent_at),
        h24: Boolean(sub.warning_24h_sent_at),
      });
      if (due) {
        const sent = await notifySubscription(sub, sub.plan_name, due);
        if (sent) {
          await p.query(
            `update fair_subscriptions set ${due === 24 ? 'warning_24h_sent_at' : 'warning_72h_sent_at'} = $2 where id = $1`,
            [sub.id, now],
          );
          if (due === 24) out.warnings24++;
          else out.warnings72++;
        }
      }
      continue;
    }

    // past_due: mantém acesso durante a tolerância; suspende depois.
    const grace = sub.grace_ends_at
      ? new Date(sub.grace_ends_at)
      : graceDeadline(endsAt);
    if (grace.getTime() <= now.getTime()) {
      await p.query(
        `update fair_subscriptions set status = 'expired' where id = $1 and status = 'past_due'`,
        [sub.id],
      );
      out.expired++;
      if (sub.partner_id) {
        out.suspendedBooks += await suspendPartnerBooks(p, sub.partner_id, now, 'subscription_expired');
      }
    }
  }
  return out;
}

/** Avisos 72h/24h antes de um crédito expirar (livros activos por crédito). */
export async function sendCreditWarnings(p = pool, now = new Date()) {
  await ensureLifecycleSchema(p);
  const out = { warnings72: 0, warnings24: 0 };
  if (!emailConfigured()) return out;
  const rows = (await p.query(
    `select b.id, b.title, b.active_until, b.warning_72h_sent_at, b.warning_24h_sent_at,
            pt.name as partner_name, pt.email as partner_email
       from fair_books b
       join fair_partners pt on pt.id = b.partner_id
      where b.status = 'published'
        and b.active_until > $1
        and b.active_until <= $1 + ($2)::int * interval '1 hour'
        and not exists (
          select 1 from fair_subscriptions s
           where s.partner_id = b.partner_id
             and (
               (s.status = 'active' and s.ends_at > $1)
               or (s.status = 'past_due'
                   and coalesce(s.grace_ends_at, s.ends_at + ($3)::int * interval '1 day') > $1)
             )
        )
      order by b.active_until asc`,
    [now, EXPIRY_WARNING_HOURS[0], SUBSCRIPTION_GRACE_DAYS],
  )).rows;

  for (const book of rows) {
    if (!book.partner_email) continue;
    const due = warningDue(new Date(book.active_until), now, {
      h72: Boolean(book.warning_72h_sent_at),
      h24: Boolean(book.warning_24h_sent_at),
    });
    if (!due) continue;
    const mail = expiryWarningEmail({
      name: book.partner_name,
      title: book.title,
      endsAt: book.active_until,
      hoursLeft: due,
      kind: 'credit',
      link: `${SITE_BASE()}/parceiros-portal.html`,
    });
    const res = await sendEmail({ to: book.partner_email, ...mail });
    if (!res.ok) continue;
    await p.query(
      `update fair_books set ${due === 24 ? 'warning_24h_sent_at' : 'warning_72h_sent_at'} = $2 where id = $1`,
      [book.id, now],
    );
    if (due === 24) out.warnings24++;
    else out.warnings72++;
  }
  return out;
}

/** Manutenção diária (cron): assinaturas, créditos e avisos. */
export async function runDailyMaintenance(p = pool, now = new Date()) {
  await ensureLifecycleSchema(p);
  const creditsWarnings = await sendCreditWarnings(p, now);
  const subscriptions = await processSubscriptions(p, now);
  const credits = await expireCredits(p, now);
  return {
    ranAt: now.toISOString(),
    gatewayBps: GATEWAY_BPS,
    subscriptions,
    creditWarnings: creditsWarnings,
    credits,
  };
}
