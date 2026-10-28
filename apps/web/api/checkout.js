import { randomBytes, randomUUID } from 'node:crypto';
import { pool } from '../lib/db.js';
import { createPayment } from '../lib/paysuite.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const bookId = String(req.body?.bookId ?? '');
  if (!/^[0-9a-f-]{36}$/.test(bookId)) return res.status(400).json({ error: 'invalid_book' });
  const name = String(req.body?.name ?? '').trim();
  const phone = String(req.body?.phone ?? '').replace(/[\s()-]/g, '').replace(/^\+/, '');
  const email = String(req.body?.email ?? '').trim();
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'invalid_name' });
  if (!/^\d{9,15}$/.test(phone)) return res.status(400).json({ error: 'invalid_phone' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });

  const shippingName = String(req.body?.shippingName ?? name).trim();
  const shippingPhone = String(req.body?.shippingPhone ?? phone).replace(/[\s()-]/g, '').replace(/^\+/, '');
  const shippingAddress = String(req.body?.shippingAddress ?? '').trim();
  const shippingCity = String(req.body?.shippingCity ?? '').trim();

  // PreAo, moeda e disponibilidade SEMPRE da base de dados. Nunca se vende um livro sem conteA�do publicado.
  const found = await pool.query(
    "select id, title, price_minor, currency, kind, requires_shipping, stock, content_html from fair_books where id = $1 and status = 'published'", [bookId]);
  const book = found.rows[0];
  if (!book) return res.status(404).json({ error: 'book_unavailable' });
  if ((book.kind === 'ebook' || !book.requires_shipping) && !book.content_html) return res.status(404).json({ error: 'book_unavailable' });
  if (book.kind === 'physical') {
    if (book.stock != null && Number(book.stock) <= 0) return res.status(404).json({ error: 'book_unavailable' });
    if (!shippingAddress || shippingAddress.length < 5) return res.status(400).json({ error: 'invalid_address' });
  }
  let priceMinor = Number(book.price_minor);
  if (process.env.SANDBOX === 'true' || process.env.TEST_PRICE_MT === '1' || process.env.FORCE_TEST_PRICE === '1' || process.env.TEST_PRICE_MT === '11') {
    priceMinor = 1100;
  } else if (process.env.TEST_PRICE_MT_ALL) {
    priceMinor = Math.round(Number(process.env.TEST_PRICE_MT_ALL) * 100);
  }
  const isPhysical = book.kind === 'physical' || book.requires_shipping;

  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const reference = `KF${id.replaceAll('-', '').slice(0, 28)}`;
  const site = process.env.SITE_URL;

  await pool.query(
    `insert into fair_orders (id, token, reference, buyer_name, buyer_phone, buyer_email, amount_minor, currency, book_id, type, shipping_name, shipping_phone, shipping_address, shipping_city)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, token, reference, name, phone, email || null, priceMinor, book.currency, book.id, isPhysical ? 'physical' : 'book', shippingName || name, shippingPhone || phone, shippingAddress || null, shippingCity || null],
  );
  if (book.kind === 'physical' && book.stock != null) {
    await pool.query('update fair_books set stock = stock - 1 where id = $1 and stock >= 1', [book.id]);
  }
  try {
    const { providerPaymentId, checkoutUrl } = await createPayment({
      reference, amountMinor: priceMinor, description: `${isPhysical?'Kulera+: Livro físico':'Kulera+'}: ${book.title}`.slice(0, 120),
      returnUrl: `${site}/pagamento.html?t=${token}`, callbackUrl: `${site}/api/webhook`,
    });
    await pool.query(
      `update fair_orders set provider_payment_id = $2, checkout_url = $3,
         status = case when status = 'created' then 'pending' else status end where id = $1`,
      [id, providerPaymentId, checkoutUrl],
    );
    return res.status(200).json({ checkoutUrl, token });
  } catch (error) {
    console.error('checkout.error', String(error));
    if (book.kind === 'physical' && book.stock != null) {
      await pool.query('update fair_books set stock = stock + 1 where id = $1', [book.id]);
    }
    await pool.query("update fair_orders set status = 'failed' where id = $1 and status in ('created','pending')", [id]);
    return res.status(502).json({ error: 'payment_unavailable' });
  }
}
