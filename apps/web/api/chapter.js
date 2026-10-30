import { pool } from '../lib/db.js';
import { escapeHtml, splitChapters } from '../lib/content.js';

// O livro só sai daqui para quem tem um pagamento confirmado. Nunca há ficheiro nem link público.
// O leitor da plataforma lê HTML/Word (com capítulos, marca de água e sem download).
// PDF não é servido: o visualizador do browser mostraria sempre download/impressão e tiraria
// o livro do controlo da plataforma.
const PDF_LIKE = /^\s*%PDF-|^data:application\/pdf;base64,/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const t = String(req.query?.t ?? '');
  if (!/^[a-f0-9]{64}$/.test(t)) return res.status(403).json({ error: 'forbidden' });
  const { rows } = await pool.query(
    `select o.buyer_name, o.buyer_phone, b.title, b.content_html, b.kind from fair_orders o join fair_books b on b.id = o.book_id
      where o.token = $1 and o.status = 'paid' and (o.type is null or o.type!='physical')`, [t]);
  if (!rows[0]) return res.status(403).json({ error: 'forbidden' });
  const book = rows[0];
  if (book.kind === 'physical') return res.status(403).json({ error: 'forbidden' });

  const raw = String(book.content_html ?? '');
  // Livros antigos carregados em PDF: mensagem clara em vez de mostrar o código do ficheiro.
  if (PDF_LIKE.test(raw)) return res.status(409).json({ error: 'pdf_not_supported' });

  const chapters = splitChapters(raw);
  if (!chapters.length) return res.status(503).json({ error: 'content_unavailable' });
  const toc = chapters.map((c) => c.title);
  const i = Number(req.query?.i ?? 0);
  if (!Number.isInteger(i) || i < 0 || i >= chapters.length) return res.status(400).json({ error: 'invalid_chapter', toc });

  const mark = `Exemplar de ${escapeHtml(rows[0].buyer_name)} · ${escapeHtml(rows[0].buyer_phone)}`; // marca de água
  res.json({ title: book.title, index: i, total: chapters.length, toc,
    html: `${chapters[i].html}<p class="wm">${mark}</p>` });
}
