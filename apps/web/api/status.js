import { pool } from '../lib/db.js';
import { ensurePaymentSchema, isSandbox, settleOrderPaid, getPaysuiteTokenFromDb, resolveSiteUrl } from '../lib/payments.js';
import { getPaymentStatus } from '../lib/paysuite.js';
import { recoverAccess } from '../lib/recovery.js';
import { fingerprintHash, isDeviceKey, deviceHash, requestDeviceChange, sanitizeDeviceInfo } from '../lib/device.js';
import { onOrderPaid, unsubscribe } from '../lib/marketing.js';
import { verifyUnsubscribe } from '../lib/email.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'POST' && req.body?.action === 'recover') {
    const ip = String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress || '';
    try {
      const result = await recoverAccess({ pool, phone: req.body?.phone, name: req.body?.name, ip });
      return res.status(result.status).json(result.body);
    } catch (e) {
      console.error('recovery.error', e?.message || String(e));
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  if (req.method === 'POST' && req.body?.action === 'device_request') {
    const token = String(req.body?.token ?? '');
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'invalid_token' });
    if (!isDeviceKey(req.body?.deviceKey)) return res.status(400).json({ error: 'invalid_device' });
    try {
      await ensurePaymentSchema();
      const { rows } = await pool.query('select id, status, type, sandbox, device_key_hash from fair_orders where token=$1', [token]);
      const order = rows[0];
      if (!order) return res.status(404).json({ error: 'not_found' });
      if (order.status !== 'paid' || order.type === 'physical') return res.status(403).json({ error: 'forbidden' });
      if (order.sandbox && !(await isSandbox())) {
        return res.status(403).json({
          error: 'sandbox_only',
          message: 'Este link foi criado em modo sandbox e só funciona enquanto o modo sandbox estiver activo.',
        });
      }
      const result = await requestDeviceChange(
        pool,
        order,
        deviceHash(req.body.deviceKey),
        fingerprintHash(req.body.fingerprint),
        sanitizeDeviceInfo(req.body.deviceInfo),
      );
      if (result.status === 'mismatch') return res.status(409).json({ error: 'device_mismatch' });
      return res.json({
        ok: true,
        status: result.status === 'requested' ? 'pending' : result.status,
        requestId: result.id ?? null,
      });
    } catch (e) {
      console.error('device.request.error', e?.message || String(e));
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  if (req.method === 'POST' && req.body?.action === 'unsubscribe') {
    const email = String(req.body?.email ?? '');
    if (!verifyUnsubscribe(email, req.body?.sig)) return res.status(403).json({ error: 'invalid_signature' });
    try {
      await unsubscribe(pool, email);
      return res.json({ ok: true });
    } catch (e) {
      console.error('unsubscribe.error', e?.message || String(e));
      return res.status(500).json({ error: 'internal_error' });
    }
  }

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

  if (order.sandbox && !(await isSandbox())) {
    return res.status(403).json({
      error: 'sandbox_only',
      message: 'Este link foi criado em modo sandbox e só funciona enquanto o modo sandbox estiver activo.',
    });
  }

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
      if (simTarget === 'paid') await onOrderPaid(pool, order.id).catch(() => {});
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
    const remoteStatus = await getPaymentStatus(order.provider_payment_id, await getPaysuiteTokenFromDb());
    if (remoteStatus === 'paid') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await settleOrderPaid(client, order.id, order.provider_payment_id);
        await client.query('COMMIT');
        order.status = 'paid';
        await onOrderPaid(pool, order.id).catch(() => {});
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

  let qr = null;
  if (req.query?.qr === '1' && order.status === 'paid' && (order.type || 'book') !== 'physical') {
    try {
      const QRCode = (await import('qrcode')).default;
      qr = await QRCode.toDataURL(`${resolveSiteUrl(req)}/ler.html?t=${t}`, {
        margin: 1,
        width: 240,
        errorCorrectionLevel: 'M',
      });
    } catch (e) {
      console.error('qr.error', e?.message || String(e));
    }
  }

  res.json({
    status: order.status,
    type: order.type || 'book',
    sandbox: Boolean(order.sandbox || String(order.provider_payment_id || '').startsWith('sim_')),
    ...(qr ? { qr } : {}),
  });
}
