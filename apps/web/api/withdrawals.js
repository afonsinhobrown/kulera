// Saques (só administração). O pedido de saque de editora vai para os dois admins.
//
// GET  → modo vigente, saldos dos sócios, pedidos pendentes e histórico
// POST { action: 'request', kind, entity, entityId, amount, extraordinary, note }
// POST { action: 'divide_profit', amount, extraordinary, note }
// POST { action: 'approve' | 'reject', id }
// POST { action: 'pay', id }
// POST { action: 'set_mode', mode }            → só a TecnoIncubadora

import { pool } from '../lib/db.js';
import { CSRF_HEADER, CSRF_VALUE, ensureAdminSchema, requireAdmin } from '../lib/admin-auth.js';
import { ZERO_ID, balanceOf, ensureFinanceSchema } from '../lib/finance.js';
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
} from '../lib/withdrawals.js';

const bodyOf = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
};

const cents = (v) => Math.round(Number(v));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    await ensureAdminSchema(pool);
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
    for (const entity of PROFIT_ENTITIES) {
      saldos[entity] = await balanceOf(pool, { entity });
    }
    return res.json({ ok: true, mode, admin, balances: saldos, pending, recent });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (req.headers?.[CSRF_HEADER] !== CSRF_VALUE) return res.status(403).json({ error: 'csrf' });

  const b = bodyOf(req.body);

  try {
    switch (b.action) {
      case 'request': {
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

      case 'divide_profit': {
        // A divisão societária é 50/50 entre os dois donos, num único pedido.
        const w = await createProfitDivision(pool, {
          totalMinor: cents(b.amount),
          requestedBy: admin,
          extraordinary: b.extraordinary === true,
          note: b.note ?? null,
        });
        return res.json({ ok: true, withdrawal: w, mode: await withdrawalMode(pool) });
      }

      case 'approve':
      case 'reject': {
        const out = await decideWithdrawal(pool, {
          id: String(b.id || ''),
          admin,
          decision: b.action === 'approve' ? 'approve' : 'reject',
        });
        return res.json({ ok: true, ...out });
      }

      case 'pay': {
        const w = await payWithdrawal(pool, { id: String(b.id || ''), admin });
        return res.json({ ok: true, withdrawal: w });
      }

      case 'set_mode': {
        const mode = await setWithdrawalMode(pool, { admin, mode: b.mode });
        return res.json({ ok: true, mode });
      }

      default:
        return res.status(400).json({ error: 'invalid_action' });
    }
  } catch (e) {
    // Regras de negócio (período, saldo, autorização) devolvem a mensagem ao painel.
    return res.status(400).json({ error: 'rule', detail: String(e?.message || e) });
  }
}
