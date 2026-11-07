// Sessão dos administradores.
//
// POST { action: 'login', username, password }  → abre sessão (cookie httpOnly)
// POST { action: 'logout' }                      → fecha
// POST { action: 'change_password', current, password } → recomendado, nunca obrigatório
// POST { action: 'save_bank', ... }              → dados bancários do próprio admin
// GET                                            → quem está autenticado + os seus dados bancários
//
// A chave única antiga (x-admin-key) deixa de existir.

import { pool } from '../lib/db.js';
import {
  CSRF_HEADER,
  CSRF_VALUE,
  MIN_PASSWORD_LENGTH,
  MAX_FAILS,
  bankOf,
  clearSessionCookie,
  countAdmins,
  createSession,
  destroyOtherSessions,
  destroySession,
  ensureAdminSchema,
  findUser,
  hashPassword,
  publicUser,
  recentFailures,
  recordAttempt,
  requireAdmin,
  saveBank,
  setSessionCookie,
  verifyPassword,
} from '../lib/admin-auth.js';

const bodyOf = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
};

const clientIp = (req) =>
  String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';

const USERNAME = /^[a-z0-9_-]{3,32}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    await ensureAdminSchema(pool);
  } catch (e) {
    console.error('admin.schema.error', e?.message || String(e));
    return res.status(503).json({ error: 'unavailable' });
  }

  if (req.method === 'GET') {
    const current = await requireAdmin(pool, req);
    if (!current) return res.status(401).json({ error: 'unauthorized' });
    const bank = await bankOf(pool, current.user.id).catch(() => null);
    return res.json({
      ok: true,
      user: publicUser(current.user),
      bank,
      passwordChangeRecommended: current.user.can_change_password !== false,
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // Qualquer POST do painel tem de trazer este cabeçalho. Um formulário de outro
  // site não consegue pôr cabeçalhos personalizados, e o cookie é SameSite=Lax.
  if (req.headers?.[CSRF_HEADER] !== CSRF_VALUE) return res.status(403).json({ error: 'csrf' });

  const body = bodyOf(req.body);
  const ip = clientIp(req);

  switch (body.action) {
    case 'login': {
      const username = String(body.username ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');
      if (!USERNAME.test(username)) return res.status(400).json({ error: 'invalid_username' });
      if (!password) return res.status(400).json({ error: 'invalid_password' });

      if ((await countAdmins(pool)) === 0) {
        // Sem administradores criados: diz-se à pessoa para correr o seed. Não se
        // inventa senha nenhuma no código.
        return res.status(503).json({ error: 'admin_not_seeded' });
      }

      if ((await recentFailures(pool, username, ip)) >= MAX_FAILS) {
        return res.status(429).json({ error: 'too_many_attempts' });
      }

      const user = await findUser(pool, username);
      const ok = Boolean(user) && user.status === 'active' && verifyPassword(password, user.password_hash);
      if (!ok) {
        await recordAttempt(pool, username, ip, false);
        // Mensagem igual para utilizador inexistente e senha errada.
        return res.status(401).json({ error: 'invalid_credentials' });
      }

      await recordAttempt(pool, username, ip, true);
      const { token, expires } = await createSession(pool, user.id);
      setSessionCookie(res, token);
      await pool.query('update fair_admin_users set last_login_at = now() where id = $1', [user.id]);
      return res.json({
        ok: true,
        user: publicUser(user),
        expiresAt: expires,
        passwordChangeRecommended: user.can_change_password !== false,
      });
    }

    case 'logout': {
      const current = await requireAdmin(pool, req);
      if (current) await destroySession(pool, current.token);
      clearSessionCookie(res);
      return res.json({ ok: true });
    }

    case 'change_password': {
      const current = await requireAdmin(pool, req);
      if (!current) return res.status(401).json({ error: 'unauthorized' });
      // A senha da TecnoIncubadora não se altera: a conta fica marcada como bloqueada.
      if (current.user.can_change_password === false) return res.status(403).json({ error: 'password_locked' });
      if (!verifyPassword(String(body.current ?? ''), current.user.password_hash)) {
        return res.status(401).json({ error: 'invalid_credentials' });
      }
      const next = String(body.password ?? '');
      if (next.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: 'password_too_short' });
      if (next === String(body.current ?? '')) return res.status(400).json({ error: 'password_unchanged' });
      await pool.query('update fair_admin_users set password_hash = $2 where id = $1', [
        current.user.id,
        hashPassword(next),
      ]);
      await destroyOtherSessions(pool, current.user.id, current.token);
      return res.json({ ok: true });
    }

    case 'save_bank': {
      const current = await requireAdmin(pool, req);
      if (!current) return res.status(401).json({ error: 'unauthorized' });
      const bank = await saveBank(pool, current.user.id, body.bank ?? {}, ip);
      return res.json({ ok: true, bank });
    }

    default:
      return res.status(400).json({ error: 'invalid_action' });
  }
}
