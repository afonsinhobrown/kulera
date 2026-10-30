import { pool } from '../lib/db.js';
import { book as siteBook } from '../lib/book.js';

// Página pública de um livro — é o destino dos links de partilha (WhatsApp, Facebook, Telegram...).
// É servida pelo servidor (e não pelo browser) para que a pré-visualização do link mostre
// a capa, os preços e o texto "Compre agora". Cada preço tem um botão "Compre agora" que
// leva à página de pagamento desse livro (/comprar.html?id=...&fmt=...).
// A mesma função serve a capa como imagem: /api/livro?id=<id>&capa=1
// (assim o projeto fica com 12 funções, o máximo do plano Hobby da Vercel).
// No Vercel, /livro/<id> é reescrito para /api/livro?id=<id> (ver vercel.json).

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(minor, currency) {
  try {
    return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: currency || 'MZN' }).format(Number(minor) / 100);
  } catch {
    return (Number(minor) / 100).toFixed(2) + ' ' + (currency || 'MZN');
  }
}

function siteOrigin(req) {
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  const proto = String(req?.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
  if (host) return `${proto}://${host}`;
  return String(process.env.SITE_URL || 'https://kulera.vercel.app').replace(/\/+$/, '');
}

// A capa é servida pela própria página (?capa=1), tanto para capas em base64 como para links externos.
// O parâmetro v renova a imagem em cache quando a capa é alterada no painel.
function coverPath(b) {
  if (!b.coverUrl) return '';
  const v = b.updatedAt ? '&v=' + encodeURIComponent(String(b.updatedAt)) : '';
  return `/api/livro?id=${encodeURIComponent(b.id)}&capa=1${v}`;
}

const BOOK_SQL = `select b.id, b.title, b.author, b.description, b.language, b.price_minor, b.currency,
                         b.cover_url, b.updated_at,
                         coalesce(b.kind,'ebook') as kind, b.requires_shipping, b.stock,
                         coalesce(b.has_digital,true) as has_digital,
                         coalesce(b.has_physical,false) as has_physical,
                         b.content_html is not null as has_content,
                         (to_jsonb(b)->>'price_physical_minor')::bigint as price_physical_minor
                    from fair_books b
                   where b.id = $1
                     and b.status = 'published'
                     and (coalesce(b.kind,'ebook') = 'physical'
                          or coalesce(b.has_physical,false) = true
                          or b.content_html is not null)
                     and (b.partner_id is null
                          or exists (select 1 from fair_subscriptions s where s.partner_id = b.partner_id and s.status = 'active' and s.ends_at > now())
                          or not exists (select 1 from fair_subscriptions s where s.partner_id = b.partner_id))
                   group by b.id`;

const BOOK_SQL_OLD = `select id, title, author, description, language, price_minor, currency, cover_url
                        from fair_books
                       where id = $1 and status = 'published'`;

function toBook(row) {
  const kind = row.kind || 'ebook';
  const hasContent = row.has_content !== false;
  const hasDigital = row.has_digital !== false && (kind !== 'physical' || hasContent);
  const hasPhysical = row.has_physical === true || kind === 'physical' || row.requires_shipping === true;
  const digitalPrice = Number(row.price_minor);
  const physicalPrice = Number(row.price_physical_minor ?? row.price_minor);
  return {
    id: row.id,
    title: row.title || 'Livro',
    author: row.author || '',
    description: row.description || '',
    currency: row.currency || 'MZN',
    coverUrl: row.cover_url || '',
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
    hasDigital,
    hasPhysical,
    digitalPrice: Number.isFinite(digitalPrice) ? digitalPrice : null,
    physicalPrice: Number.isFinite(physicalPrice) ? physicalPrice : null,
    stock: row.stock == null ? null : Number(row.stock),
  };
}

async function findBook(id) {
  let row;
  try {
    const r = await pool.query(BOOK_SQL, [id]);
    row = r.rows.find((x) => x.id === id);
  } catch {
    // Bases de dados antigas (sem as colunas de formatos) continuam a poder partilhar livros.
    const r = await pool.query(BOOK_SQL_OLD, [id, 'published']);
    row = r.rows.find((x) => x.id === id);
    if (row) row = { ...row, has_content: true, has_digital: true, has_physical: false, requires_shipping: false, kind: 'ebook', stock: null };
  }
  if (!row) return null;
  const b = toBook(row);
  return b.hasDigital || b.hasPhysical ? b : null;
}

function priceOptions(b) {
  const opts = [];
  if (b.hasDigital && b.digitalPrice != null) {
    opts.push({ fmt: 'digital', short: 'E-book', label: 'E-book (leitura digital)', price: b.digitalPrice, out: false });
  }
  if (b.hasPhysical && b.physicalPrice != null) {
    opts.push({ fmt: 'physical', short: 'Físico', label: 'Livro físico (com entrega)', price: b.physicalPrice, out: b.stock != null && b.stock <= 0 });
  }
  return opts;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_TYPE = /^image\/(png|jpe?g|webp|gif|svg\+xml)$/i;

const payHref = (id, fmt) => `/comprar.html?id=${encodeURIComponent(id)}&fmt=${fmt}`;

// Capa do livro como imagem pública, para o og:image e para o <img> da página.
async function serveCover(req, res, id) {
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

function pageShell({ title, description, canonical, og, body }) {
  const support = String(siteBook?.supportWhatsApp || '').replace(/\D/g, '');
  return `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:site_name" content="Kulera+">
<meta property="og:locale" content="pt_MZ">
<meta property="og:type" content="${esc(og.type || 'website')}">
<meta property="og:title" content="${esc(og.title || title)}">
<meta property="og:description" content="${esc(og.description || description)}">
<meta property="og:url" content="${esc(canonical)}">
${og.image ? `<meta property="og:image" content="${esc(og.image)}">\n<meta property="og:image:alt" content="${esc(og.imageAlt || title)}">` : ''}
<meta name="twitter:card" content="${og.image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(og.title || title)}">
<meta name="twitter:description" content="${esc(og.description || description)}">
${og.image ? `<meta name="twitter:image" content="${esc(og.image)}">` : ''}
<link rel="stylesheet" href="/style.css">
<style>
.share-grid{display:grid;gap:26px;align-items:start}
@media(min-width:760px){.share-grid{grid-template-columns:280px 1fr}}
.share-cover{max-width:280px;margin:0 auto;position:relative}
.share-cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center}
.badges{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 8px}
.badge{font-size:13px;font-weight:700;padding:4px 10px;border-radius:999px;background:#e8f4f5;color:#0b5c63}
.badge.phys{background:#fff4e2;color:#7a4b00}
.prices{list-style:none;padding:0;margin:16px 0 18px;display:grid;gap:10px}
.price-row{display:flex;align-items:center;justify-content:space-between;gap:14px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px;flex-wrap:wrap}
.price-row .label{display:block;font-size:13px;color:#557077;font-weight:600}
.price-row .amount{font:700 22px Georgia,serif;color:var(--ink)}
.price-row .btn{width:auto;padding:11px 18px;font-size:15px;white-space:nowrap;margin:0}
.price-row .out{font-size:13px;color:#842029;font-weight:700}
.pay-note{font-size:14px;color:#44606a;margin:0 0 10px}
.desc{white-space:pre-line;color:#33505a}
</style>
${og.jsonLd ? `<script type="application/ld+json">${og.jsonLd}</script>` : ''}
</head>
<body>
<div class="top"><a href="/" style="color:#fff;text-decoration:none">Kulera<span style="color:var(--gold)">+</span></a> <a href="/" style="color:#fff;margin-left:auto;text-decoration:none;font-weight:600;font-size:15px">Ver todos os livros</a></div>
<main>
${body}
${support ? `<p class="note">Precisa de ajuda? <a href="https://wa.me/${esc(support)}" target="_blank" rel="noopener">Fale connosco no WhatsApp</a>.</p>` : ''}
</main>
</body>
</html>`;
}

function renderBookPage({ book: b, origin }) {
  const canonical = `${origin}/livro/${encodeURIComponent(b.id)}`;
  const options = priceOptions(b);
  const priceText = options.map((o) => `${o.short} ${money(o.price, b.currency)}`).join(' · ');
  const title = `${b.title}${b.author ? ' — ' + b.author : ''}`;
  const description = `${priceText ? priceText + '. ' : ''}Compre agora na Kulera+ e comece a ler logo a seguir. Pagamento por M-Pesa, e-Mola ou cartão Visa.`;
  const cover = coverPath(b);
  const ogImage = cover ? origin + cover : '';

  const badges = [
    b.hasDigital ? '<span class="badge">E-book</span>' : '',
    b.hasPhysical ? '<span class="badge phys">Físico · Entrega</span>' : '',
  ]
    .filter(Boolean)
    .join('');
  const rows = options
    .map(
      (o) => `<li class="price-row">
      <div><span class="label">${esc(o.label)}</span><b class="amount">${esc(money(o.price, b.currency))}</b></div>
      ${o.out ? '<span class="out">Esgotado</span>' : `<a class="btn" href="${esc(payHref(b.id, o.fmt))}">Compre agora</a>`}
    </li>`,
    )
    .join('');

  const body = `<div class="share-grid">
  <div class="cover share-cover">
    <span class="cover-placeholder">${esc(b.title)}</span>
    ${cover ? `<img src="${esc(cover)}" alt="Capa de ${esc(b.title)}" onerror="this.remove()">` : ''}
  </div>
  <div>
    <h1>${esc(b.title)}</h1>
    ${b.author ? `<p class="author">${esc(b.author)}</p>` : ''}
    ${badges ? `<div class="badges">${badges}</div>` : ''}
    ${b.description ? `<p class="desc">${esc(b.description)}</p>` : ''}
    <ul class="prices">${rows}</ul>
    <p class="pay-note">💳 Pague com <b>M-Pesa</b>, <b>e-Mola</b> ou <b>cartão Visa</b>. O livro abre logo a seguir ao pagamento.</p>
    <p class="note" id="have" hidden>Já comprou? <a id="haveLink" href="/ler.html">Abrir o meu livro</a></p>
  </div>
</div>
<script>try{var t=localStorage.getItem('kulera_token');if(t){document.getElementById('have').hidden=false;document.getElementById('haveLink').href='/ler.html?t='+encodeURIComponent(t)}}catch(e){}</script>`;

  const offers = options.map((o) => ({
    '@type': 'Offer',
    price: (o.price / 100).toFixed(2),
    priceCurrency: b.currency,
    availability: o.out ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
    url: canonical,
  }));
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Book',
    name: b.title,
    author: b.author ? { '@type': 'Person', name: b.author } : undefined,
    description: b.description || undefined,
    image: ogImage || undefined,
    url: canonical,
    offers: offers.length ? (offers.length === 1 ? offers[0] : offers) : undefined,
  }).replace(/</g, '\\u003c');

  return pageShell({
    title: `${title} · Kulera+`,
    description,
    canonical,
    body,
    og: {
      type: 'book',
      title: `${b.title}${b.author ? ' de ' + b.author : ''} · Kulera+`,
      description,
      image: ogImage,
      imageAlt: `Capa do livro ${b.title}`,
      jsonLd,
    },
  });
}

function renderNotFound(origin) {
  const body = `<div class="panel" style="text-align:center">
  <h1>Livro não encontrado</h1>
  <p>Este livro já não está disponível na Kulera+. Veja os livros que temos para si.</p>
  <a class="btn" href="/">Ver todos os livros</a>
</div>`;
  return pageShell({
    title: 'Livro não encontrado · Kulera+',
    description: 'Este livro já não está disponível na Kulera+. Veja os livros disponíveis na Kulera+.',
    canonical: origin + '/',
    body,
    og: { type: 'website' },
  });
}

function renderError(origin) {
  const body = `<div class="panel" style="text-align:center">
  <h1>Não foi possível abrir esta página</h1>
  <p>Tente outra vez dentro de alguns instantes, ou abra a montra para ver todos os livros.</p>
  <a class="btn" href="/">Ver todos os livros</a>
</div>`;
  return pageShell({
    title: 'Kulera+ · Livros',
    description: 'Compre e leia livros na Kulera+. Pagamento por M-Pesa, e-Mola ou cartão Visa.',
    canonical: origin + '/',
    body,
    og: { type: 'website' },
  });
}

function sendHtml(res, status, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(status).send(html);
}

export default async function handler(req, res) {
  const id = String(req?.query?.id ?? '').trim();
  const wantsCover = Boolean(req?.query?.capa);
  const origin = siteOrigin(req);

  if (!UUID.test(id)) {
    if (wantsCover) return res.status(404).json({ error: 'not_found' });
    return sendHtml(res, 404, renderNotFound(origin));
  }
  if (wantsCover) return serveCover(req, res, id);

  try {
    const found = await findBook(id);
    if (!found) return sendHtml(res, 404, renderNotFound(origin));
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return sendHtml(res, 200, renderBookPage({ book: found, origin }));
  } catch (e) {
    console.error('livro.error', e?.message || String(e));
    return sendHtml(res, 500, renderError(origin));
  }
}
