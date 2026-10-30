import { pool } from '../lib/db.js';
import { escapeHtml, splitChapters } from '../lib/content.js';

// O livro só sai daqui para quem tem um pagamento confirmado. Nunca há ficheiro nem link público.
// Livros em PDF são guardados como data URI (data:application/pdf;base64,...) e mostrados
// no visualizador do browser, sempre através do token de compra: /api/chapter?t=...&pdf=1
const PDF_DATA = /^data:application\/pdf;base64,([\s\S]+)$/i;

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

  // Livro em PDF: mostra no leitor (a página pede primeiro os metadados e depois os bytes).
  const pdf = PDF_DATA.exec(raw);
  if (pdf) {
    if (String(req.query?.pdf ?? '') === '1') {
      let bytes;
      try {
        bytes = Buffer.from(pdf[1], 'base64');
      } catch {
        return res.status(503).json({ error: 'content_unavailable' });
      }
      if (!bytes.length) return res.status(503).json({ error: 'content_unavailable' });
      const name = String(book.title || 'livro').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'livro';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${name}.pdf"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(bytes);
    }
    return res.json({ title: book.title, index: 0, total: 1, toc: ['Documento'], pdf: true, pdfUrl: `/api/chapter?t=${t}&pdf=1` });
  }

  // Livros antigos carregados como PDF em texto (sem conversão): não há como mostrar o conteúdo.
  if (/^\s*%PDF-/.test(raw)) return res.status(409).json({ error: 'pdf_legacy' });

  const chapters = splitChapters(raw);
  if (!chapters.length) return res.status(503).json({ error: 'content_unavailable' });
  const toc = chapters.map((c) => c.title);
  const i = Number(req.query?.i ?? 0);
  if (!Number.isInteger(i) || i < 0 || i >= chapters.length) return res.status(400).json({ error: 'invalid_chapter', toc });

  const mark = `Exemplar de ${escapeHtml(rows[0].buyer_name)} · ${escapeHtml(rows[0].buyer_phone)}`; // marca de água
  res.json({ title: book.title, index: i, total: chapters.length, toc,
    html: `${chapters[i].html}<p class="wm">${mark}</p>` });
}
