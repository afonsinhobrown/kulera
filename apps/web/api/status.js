import { pool } from '../lib/db.js';
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const t = String(req.query?.t ?? '');
  if (!/^[a-f0-9]{64}$/.test(t)) return res.status(400).json({ error: 'invalid_token' });
  const { rows } = await pool.query('select status from fair_orders where token = $1', [t]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ status: rows[0].status });
}
