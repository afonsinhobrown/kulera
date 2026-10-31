import { randomBytes } from 'node:crypto';
import { emailConfigured, sendEmail, SITE_BASE } from './email.js';

// Validação de email (leitores e parceiros): token de 24h enviado por link.
export const newVerifyToken = () => randomBytes(32).toString('hex');

export const verifyLink = (token) => `${SITE_BASE()}/verificar.html?t=${encodeURIComponent(token)}`;

export function verificationEmail({ name, link, kind }) {
  const who = kind === 'reader' ? 'leitor' : 'parceiro';
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const html = `<!doctype html><html lang="pt"><body style="margin:0;background:#f5f7f6;font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#10242b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #d7e0de;border-radius:12px;overflow:hidden">
<tr><td style="background:#083f45;padding:18px 22px;color:#fff;font:700 22px Georgia,serif">Kulera<span style="color:#f2a93b">+</span></td></tr>
<tr><td style="padding:22px">
<h1 style="font:700 24px/1.2 Georgia,serif;margin:0 0 10px">Confirme o seu email</h1>
<p style="margin:0 0 16px;color:#33505a">Olá${first ? ' ' + first : ''}, falta um passo para activar a sua conta de ${who}. Toque no botão abaixo.</p>
<p style="margin:0 0 22px"><a href="${link}" style="display:inline-block;background:#f2a93b;color:#241700;font-weight:700;text-decoration:none;padding:13px 20px;border-radius:8px">Confirmar email</a></p>
<p style="margin:18px 0 0;font-size:14px;color:#5b747c;word-break:break-all">${link}</p>
<p style="margin:14px 0 0;font-size:13px;color:#5b747c">O link vale 24 horas. Se não criou esta conta, ignore este email.</p>
</td></tr>
<tr><td style="padding:14px 22px;background:#f5f7f6;font-size:12px;color:#5b747c">Kulera+ · não é preciso responder a este email.</td></tr>
</table></td></tr></table></body></html>`;
  return {
    subject: 'Confirme o seu email — Kulera+',
    html,
    text: `Confirme o seu email da Kulera+: ${link}`,
  };
}

export async function sendVerification({ to, name, token, kind }) {
  if (!emailConfigured()) return { ok: false, error: 'email_not_configured' };
  const mail = verificationEmail({ name, link: verifyLink(token), kind });
  return sendEmail({ to, ...mail, replyTo: '' });
}

/** Confirma o email a partir do token (leitor ou parceiro). */
export async function verifyToken(pool, token) {
  const clean = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(clean)) return { ok: false, error: 'invalid' };
  try {
    const r = await pool.query(
      `update fair_readers set email_verified_at = now(), email_token = null, email_token_expires_at = null
        where email_token = $1 and (email_token_expires_at is null or email_token_expires_at > now())
        returning id, name, email`,
      [clean],
    );
    if (r.rows[0]) return { ok: true, kind: 'reader', email: r.rows[0].email };
  } catch {}
  try {
    const r = await pool.query(
      `update fair_partner_users set email_verified_at = now(), email_token = null, email_token_expires_at = null
        where email_token = $1 and (email_token_expires_at is null or email_token_expires_at > now())
        returning id, email`,
      [clean],
    );
    if (r.rows[0]) return { ok: true, kind: 'partner', email: r.rows[0].email };
  } catch {}
  return { ok: false, error: 'invalid_or_expired' };
}

/** Reenvia o link de confirmação (leitor ou parceiro). Resposta sempre neutra. */
export async function resendVerification(pool, email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return { ok: true };
  try {
    const r = await pool.query(
      'select id, name, email, email_token, email_verified_at from fair_readers where lower(email) = $1 limit 1',
      [clean],
    );
    const u = r.rows[0];
    if (u?.email_token && !u.email_verified_at) {
      const token = newVerifyToken();
      await pool.query("update fair_readers set email_token = $2, email_token_expires_at = now() + interval '24 hours' where id = $1", [u.id, token]);
      await sendVerification({ to: u.email, name: u.name, token, kind: 'reader' });
      return { ok: true };
    }
  } catch {}
  try {
    const r = await pool.query(
      'select id, email, email_token, email_verified_at from fair_partner_users where lower(email) = $1 limit 1',
      [clean],
    );
    const u = r.rows[0];
    if (u?.email_token && !u.email_verified_at) {
      const token = newVerifyToken();
      await pool.query("update fair_partner_users set email_token = $2, email_token_expires_at = now() + interval '24 hours' where id = $1", [u.id, token]);
      await sendVerification({ to: u.email, name: '', token, kind: 'partner' });
    }
  } catch {}
  return { ok: true };
}
