// Saques — servidos por /api/admin?format=withdrawals (GET) e pelas acções POST de saque.
// Vive aqui dentro para não gastar mais funções serverless no deployment.

import { ZERO_ID, balanceOf, ensureFinanceSchema } from './finance.js';
import {
  KINDS,
  PROFIT_ENTITIES,
  createProfitDivision,
  createWithdrawal,
  decideWithdrawal,
  ensureWithdrawalSchema,
  listWithdrawals,
  payWithdrawal,
  setWithdrawalMode,
  withdrawalMode,
} from './withdrawals.js';
import { CSRF_HEADER, CSRF_VALUE, requireAdmin } from './admin-auth.js';

export const WITHDRAWAL_ACTIONS = [
  'withdrawal_request',
  'withdrawal_divide',
  'withdrawal_approve',
  'withdrawal_reject',
  'withdrawal_pay',
  'withdrawal_set_mode',
];

const cents = (v) => Math.round(Number(v));

export async function handleWithdrawals(req, res, pool) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    await ensureFinanceSchema(pool);
    await ensureWithdrawalSchema(pool);
  } catch (e) {
    console.error('withdrawals.schema', e?.message || String(e));
    return res.status(503).json({ error: 'unavailable' });
  }

  const current = await requireAdmin(pool, req);
  if (!current) return res.status(401).json({ error: 'unauthorized' });
  const admin = current.user.username;

  if (req.method === 'GET') {
    const [mode, pending, recent] = await Promise.all([
      withdrawalMode(pool),
      listWithdrawals(pool, { status: 'requested' }),
      listWithdrawals(pool, { limit: 100 }),
    ]);
    const saldos = {};
    for (const entity of PROFIT_ENTITIES) saldos[entity] = await balanceOf(pool, { entity });
    return res.json({ ok: true, mode, admin, balances: saldos, pending, recent });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (req.headers?.[CSRF_HEADER] !== CSRF_VALUE) return res.status(403).json({ error: 'csrf' });

  const b = req.body && typeof req.body === 'object' ? req.body : {};

  try {
    switch (b.action) {
      case 'withdrawal_request': {
        const kind = b.kind === KINDS.PROFIT ? KINDS.PROFIT : KINDS.PUBLISHER;
        const entity = kind === KINDS.PUBLISHER ? 'publisher' : String(b.entity || '');
        const entityId = kind === KINDS.PUBLISHER ? String(b.entityId || '') : ZERO_ID;
        if (kind === KINDS.PUBLISHER && !/^[0-9a-f-]{36}$/.test(entityId)) {
          return res.status(400).json({ error: 'invalid_publisher' });
        }
        const w = await createWithdrawal(pool, {
          kind,
          entity,
          entityId,
          amountMinor: cents(b.amount),
          requestedBy: admin,
          extraordinary: b.extraordinary === true,
          note: b.note ?? null,
        });
        return res.json({ ok: true, withdrawal: w, mode: await withdrawalMode(pool) });
      }

      case 'withdrawal_divide': {
        const w = await createProfitDivision(pool, {
          totalMinor: cents(b.amount),
          requestedBy: admin,
          extraordinary: b.extraordinary === true,
          note: b.note ?? null,
        });
        return res.json({ ok: true, withdrawal: w, mode: await withdrawalMode(pool) });
      }

      case 'withdrawal_approve':
      case 'withdrawal_reject': {
        const out = await decideWithdrawal(pool, {
          id: String(b.id || ''),
          admin,
          decision: b.action === 'withdrawal_approve' ? 'approve' : 'reject',
        });
        return res.json({ ok: true, ...out });
      }

      case 'withdrawal_pay': {
        const w = await payWithdrawal(pool, { id: String(b.id || ''), admin });
        return res.json({ ok: true, withdrawal: w });
      }

      case 'withdrawal_set_mode': {
        const mode = await setWithdrawalMode(pool, { admin, mode: b.mode });
        return res.json({ ok: true, mode });
      }

      default:
        return res.status(400).json({ error: 'invalid_action' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'rule', detail: String(e?.message || e) });
  }
}
