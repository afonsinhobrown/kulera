import { pool } from '../lib/db.js';
import { createWalletOrder, startPayment } from '../lib/payments.js';
import { getReaderBySession, readerBalance } from '../lib/reader.js';

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
  const marketingOptIn = req.body?.marketing === true && Boolean(email);
  // Compra feita com sessão de leitor fica na biblioteca dessa conta.
  const readerToken = String(req.headers?.['x-reader-token'] || req.body?.readerToken || '');
  const reader = /^[a-f0-9]{64}$/.test(readerToken) ? await getReaderBySession(pool, readerToken).catch(() => null) : null;

  // Preço, moeda e disponibilidade SEMPRE da base de dados. Nunca se vende um livro sem conteúdo publicado.
  // Planos expirados/bloqueados do parceiro impedem novas compras de livros desse autor/editora.
  let book;
  try {
    const found = await pool.query(
      `select b.id, b.title, b.price_minor, b.currency, b.kind, b.requires_shipping, b.stock, b.content_html,
              coalesce(b.has_digital,true) as has_digital, coalesce(b.has_physical,false) as has_physical,
              (to_jsonb(b)->>'price_physical_minor')::bigint as price_physical_minor,
              b.partner_id,
              case when b.partner_id is null then true
                   when exists (select 1 from fair_subscriptions s where s.partner_id = b.partner_id and s.status = 'active' and s.ends_at > now()) then true
                   when b.active_until > now() then true
                   when not exists (select 1 from fair_subscriptions s where s.partner_id = b.partner_id) then true
                   else false end as can_sell
         from fair_books b
        where b.id = $1 and b.status = 'published'`,
      [bookId],
    );
    book = found.rows[0];
  } catch {
    const found = await pool.query(
      'select id, title, price_minor, currency, kind, requires_shipping, stock, content_html from fair_books where id = $1 and status = $2',
      [bookId, 'published'],
    );
    book = found.rows[0] ? { ...found.rows[0], can_sell: true } : null;
  }

  if (!book || book.can_sell === false) return res.status(404).json({ error: 'book_unavailable' });
  const hasDigital = book.has_digital !== false && (book.kind !== 'physical' || book.content_html != null);
  const hasPhysical = book.has_physical === true || book.kind === 'physical' || book.requires_shipping === true;
  if (!hasDigital && !hasPhysical) return res.status(404).json({ error: 'book_unavailable' });

  const requested = req.body?.format === 'physical' ? 'physical' : req.body?.format === 'digital' ? 'digital' : null;
  let chosen = requested;
  if (chosen === 'physical' && !hasPhysical) chosen = null;
  if (chosen === 'digital' && !hasDigital) chosen = null;
  if (!chosen) chosen = hasDigital ? 'digital' : 'physical';
  const isPhysical = chosen === 'physical';

  if (!isPhysical && !book.content_html) return res.status(404).json({ error: 'book_unavailable' });
  if (isPhysical) {
    if (book.stock != null && Number(book.stock) <= 0) return res.status(404).json({ error: 'book_unavailable' });
    if (!shippingAddress || shippingAddress.length < 5) return res.status(400).json({ error: 'invalid_address' });
  }

  const listMinor = isPhysical ? Number(book.price_physical_minor ?? book.price_minor) : Number(book.price_minor);
  if (isPhysical && book.stock != null) {
    await pool.query('update fair_books set stock = stock - 1 where id = $1 and stock >= 1', [book.id]);
  }

  // Saldo do leitor (só com sessão): pode pagar tudo ou parte; o resto vai para a PaySuite.
  let useMinor = 0;
  if (reader) {
    const balance = await readerBalance(pool, reader.id).catch(() => 0);
    const asked = Number(req.body?.useBalanceMinor);
    useMinor = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 0;
    if (req.body?.useAllBalance === true) useMinor = balance;
    useMinor = Math.max(0, Math.min(useMinor, balance, listMinor));
  }
  const chargeMinor = listMinor - useMinor;

  const extra = {
    book_id: book.id,
    marketing_opt_in: marketingOptIn,
    reader_id: reader?.id || null,
    shipping_name: shippingName || name,
    shipping_phone: shippingPhone || phone,
    shipping_address: shippingAddress || null,
    shipping_city: shippingCity || null,
  };

  const pay = useMinor > 0 && chargeMinor <= 0
    ? await createWalletOrder({
        type: isPhysical ? 'physical' : 'book',
        amountMinor: listMinor,
        currency: book.currency,
        name,
        phone,
        email,
        extra,
        useMinor,
        req,
      })
    : await startPayment({
        type: isPhysical ? 'physical' : 'book',
        listAmountMinor: chargeMinor,
        currency: book.currency,
        name,
        phone,
        email,
        description: `${isPhysical ? 'Kulera+: Livro físico' : 'Kulera+'}: ${book.title}`,
        extra,
        req,
      });

  if (!pay.ok) {
    if (isPhysical && book.stock != null) {
      await pool.query('update fair_books set stock = stock + 1 where id = $1', [book.id]);
    }
    return res.status(502).json({
      error: 'payment_unavailable',
      detail: pay.errorDetail || 'Falha na comunicação com o gateway PaySuite',
    });
  }

  if (useMinor > 0 && chargeMinor > 0) {
    await pool.query('update fair_orders set wallet_minor = $2 where id = $1', [pay.id, useMinor]);
    await pool.query(
      `insert into fair_reader_ledger (reader_id, kind, amount_minor, order_id, note) values ($1,'hold',$2,$3,$4)`,
      [reader.id, -useMinor, pay.id, 'Reserva para compra'],
    );
  }

  return res.status(200).json({
    checkoutUrl: pay.checkoutUrl,
    token: pay.token,
    format: chosen,
    amountMinor: pay.amountMinor,
    walletMinor: useMinor,
    sandbox: pay.sandbox,
    simulated: Boolean(pay.simulated),
    providerWarning: pay.providerWarning,
  });
}
