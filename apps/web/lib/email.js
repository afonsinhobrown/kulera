import { createHmac, timingSafeEqual } from 'node:crypto';

// Email transaccional e de novidades. Configuração só por variáveis de ambiente:
//  EMAIL_SUPPORT_TO=email-real (respostas das compras)   EMAIL_FROM="Kulera+ <livros@doremi...>"
//  EMAIL_UNSUBSCRIBE_SECRET=<segredo longo>   MARKETING_ENABLED=true
// Respostas: só o email de compra leva "responder para"; as promoções não pedem resposta.
// Sem chave, o envio é simplesmente ignorado (o site continua a funcionar).

export const SITE_BASE = () =>
  String(process.env.SITE_URL || 'https://kulera.tecnoincubadora.org').replace(/\/+$/, '');

// Remetente por omissão: usa o subdomínio já verificado no Resend (doremi.tecnoincubadora.org).
// Pode ser trocado com EMAIL_FROM sem mexer no código.
const DEFAULT_FROM = 'Kulera+ <no-reply@doremi.tecnoincubadora.org>';
// Respostas dos compradores (só no email de compra). As promoções nunca levam "responder para".
const DEFAULT_SUPPORT = 'tecnoincubadora.info@tecnoincubadora.org';

export function emailConfig() {
  const key = String(process.env.RESEND_API_KEY || process.env.BREVO_API_KEY || '').trim();
  const from = String(process.env.EMAIL_FROM || DEFAULT_FROM).trim();
  if (!key || !from) return null;
  const provider = String(process.env.EMAIL_PROVIDER || (process.env.RESEND_API_KEY ? 'resend' : 'brevo'))
    .trim()
    .toLowerCase();
  return {
    provider: provider === 'brevo' ? 'brevo' : 'resend',
    key,
    from,
    replyTo:
      String(process.env.EMAIL_SUPPORT_TO || process.env.EMAIL_REPLY_TO || DEFAULT_SUPPORT).trim() || undefined,
  };
}

export const emailConfigured = () => Boolean(emailConfig());
export const marketingEnabled = () => String(process.env.MARKETING_ENABLED || 'true') !== 'false';

const parseFrom = (from) => {
  const m = /^(.*)<([^>]+)>\s*$/.exec(from);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, '') || 'Kulera+', email: m[2].trim() };
  return { name: 'Kulera+', email: from };
};

const mask = (email) => {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return '***';
  return s.slice(0, Math.min(2, at)) + '***' + s.slice(at);
};

/** Envia um email. Devolve {ok} e nunca lança. */
export async function sendEmail({ to, subject, html, text, replyTo }) {
  const cfg = emailConfig();
  if (!cfg) {
    console.warn('email.skip not_configured (falta RESEND_API_KEY/BREVO_API_KEY)');
    return { ok: false, error: 'email_not_configured' };
  }
  const recipients = (Array.isArray(to) ? to : [to]).map((x) => String(x || '').trim()).filter(Boolean);
  if (!recipients.length) return { ok: false, error: 'no_recipients' };
  // replyTo: undefined = usa o endereço de suporte; '' = sem "responder para" (promoções).
  const reply = replyTo === undefined ? cfg.replyTo : String(replyTo || '').trim() || undefined;
  const bodyText = text || 'Veja este email num leitor com HTML.';
  console.log('email.send', cfg.provider, 'from=' + cfg.from, 'to=' + recipients.map(mask).join(','), 'subject=' + subject.slice(0, 80));
  try {
    if (cfg.provider === 'brevo') {
      const sender = parseFrom(cfg.from);
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': cfg.key, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender,
          to: recipients.map((email) => ({ email })),
          subject,
          htmlContent: html,
          textContent: bodyText,
          replyTo: reply ? { email: reply } : undefined,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) {
        const detail = `brevo_${r.status}:${(await r.text().catch(() => '')).slice(0, 160)}`;
        console.error('email.fail', detail);
        return { ok: false, error: detail };
      }
      const id = (await r.json().catch(() => ({})))?.messageId || null;
      console.log('email.ok brevo id=' + id);
      return { ok: true, id };
    }
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: cfg.from,
        to: recipients,
        subject,
        html,
        text: bodyText,
        reply_to: reply,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const detail = `resend_${r.status}:${(await r.text().catch(() => '')).slice(0, 160)}`;
      console.error('email.fail', detail);
      return { ok: false, error: detail };
    }
    const id = (await r.json().catch(() => ({})))?.id || null;
    console.log('email.ok resend id=' + id);
    return { ok: true, id };
  } catch (e) {
    const detail = String(e?.message || e);
    console.error('email.fail', detail);
    return { ok: false, error: detail };
  }
}

