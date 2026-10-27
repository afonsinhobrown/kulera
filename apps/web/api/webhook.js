import { createHash } from 'node:crypto';
import { pool } from '../lib/db.js';
import { computeSplit } from '../lib/split.js';
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
          `select o.book_id, o.amount_minor, b.partner_id, p.commission_bps from fair_orders o
             left join fair_books b on b.id = o.book_id left join fair_partners p on p.id = b.partner_id where o.id = $1`, [order.id]);
        const x = r.rows[0];
        if (x?.book_id) {
          const bps = x.partner_id ? x.commission_bps : 10000; // livro da Kulera: 100% Kulera
          const sp = computeSplit(Number(x.amount_minor), bps);
          await client.query(
            `insert into fair_sales (order_id, book_id, partner_id, gross_minor, commission_bps, commission_minor, partner_minor)
             values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
            [order.id, x.book_id, x.partner_id, x.amount_minor, bps, sp.commission, sp.partner]);
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
