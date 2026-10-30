import { createHmac, timingSafeEqual } from 'node:crypto';

// ATENÇÃO: confirmar com a implementação PaySuite que já usas noutros projectos:
// campos do pedido, campos da resposta, nomes dos eventos e formato da assinatura.
export async function createPayment({ reference, amountMinor, description, returnUrl, callbackUrl }) {
  const token = process.env.PAYSUITE_API_KEY || process.env.PAYSUITE_TOKEN;
  const endpoint = process.env.PAYSUITE_CREATE_URL || (process.env.PAYSUITE_BASE_URL ? `${process.env.PAYSUITE_BASE_URL.replace(/\/$/, '')}/payments` : 'https://api.paysuite.tech/v1/payments');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      amount: (amountMinor / 100).toFixed(2),
      reference,
      description,
      return_url: returnUrl,
      callback_url: callbackUrl,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`PaySuite HTTP Error ${res.status}:`, errText);
    throw new Error(`PaySuite HTTP ${res.status}: ${errText.slice(0, 100)}`);
  }
  const json = await res.json();
  const d = json.data ?? json;
  const providerPaymentId = d.id ?? d.payment_id ?? d.reference;
  const checkoutUrl = d.checkout_url ?? d.checkoutUrl ?? d.payment_url ?? d.url;
  if (!providerPaymentId || !checkoutUrl) {
    console.error('PaySuite resposta sem id ou checkoutUrl:', JSON.stringify(d));
    throw new Error('Resposta inesperada da PaySuite');
  }
  return { providerPaymentId: String(providerPaymentId), checkoutUrl };
}

const safeEqual = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// HMAC-SHA256 do corpo bruto (hex ou base64, com ou sem «sha256=»).
export function verifySignature(raw, header, secret) {
  if (!header || !secret) return false;
  const provided = header.trim().replace(/^sha256=/i, '');
  const digest = createHmac('sha256', secret).update(raw).digest();
  return safeEqual(provided.toLowerCase(), digest.toString('hex')) || safeEqual(provided, digest.toString('base64'));
}

export const EVENT_STATUS = {
  'payment.success': 'paid',
  'payment.failed': 'failed',
  'payment.cancelled': 'cancelled',
  'payment.canceled': 'cancelled',
};
