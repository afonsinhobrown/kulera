import { pool } from '../lib/db.js';
import { isSandbox, settleOrderPaid } from '../lib/payments.js';
import { getPaymentStatus } from '../lib/paysuite.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const t = String(req.query?.t ?? req.body?.token ?? '');
  if (!/^[a-f0-9]{64}$/.test(t)) return res.status(400).json({ error: 'invalid_token' });

  let order;
  try {
    const { rows } = await pool.query(
      'select id, status, type, provider_payment_id, sandbox, amount_minor, currency from fair_orders where token = $1',
      [t],
    );
    order = rows[0];
  } catch {
    const { rows } = await pool.query('select status, type from fair_orders where token = $1', [t]);
    order = rows[0];
  }
  if (!order) return res.status(404).json({ error: 'not_found' });

  // Simulação explícita em modo Sandbox (quando a conta PaySuite ainda não é empresarial ou em testes).
  if (req.method === 'POST' && req.body?.simulate && order.id) {
    const sandboxAllowed = order.sandbox === true || String(order.provider_payment_id || '').startsWith('sim_') || (await isSandbox());
    if (!sandboxAllowed) return res.status(403).json({ error: 'sandbox_only' });
    const simTarget = req.body.simulate === 'paid' ? 'paid' : 'failed';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (simTarget === 'paid') {
        await settleOrderPaid(client, order.id, order.provider_payment_id || 'sim_manual');
        order.status = 'paid';
      } else {
        await client.query("update fair_orders set status = 'failed' where id = $1 and status in ('created','pending')", [order.id]);
        order.status = 'failed';
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('status.simulate.error', String(e));
      return res.status(500).json({ error: 'simulate_failed' });
    } finally {
      client.release();
    }
    return res.json({ status: order.status, type: order.type || 'book', sandbox: true });
  }

  // Verificação activa na PaySuite caso o webhook ainda não tenha chegado.
  if (order.status === 'pending' && order.id && order.provider_payment_id && !String(order.provider_payment_id).startsWith('sim_')) {
    const remoteStatus = await getPaymentStatus(order.provider_payment_id);
    if (remoteStatus === 'paid') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await settleOrderPaid(client, order.id, order.provider_payment_id);
        await client.query('COMMIT');
        order.status = 'paid';
      } catch {
        await client.query('ROLLBACK').catch(() => {});
      } finally {
        client.release();
      }
    } else if (remoteStatus === 'failed' || remoteStatus === 'cancelled') {
      await pool.query("update fair_orders set status = $2 where id = $1 and status in ('created','pending')", [order.id, remoteStatus]).catch(() => {});
      order.status = remoteStatus;
    }
  }

  res.json({
    status: order.status,
    type: order.type || 'book',
    sandbox: Boolean(order.sandbox || String(order.provider_payment_id || '').startsWith('sim_')),
  });
}
