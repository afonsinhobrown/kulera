import { createHash } from 'node:crypto';
import { ensurePaymentSchema } from './payments.js';

export const DEVICE_KEY_RE = /^[a-f0-9]{64}$/;

export const isDeviceKey = (v) => DEVICE_KEY_RE.test(String(v ?? ''));

export const deviceHash = (v) => createHash('sha256').update(String(v ?? '')).digest('hex');

export const fingerprintHash = (v) => {
  const raw = String(v ?? '').trim().slice(0, 512);
  return raw ? deviceHash(raw) : null;
};

const clip = (v, n) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, n);

export function sanitizeDeviceInfo(info = {}) {
  return {
    userAgent: clip(info.userAgent, 300),
    platform: clip(info.platform, 80),
    language: clip(info.language, 30),
    languages: clip(info.languages, 120),
    timezone: clip(info.timezone, 80),
    screen: clip(info.screen, 40),
    pixelRatio: clip(info.pixelRatio, 20),
    touch: info.touch === true,
  };
}

export async function bindDevice(pool, orderId, keyHash, fpHash) {
  await ensurePaymentSchema();
  const r = await pool.query(
    `update fair_orders set device_key_hash=$2, device_fingerprint_hash=$3, device_bound_at=now()
      where id=$1 and coalesce(device_key_hash,'')='' returning id`,
    [orderId, keyHash, fpHash],
  );
  return r.rowCount === 1;
}

export async function pendingDeviceChange(pool, orderId, keyHash) {
  const r = await pool.query(
    `select status from fair_device_requests
      where order_id=$1 and requested_key_hash=$2 and status='pending' limit 1`,
    [orderId, keyHash],
  );
  return Boolean(r.rows[0]);
}

export async function requestDeviceChange(pool, order, keyHash, fpHash, info) {
  await ensurePaymentSchema();
  if (!order.device_key_hash) {
    const bound = await bindDevice(pool, order.id, keyHash, fpHash);
    return { status: bound ? 'bound' : 'mismatch' };
  }
  if (order.device_key_hash === keyHash) return { status: 'already_bound' };
  if (await pendingDeviceChange(pool, order.id, keyHash)) return { status: 'pending' };

  const r = await pool.query(
    `insert into fair_device_requests (order_id, requested_key_hash, requested_fingerprint_hash, device_info)
     values ($1,$2,$3,$4::jsonb) returning id`,
    [order.id, keyHash, fpHash, JSON.stringify(info)],
  );
  return { status: 'requested', id: r.rows[0]?.id ?? null };
}

export async function approveDeviceRequest(pool, id) {
  await ensurePaymentSchema();
  const r = await pool.query(
    `select id, order_id, requested_key_hash, requested_fingerprint_hash, status
       from fair_device_requests where id=$1`,
    [id],
  );
  const req = r.rows[0];
  if (!req || req.status !== 'pending') return { ok: false, error: 'not_pending' };

  await pool.query(
    `update fair_orders set device_key_hash=$2, device_fingerprint_hash=$3, device_bound_at=now() where id=$1`,
    [req.order_id, req.requested_key_hash, req.requested_fingerprint_hash],
  );
  await pool.query(
    `update fair_device_requests set status='approved', resolved_at=now() where id=$1 and status='pending'`,
    [id],
  );
  await pool.query(
    `update fair_device_requests set status='rejected', resolved_at=now()
      where order_id=$1 and id<>$2 and status='pending'`,
    [req.order_id, id],
  );
  return { ok: true };
}

export async function rejectDeviceRequest(pool, id) {
  await ensurePaymentSchema();
  const r = await pool.query(
    `update fair_device_requests set status='rejected', resolved_at=now()
      where id=$1 and status='pending' returning id`,
    [id],
  );
  return { ok: r.rowCount === 1 };
}
