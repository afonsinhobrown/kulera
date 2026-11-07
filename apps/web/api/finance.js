// Painel financeiro: dados do relatório por período.
//
// GET ?period=week|month|year|all|custom&from=...&to=...
// Devolve totais, vendas, saldo por editora no livro, saldo por autor no livro,
// saques e saldos das entidades.

import { pool } from '../lib/db.js';
import { CSRF_HEADER, CSRF_VALUE, ensureAdminSchema, requireAdmin } from '../lib/admin-auth.js';
import { ensureFinanceSchema } from '../lib/finance.js';
import { ensureWithdrawalSchema } from '../lib/withdrawals.js';
import { PERIODS, buildReport, resolvePeriod } from '../lib/report.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    await ensureAdminSchema(pool);
    await ensureFinanceSchema(pool);
    await ensureWithdrawalSchema(pool);
  } catch (e) {
    console.error('finance.schema', e?.message || String(e));
    return res.status(503).json({ error: 'unavailable' });
  }

  const current = await requireAdmin(pool, req);
  if (!current) return res.status(401).json({ error: 'unauthorized' });

  if (req.method !== 'GET') {
    if (req.headers?.[CSRF_HEADER] !== CSRF_VALUE) return res.status(403).json({ error: 'csrf' });
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const q = req.query || {};
  const period = PERIODS.includes(String(q.period)) ? String(q.period) : 'month';
  const range = resolvePeriod(period, { from: q.from ?? null, to: q.to ?? null });

  try {
    const report = await buildReport(pool, range);
    return res.json({ ok: true, period: { key: period, label: range.label, from: range.from, to: range.to }, ...report });
  } catch (e) {
    console.error('finance.report', e?.message || String(e));
    return res.status(500).json({ error: 'report_failed' });
  }
}
