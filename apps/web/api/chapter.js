import { pool } from '../lib/db.js';
import { escapeHtml, splitChapters } from '../lib/content.js';

// O livro só sai daqui para quem tem um pagamento confirmado. Nunca há ficheiro nem link público.
// Livros em PDF são desenhados pelo leitor da plataforma (pdf.js), página a página, com marca de
// água — e não pelo visualizador do browser (que teria sempre download/impressão).
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

  const mark = `Exemplar de ${escapeHtml(rows[0].buyer_name)} · ${escapeHtml(rows[0].buyer_phone)}`; // marca de água
  const raw = String(book.content_html ?? '');

  // Livro em PDF: metadados para o leitor e, a pedido do leitor, os bytes do documento.
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
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(bytes);
    }
    return res.json({ title: book.title, pdf: true, pdfUrl: `/api/chapter?t=${t}&pdf=1`, watermark: mark });
  }

  // Livros antigos carregados como PDF em texto (sem conversão): mensagem clara em vez de código.
  if (/^\s*%PDF-/.test(raw)) return res.status(409).json({ error: 'pdf_not_supported' });

  const chapters = splitChapters(raw);
  if (!chapters.length) return res.status(503).json({ error: 'content_unavailable' });
  const toc = chapters.map((c) => c.title);
  const i = Number(req.query?.i ?? 0);
  if (!Number.isInteger(i) || i < 0 || i >= chapters.length) return res.status(400).json({ error: 'invalid_chapter', toc });

  res.json({ title: book.title, index: i, total: chapters.length, toc,
    html: `${chapters[i].html}<p class="wm">${mark}</p>` });
}
