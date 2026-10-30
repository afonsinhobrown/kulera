import { pool } from '../lib/db.js';

// Capa do livro como imagem pública: /api/capa?id=<id do livro>.
// Serve dois casos: capas guardadas em base64 (data:) no painel e capas que são links externos.
// Assim o link de partilha consegue mostrar a capa na pré-visualização (og:image) em qualquer dos casos.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_TYPE = /^image\/(png|jpe?g|webp|gif|svg\+xml)$/i;

export default async function handler(req, res) {
  const id = String(req?.query?.id ?? '').trim();
  if (!UUID.test(id)) return res.status(404).json({ error: 'not_found' });

  let cover = '';
  try {
    const r = await pool.query('select cover_url from fair_books where id = $1 and status = $2', [id, 'published']);
    cover = String(r.rows[0]?.cover_url || '').trim();
  } catch {
    return res.status(404).json({ error: 'not_found' });
  }
  if (!cover) return res.status(404).json({ error: 'not_found' });

  // Capa externa: manda o browser/leitor de redes sociais para o endereço original.
  if (/^https?:\/\//i.test(cover)) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Location', cover);
    return res.status(302).send('');
  }

  // Capa guardada na base de dados como data URI (é o que o painel faz ao carregar uma imagem).
  const m = /^data:(image\/[a-z0-9.+-]+)(;base64)?,([\s\S]*)$/i.exec(cover);
  if (!m || !IMAGE_TYPE.test(m[1])) return res.status(404).json({ error: 'not_found' });
  let bytes;
  try {
    bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  } catch {
    return res.status(404).json({ error: 'not_found' });
  }
  if (!bytes.length) return res.status(404).json({ error: 'not_found' });

  res.setHeader('Content-Type', m[1].toLowerCase());
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Cache-Control', req?.query?.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
  return res.status(200).send(bytes);
}
