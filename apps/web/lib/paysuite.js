import { createHmac, timingSafeEqual } from 'node:crypto';

// ATENÇÃO: confirmar com a implementação PaySuite que já usas noutros projectos:
// campos do pedido, campos da resposta, nomes dos eventos e formato da assinatura.
export async function createPayment({ reference, amountMinor, description, returnUrl, callbackUrl }) {
  const res = await fetch(process.env.PAYSUITE_CREATE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PAYSUITE_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      amount: (amountMinor / 100).toFixed(2),
      reference,
      description,
      return_url: returnUrl,
      callback_url: callbackUrl,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`PaySuite HTTP ${res.status}`); // nunca registar token nem corpo
  const json = await res.json();
  const d = json.data ?? json;
  const providerPaymentId = d.id, checkoutUrl = d.checkout_url ?? d.checkoutUrl ?? d.url;
  if (!providerPaymentId || !checkoutUrl) throw new Error('Resposta inesperada da PaySuite');
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
