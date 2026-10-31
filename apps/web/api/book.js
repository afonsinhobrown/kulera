import { book } from '../lib/book.js';
import { isSandbox, SANDBOX_AMOUNT_MINOR } from '../lib/payments.js';
import { getPublicationFeeMinor } from '../lib/settings.js';
import { pool } from '../lib/db.js';

// Textos públicos configuráveis (suporte e oferta a parceiros), estado do modo de teste
// e taxa de publicação actual (configurada pelo Admin).
// Preços vêm do catálogo (/api/books); o valor realmente cobrado em sandbox vem daqui.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  let sandbox = false;
  let publicationFeeMinor = null;
  try {
    sandbox = await isSandbox();
  } catch {}
  try {
    publicationFeeMinor = await getPublicationFeeMinor(pool);
  } catch {}
  res.json({
    supportWhatsApp: book.supportWhatsApp,
    partner: book.partner,
    sandbox,
    sandboxPriceMinor: sandbox ? SANDBOX_AMOUNT_MINOR : null,
    publicationFeeMinor,
  });
}
