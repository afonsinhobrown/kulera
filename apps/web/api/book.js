import { book } from '../lib/book.js';
import { isSandbox, SANDBOX_AMOUNT_MINOR } from '../lib/payments.js';

// Textos públicos configuráveis (suporte e oferta a parceiros) e estado do modo de teste.
// Preços vêm do catálogo (/api/books); o valor realmente cobrado em sandbox vem daqui.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  let sandbox = false;
  try {
    sandbox = await isSandbox();
  } catch {}
  res.json({
    supportWhatsApp: book.supportWhatsApp,
    partner: book.partner,
    sandbox,
    sandboxPriceMinor: sandbox ? SANDBOX_AMOUNT_MINOR : null,
  });
}
