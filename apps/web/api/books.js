import { pool } from '../lib/db.js';
// Catálogo público
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=30');
  try {
    let rows = [];
    try {
      const r = await pool.query(
        `select id, title, author, description, language, price_minor, currency, cover_url, coalesce(kind,'ebook') as kind, requires_shipping, stock, content_html is not null as has_content
           from fair_books where status = 'published' order by created_at desc limit 200`);
      rows = r.rows;
    } catch {
      const r = await pool.query(
        `select id, title, author, description, language, price_minor, currency, cover_url
           from fair_books where status = 'published' order by created_at desc limit 200`);
      rows = r.rows.map(x=>({...x, kind:'ebook', requires_shipping:false, stock:null, has_content:null}));
    }
    res.json(rows.map((b) => ({ id: b.id, title: b.title, author: b.author, description: b.description, language: b.language,
      priceMinor: Number(b.price_minor), currency: b.currency, coverUrl: b.cover_url, kind: b.kind || 'ebook', requiresShipping: b.requires_shipping || b.kind==='physical', stock: b.stock, hasContent: b.has_content })));
  } catch (e) {
    console.error('books.error', e?.message || String(e));
    res.status(500).json({ error: 'internal_error' });
  }
}