// Assinatura do email de cancelamento de subscrição (não precisa de sessão).
const unsubSecret = () => String(process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.PAYSUITE_WEBHOOK_SECRET || 'kulera');
export const unsubscribeToken = (email) =>
  createHmac('sha256', unsubSecret()).update(String(email || '').trim().toLowerCase()).digest('hex');

export function verifyUnsubscribe(email, sig) {
  const expected = unsubscribeToken(email);
  const got = String(sig || '').trim();
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(got));
  } catch {
    return false;
  }
}

export const unsubscribeUrl = (email) =>
  `${SITE_BASE()}/sair.html?e=${encodeURIComponent(String(email || '').trim().toLowerCase())}&s=${unsubscribeToken(email)}`;

const money = (minor, currency = 'MZN') => {
  try {
    return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency }).format(Number(minor) / 100);
  } catch {
    return (Number(minor) / 100).toFixed(2) + ' ' + currency;
  }
};

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ title, intro, cta, ctaLabel, extra, footer }) {
  return `<!doctype html><html lang="pt"><body style="margin:0;background:#f5f7f6;font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#10242b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7f6;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d7e0de;border-radius:12px;overflow:hidden">
<tr><td style="background:#083f45;padding:18px 22px;color:#ffffff;font:700 22px Georgia,serif">Kulera<span style="color:#f2a93b">+</span></td></tr>
<tr><td style="padding:22px">
<h1 style="font:700 24px/1.2 Georgia,serif;margin:0 0 10px">${esc(title)}</h1>
<p style="margin:0 0 16px;color:#33505a">${intro}</p>
<p style="margin:0 0 22px"><a href="${esc(cta)}" style="display:inline-block;background:#f2a93b;color:#241700;font-weight:700;text-decoration:none;padding:13px 20px;border-radius:8px">${esc(ctaLabel)}</a></p>
${extra || ''}
<p style="margin:18px 0 0;font-size:14px;color:#5b747c;word-break:break-all">${esc(cta)}</p>
</td></tr>
<tr><td style="padding:14px 22px;background:#f5f7f6;font-size:12px;color:#5b747c">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

export function accessEmail({ name, bookTitle, link, email }) {
  const html = layout({
    title: 'O seu livro já está disponível',
    intro: `Olá${name ? ' ' + esc(String(name).split(' ')[0]) : ''}, o pagamento do livro <b>${esc(bookTitle)}</b> foi confirmado. Toque no botão para abrir.`,
    cta: link,
    ctaLabel: 'Ler agora',
    extra: '<p style="margin:0 0 8px;color:#33505a;font-size:14px">Guarde este email: o link é o seu acesso ao livro. O livro fica associado ao primeiro dispositivo onde o abrir; se mudar de telemóvel, pode pedir autorização no leitor.</p>',
    footer: `Recebeu este email porque comprou na Kulera+. <a href="${esc(unsubscribeUrl(email))}" style="color:#5b747c">Cancelar subscrição</a>`,
  });
  return {
    subject: `O seu livro "${bookTitle}" está disponível — Kulera+`,
    html,
    text: `O seu livro "${bookTitle}" está disponível: ${link}`,
  };
}

export function announcementEmail({ title, author, priceMinor, currency, link, email, coverUrl }) {
  const price = priceMinor != null ? money(priceMinor, currency) : '';
  const html = layout({
    title: 'Novidade na Kulera+',
    intro: `<b>${esc(title)}</b>${author ? ' de ' + esc(author) : ''}${price ? ' · ' + esc(price) : ''}. Já está disponível para comprar e ler na plataforma.`,
    cta: link,
    ctaLabel: 'Ver o livro',
    extra: coverUrl
      ? `<p style="margin:0 0 12px"><img src="${esc(coverUrl)}" alt="Capa de ${esc(title)}" width="180" style="max-width:180px;border-radius:8px"></p>`
      : '',
    footer: `Está a receber novidades da Kulera+ porque autorizou no momento da compra. Não é preciso responder a este email. <a href="${esc(unsubscribeUrl(email))}" style="color:#5b747c">Cancelar subscrição</a>`,
  });
  return {
    subject: `Novo livro na Kulera+: ${title}`,
    html,
    text: `Novo livro na Kulera+: ${title}${author ? ' de ' + author : ''}${price ? ' · ' + price : ''}. ${link}`,
  };
}
