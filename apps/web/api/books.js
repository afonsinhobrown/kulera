import { pool } from '../lib/db.js';
// Catálogo público: só livros publicados e com conteúdo. Nunca devolve o conteúdo.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=30');
  const { rows } = await pool.query(
    `select id, title, author, description, language, price_minor, currency, cover_url
       from fair_books where status = 'published' and content_html is not null order by created_at desc limit 200`);
  res.json(rows.map((b) => ({ id: b.id, title: b.title, author: b.author, description: b.description, language: b.language,
    priceMinor: Number(b.price_minor), currency: b.currency, coverUrl: b.cover_url })));
}
