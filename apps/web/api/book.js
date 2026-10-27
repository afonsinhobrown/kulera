import { book } from '../lib/book.js';
// Textos públicos configuráveis (suporte e oferta a parceiros). Preços vêm do catálogo (/api/books).
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ supportWhatsApp: book.supportWhatsApp, partner: book.partner });
}
