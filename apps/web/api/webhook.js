import { createHash } from 'node:crypto';
import { pool } from '../lib/db.js';
import { computeSplit } from '../lib/split.js';
import { APP_BPS, EDITORS_BPS } from '../lib/pricing.js';
import { EVENT_STATUS, verifySignature } from '../lib/paysuite.js';

export const config = { api: { bodyParser: false } }; // precisamos do corpo bruto para validar a assinatura

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const raw = await readRaw(req);
  if (!verifySignature(raw, req.headers['x-signature'], process.env.PAYSUITE_WEBHOOK_SECRET)) {
    return res.status(401).json({ ok: false, result: 'invalid_signature' });
  }
  let payload;
  try { payload = JSON.parse(raw); } catch { return res.status(400).json({ ok: false, result: 'invalid_json' }); }

  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const target = EVENT_STATUS[payload?.event];
  if (!target) return res.status(200).json({ ok: true, result: 'ignored_event' });
  const providerId = data?.id != null ? String(data.id) : null;
  const reference = data?.reference != null ? String(data.reference) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'select id, status from fair_orders where provider_payment_id = $1 or reference = $2 for update', [providerId, reference]);
    const order = found.rows[0];
    if (!order) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, result: 'order_not_found' }); } // PaySuite pode reenviar

    const eventKey = createHash('sha256').update(raw).digest('hex');
    const isNew = await client.query(
      'insert into fair_events (event_key, event_type, payload) values ($1,$2,$3) on conflict do nothing', [eventKey, payload.event, raw]);
    if (isNew.rowCount === 0) { await client.query('COMMIT'); return res.status(200).json({ ok: true, result: 'duplicate' }); }

    if (target === 'paid') {
      // Confirmação verificada vence «falhado/cancelado»; «pago» nunca recua.
      const upd = await client.query(
        `update fair_orders set status = 'paid', paid_at = coalesce(paid_at, now()),
           provider_payment_id = coalesce(provider_payment_id, $2) where id = $1 and status <> 'paid'`, [order.id, providerId]);
      if (upd.rowCount === 1) { // acabou de passar a «pago»: regista a divisão da receita
        const r = await client.query(
          `select o.book_id, o.amount_minor, o.plan_id, o.type, b.partner_id, b.kind, b.content_html from fair_orders o
             left join fair_books b on b.id = o.book_id where o.id = $1`, [order.id]);
        const x = r.rows[0];
        if (x?.type === 'publication' && x?.book_id) {
          // Taxa de publicação: 100% para a Kulera App; publica o livro se já tiver conteúdo.
          await client.query(
            `insert into fair_publication_fees (order_id, book_id, partner_id, amount_minor, paid_at)
             values ($1,$2,$3,$4,now()) on conflict (order_id) do update set paid_at = coalesce(fair_publication_fees.paid_at, now())`,
            [order.id, x.book_id, x.partner_id, x.amount_minor]);
          await client.query(
            `update fair_books set publication_fee_paid_at = coalesce(publication_fee_paid_at, now()),
               status = case when status = 'published' then status
                             when kind = 'physical' or content_html is not null then 'published'
                             else status end
             where id = $1`, [x.book_id]);
        } else if (x?.book_id) {
          // Venda: 20% App + 10% Editores + 70% parceiro; livros próprios: 20% App + 80% Editores.
          const sp = computeSplit(Number(x.amount_minor), !!x.partner_id);
          const editorsBps = x.partner_id ? EDITORS_BPS : 10000 - APP_BPS;
          const commissionBps = APP_BPS + editorsBps; // coluna antiga: total que fica na Kulera
          await client.query(
            `insert into fair_sales (order_id, book_id, partner_id, gross_minor, commission_bps, commission_minor, partner_minor, app_bps, editors_bps, app_minor, editors_minor)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`,
            [order.id, x.book_id, x.partner_id, x.amount_minor, commissionBps, sp.app + sp.editors, sp.partner, APP_BPS, editorsBps, sp.app, sp.editors]);
        }
        if (x?.type === 'subscription' && x?.plan_id) {
          const pl = await client.query("select interval from fair_plans where id=$1", [x.plan_id]);
          const days = pl.rows[0]?.interval === 'year' ? 365 : 30;
          const buyer = await client.query("select buyer_name,buyer_phone,buyer_email,(to_jsonb(fair_orders)->>'partner_id')::uuid as partner_id from fair_orders where id=$1", [order.id]);
          const b = buyer.rows[0];
          if (b) {
            await client.query('alter table fair_subscriptions add column if not exists partner_id uuid');
            // Renovação: começa no fim do período activo do parceiro (se existir).
            const cur = b.partner_id ? await client.query("select max(ends_at) e from fair_subscriptions where partner_id=$1 and status='active' and ends_at>now()", [b.partner_id]) : { rows: [] };
            const start = cur.rows[0]?.e || null;
            await client.query(`insert into fair_subscriptions (buyer_name,buyer_phone,buyer_email,plan_id,order_id,status,starts_at,ends_at,partner_id)
              values ($1,$2,$3,$4,$5,'active',coalesce($7::timestamptz,now()),coalesce($7::timestamptz,now())+($6)::interval,$8)
              on conflict do nothing`, [b.buyer_name, b.buyer_phone, b.buyer_email, x.plan_id, order.id, days + ' days', start, b.partner_id]);
          }
        }
      }
    } else {
      await client.query("update fair_orders set status = $2 where id = $1 and status in ('created','pending')", [order.id, target]);
    }
    await client.query('COMMIT');
    return res.status(200).json({ ok: true, result: 'applied' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('webhook.error', String(error));
    return res.status(500).json({ ok: false });
  } finally { client.release(); }
}
