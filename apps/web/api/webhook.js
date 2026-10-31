import { createHash } from 'node:crypto';
import { pool } from '../lib/db.js';
import { settleOrderPaid } from '../lib/payments.js';
import { onOrderPaid } from '../lib/marketing.js';
import { releaseHold } from '../lib/reader.js';
import { EVENT_STATUS, verifySignature } from '../lib/paysuite.js';

export const config = { api: { bodyParser: false } }; // precisamos do corpo bruto para validar a assinatura

async function readRaw(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const raw = await readRaw(req);
  const sigHeader = req.headers?.['x-signature'] || req.headers?.['x-paysuite-signature'] || req.headers?.['X-Signature'];
  if (!verifySignature(raw, sigHeader, process.env.PAYSUITE_WEBHOOK_SECRET)) {
    return res.status(401).json({ ok: false, result: 'invalid_signature' });
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return res.status(400).json({ ok: false, result: 'invalid_json' });
  }

  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const eventName = payload?.event || payload?.type;
  const target = EVENT_STATUS[eventName];
  if (!target) return res.status(200).json({ ok: true, result: 'ignored_event' });
  const providerId = (data?.id ?? data?.payment_id ?? data?.transaction_id) != null
    ? String(data.id ?? data.payment_id ?? data.transaction_id)
    : null;
  const reference = (data?.reference ?? data?.external_reference) != null
    ? String(data.reference ?? data.external_reference)
    : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'select id, status from fair_orders where provider_payment_id = $1 or reference = $2 for update',
      [providerId, reference],
    );
    const order = found.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, result: 'order_not_found' });
    }

    const eventKey = createHash('sha256').update(raw).digest('hex');
    const isNew = await client.query(
      'insert into fair_events (event_key, event_type, payload) values ($1,$2,$3) on conflict do nothing',
      [eventKey, eventName, raw],
    );
    if (isNew.rowCount === 0) {
      await client.query('COMMIT');
      return res.status(200).json({ ok: true, result: 'duplicate' });
    }

    if (target === 'paid') {
      await settleOrderPaid(client, order.id, providerId);
    } else {
      await client.query(
        "update fair_orders set status = $2 where id = $1 and status in ('created','pending')",
        [order.id, target],
      );
    }
    await client.query('COMMIT');
    if (target === 'paid') await onOrderPaid(pool, order.id).catch(() => {});
    else await releaseHold(pool, order.id).catch(() => {});
    return res.status(200).json({ ok: true, result: 'applied' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('webhook.error', String(error));
    return res.status(500).json({ ok: false });
  } finally {
    client.release();
  }
}
