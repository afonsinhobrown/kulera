// Conta do autor.
//
// POST { action: 'signup', email, password, name }
// POST { action: 'login', email, password }
// POST { action: 'logout' }
// POST { action: 'complete', nuit, bi, shareBps, payoutMethod, payoutAccount, payoutHolder }
// GET  → quem está autenticado, o que falta e se pode usar a conta
//
// Enquanto faltar algum dado, a única coisa que a conta pode fazer é completá-los.

import { pool } from '../lib/db.js';
import { CSRF_HEADER, CSRF_VALUE } from '../lib/admin-auth.js';
import {
  AUTHOR_COOKIE,
  authorByToken,
  authorCookie,
  completeAuthorProfile,
  createAuthorAccount,
  ensureAuthorSchema,
  isComplete,
  loginAuthor,
  logoutAuthor,
  missingFields,
  readAuthorCookie,
} from '../lib/author-auth.js';
import { ensureFinanceSchema } from '../lib/finance.js';

const bodyOf = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
};

const publicAuthor = (a) => ({
  id: a.author_id,
  name: a.full_name,
  email: a.email,
  nuit: a.nuit ? String(a.nuit).replace(/^(\d{3})\d+(\d{2})$/, '$1***$2') : null,
  shareBps: Number(a.default_share_bps || 0),
  payoutMethod: a.payout_method || null,
  payoutAccount: a.payout_account ? '••••' + String(a.payout_account).slice(-4) : null,
  isRelated: Boolean(a.is_related),
});

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    await ensureFinanceSchema(pool);
    await ensureAuthorSchema(pool);
  } catch (e) {
    console.error('author.schema', e?.message || String(e));
    return res.status(503).json({ error: 'unavailable' });
  }

  const token = readAuthorCookie(req);
  const current = await authorByToken(pool, token).catch(() => null);
  const missing = current ? missingFields(current) : null;

  if (req.method === 'GET') {
    if (!current) return res.status(401).json({ error: 'unauthorized' });
    return res.json({
      ok: true,
      author: publicAuthor(current),
      missing,
      complete: isComplete(current),
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (req.headers?.[CSRF_HEADER] !== CSRF_VALUE) return res.status(403).json({ error: 'csrf' });

  const body = bodyOf(req.body);
  const action = String(body.action || '');

  // Portão: com dados em falta, só se completa ou se sai.
  if (current && !isComplete(current) && !['complete', 'logout'].includes(action)) {
    return res.status(428).json({ error: 'profile_incomplete', missing });
  }

  switch (action) {
    case 'signup': {
      try {
        await createAuthorAccount(pool, { email: body.email, password: body.password, fullName: body.name });
        return res.json({ ok: true, next: 'complete' });
      } catch (e) {
        return res.status(400).json({ error: 'invalid', detail: String(e?.message || e) });
      }
    }

    case 'login': {
      const out = await loginAuthor(pool, { email: body.email, password: body.password });
      if (!out) return res.status(401).json({ error: 'invalid_credentials' });
      res.setHeader('Set-Cookie', authorCookie(out.token, 12 * 60 * 60));
      const faltas = missingFields(out.author);
      return res.json({ ok: true, complete: faltas.length === 0, missing: faltas, author: publicAuthor(out.author) });
    }

    case 'logout': {
      await logoutAuthor(pool, token);
      res.setHeader('Set-Cookie', authorCookie('', 0));
      return res.json({ ok: true });
    }

    case 'complete': {
      if (!current) return res.status(401).json({ error: 'unauthorized' });
      try {
        const author = await completeAuthorProfile(pool, current.author_id, {
          nuit: body.nuit,
          bi: body.bi,
          shareBps: body.shareBps,
          payoutMethod: body.payoutMethod,
          payoutAccount: body.payoutAccount,
          payoutHolder: body.payoutHolder,
        });
        return res.json({ ok: true, complete: true, author: { name: author.full_name, shareBps: Number(author.default_share_bps) } });
      } catch (e) {
        return res.status(400).json({ error: 'invalid', detail: String(e?.message || e) });
      }
    }

    default:
      return res.status(400).json({ error: 'invalid_action' });
  }
}

export { AUTHOR_COOKIE };
