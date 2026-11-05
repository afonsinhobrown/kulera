import { pool } from '../lib/db.js';
import { getAdminKeyFromDb } from '../lib/payments.js';
import { runDailyMaintenance } from '../lib/lifecycle.js';

// Manutenção diária (Vercel Cron): expira créditos, processa tolerância de assinaturas
// e envia avisos de expiração (72h/24h).
// Protecção: Authorization: Bearer <CRON_SECRET> (enviado pela Vercel) ou x-admin-key.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const secret = String(process.env.CRON_SECRET || '').trim();
  const auth = String(req.headers?.authorization || '');
  const adminKey = String(req.headers?.['x-admin-key'] || '');
  const bearerOk = Boolean(secret) && auth === `Bearer ${secret}`;
  let adminOk = false;
  if (!bearerOk && adminKey) {
    const expected = await getAdminKeyFromDb();
    adminOk = adminKey === expected;
  }
  if (!bearerOk && !adminOk) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const result = await runDailyMaintenance(pool, new Date());
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error('cron.error', e?.message || String(e));
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
}
