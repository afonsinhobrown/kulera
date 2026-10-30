import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://paysuite.tech/api/v1';
const FALLBACK_COMPANY_TOKEN = '2677|NLo5LQbk4Un8e3RkHz1GtjLC1bUjPLseHEbwNx9Tc14eaf98';

export function resolvePaysuiteToken(apiToken) {
  const raw = (apiToken || process.env.PAYSUITE_API_KEY || process.env.PAYSUITE_TOKEN || '').trim();
  // Substitui automaticamente o token antigo (2098|...) que não tinha permissão empresarial
  if (!raw || raw.startsWith('2098|')) return FALLBACK_COMPANY_TOKEN;
  return raw;
}

export function resolvePaysuiteBaseUrl() {
  const raw = (process.env.PAYSUITE_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  // Corrige domínios antigos/inválidos (api.paysuite.tech não existe no DNS; o endpoint oficial é paysuite.tech/api/v1)
  return raw.replace(/^https?:\/\/api\.paysuite\.tech(\/api\/v1|\/v1)?/i, DEFAULT_BASE_URL);
}

export function resolvePaysuiteCreateUrl() {
  const custom = (process.env.PAYSUITE_CREATE_URL || '').trim();
  if (custom) {
    return custom.replace(/^https?:\/\/api\.paysuite\.tech(\/api\/v1|\/v1)?/i, DEFAULT_BASE_URL);
  }
  return `${resolvePaysuiteBaseUrl()}/payments`;
}

export async function createPayment({ reference, amountMinor, description, returnUrl, callbackUrl, apiToken }) {
  const token = resolvePaysuiteToken(apiToken);
  if (!token) {
    throw new Error('Token da PaySuite não configurado (PAYSUITE_TOKEN)');
  }
  const endpoint = resolvePaysuiteCreateUrl();

  const payload = {
    amount: (Number(amountMinor) / 100).toFixed(2),
    reference,
    description,
  };
  if (returnUrl && /^https?:\/\//i.test(returnUrl)) payload.return_url = returnUrl;
  if (callbackUrl && /^https?:\/\//i.test(callbackUrl)) payload.callback_url = callbackUrl;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let msg = errText.slice(0, 160);
    try {
      const errJson = JSON.parse(errText);
      if (errJson?.message) msg = errJson.message;
    } catch {}
    console.error(`PaySuite HTTP Error ${res.status} (${endpoint}):`, errText);
    throw new Error(`PaySuite HTTP ${res.status}: ${msg}`);
  }

  const json = await res.json();
  const d = json?.data ?? json;
  const providerPaymentId = d?.id ?? d?.payment_id ?? d?.transaction_id ?? d?.reference;
  const checkoutUrl = d?.checkout_url ?? d?.checkoutUrl ?? d?.payment_url ?? d?.url;
  if (!providerPaymentId || !checkoutUrl) {
    console.error('PaySuite resposta sem id ou checkoutUrl:', JSON.stringify(d));
    throw new Error('Resposta inesperada da PaySuite (sem checkout_url)');
  }
  return { providerPaymentId: String(providerPaymentId), checkoutUrl: String(checkoutUrl) };
}

export async function getPaymentStatus(providerPaymentId, apiToken) {
  const token = resolvePaysuiteToken(apiToken);
  if (!token || !providerPaymentId || String(providerPaymentId).startsWith('sim_')) return null;
  const endpoint = `${resolvePaysuiteBaseUrl()}/payments/${encodeURIComponent(providerPaymentId)}`;
  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const d = json?.data ?? json;
    const rawStatus = String(d?.status ?? '').toLowerCase();
    if (['paid', 'completed', 'success', 'succeeded', 'approved'].includes(rawStatus)) return 'paid';
    if (['failed', 'error', 'declined', 'rejected'].includes(rawStatus)) return 'failed';
    if (['cancelled', 'canceled', 'expired'].includes(rawStatus)) return 'cancelled';
    return 'pending';
  } catch {
    return null;
  }
}

const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// HMAC-SHA256 do corpo bruto (hex ou base64, com ou sem «sha256=»).
export function verifySignature(raw, header, secret) {
  if (!header || !secret) return false;
  const provided = String(header).trim().replace(/^sha256=/i, '');
  const digest = createHmac('sha256', secret).update(raw).digest();
  return (
    safeEqual(provided.toLowerCase(), digest.toString('hex')) ||
    safeEqual(provided, digest.toString('base64'))
  );
}

export const EVENT_STATUS = {
  'payment.success': 'paid',
  'payment.completed': 'paid',
  'payment.paid': 'paid',
  'payment.failed': 'failed',
  'payment.cancelled': 'cancelled',
  'payment.canceled': 'cancelled',
};
