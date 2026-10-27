import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Pool, S } from './fake-pg.js';
globalThis.__kuleraPool = new Pool(); // base de dados falsa: testa a lógica sem PostgreSQL
process.env.PAYSUITE_WEBHOOK_SECRET = 'seg'; process.env.PAYSUITE_CREATE_URL = 'https://ps.test/pay'; process.env.PAYSUITE_TOKEN = 't'; process.env.SITE_URL = 'https://site.test';
let n = 0; let failNext = false;
globalThis.fetch = async () => { if (failNext) return { ok: false, status: 500 }; n++; return { ok: true, json: async () => ({ data: { id: 'ps_' + n, checkout_url: 'https://pay.test/' + n } }) }; };
const { default: checkout } = await import('../api/checkout.js'); const { default: webhook } = await import('../api/webhook.js');
const { default: chapter } = await import('../api/chapter.js'); const { default: status } = await import('../api/status.js'); const { default: books } = await import('../api/books.js');
const { default: lead } = await import('../api/lead.js');
const res = () => { const r = { code: 200, h: {}, setHeader(k, v) { r.h[k] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const call = async (h, req) => { const r = res(); await h(req, r); return r; };
const hook = async (event, data, sig) => { const raw = JSON.stringify({ event, data }); const req = (async function* () { yield Buffer.from(raw); })(); req.method = 'POST'; req.headers = { 'x-signature': sig ?? createHmac('sha256', 'seg').update(raw).digest('hex') }; const r = res(); await webhook(req, r); return r; };

const U = '00000000-0000-4000-8000-0000000000';
S.partners.push({ id: U + '01', commission_bps: 2000 });
S.books.push({ id: U + '11', title: 'Livro Parceiro', partner_id: U + '01', price_minor: 70000, currency: 'MZN', status: 'published', content_html: '<h1>Cap Um</h1><p>a</p><h1>Cap Dois</h1><p>b</p>' },
  { id: U + '12', title: 'Livro Kulera', partner_id: null, price_minor: 35000, currency: 'MZN', status: 'published', content_html: '<h1>Único</h1><p>x</p>' },
  { id: U + '13', title: 'Rascunho', partner_id: null, price_minor: 1000, currency: 'MZN', status: 'draft', content_html: '<h1>x</h1>' },
  { id: U + '14', title: 'Sem conteúdo', partner_id: null, price_minor: 1000, currency: 'MZN', status: 'published', content_html: null });

// catálogo: só publicados com conteúdo
const cat = await call(books, { method: 'GET' });
assert.deepEqual(cat.body.map((b) => b.title).sort(), ['Livro Kulera', 'Livro Parceiro']);
assert.ok(cat.body.every((b) => !('content_html' in b) && !('contentHtml' in b)));

// compra: preço vem do catálogo; o cliente não envia valor
const body = { bookId: U + '11', name: 'Ana Silva', phone: '84 123 4567', email: '', amount: 1 };
const c1 = await call(checkout, { method: 'POST', body });
assert.equal(c1.code, 200); assert.ok(c1.body.checkoutUrl.startsWith('https://pay.test/'));
assert.equal(S.orders[0].amount_minor, 70000); assert.equal(S.orders[0].buyer_phone, '841234567');
const token = c1.body.token;
assert.equal((await call(status, { query: { t: token } })).body.status, 'pending');

// sem pagamento, o livro não abre
assert.equal((await call(chapter, { query: { t: token, i: '0' } })).code, 403);
assert.equal((await call(chapter, { query: { t: 'x'.repeat(64) } })).code, 403);

// webhook inválido não muda nada
assert.equal((await hook('payment.success', { id: 'ps_1' }, 'errada')).code, 401);
assert.equal(S.orders[0].status, 'pending');
// cancelado não activa
await hook('payment.cancelled', { id: 'ps_1' }); assert.notEqual(S.orders[0].status, 'paid');

// pagamento confirmado: activa e divide a receita (20% Kulera, 80% parceiro)
const w1 = await hook('payment.success', { id: 'ps_1' });
assert.equal(w1.body.result, 'applied'); assert.equal(S.orders[0].status, 'paid');
assert.deepEqual([S.sales[0].commission, S.sales[0].partner, S.sales[0].bps], [14000, 56000, 2000]);
// repetido não duplica
assert.equal((await hook('payment.success', { id: 'ps_1' })).body.result, 'duplicate'); assert.equal(S.sales.length, 1);

// agora lê, com marca de água e capítulos
const ch = await call(chapter, { query: { t: token, i: '1' } });
assert.equal(ch.code, 200); assert.equal(ch.body.total, 2); assert.deepEqual(ch.body.toc, ['Cap Um', 'Cap Dois']);
assert.ok(ch.body.html.includes('Cap Dois') && ch.body.html.includes('Exemplar de Ana Silva'));
assert.equal((await call(chapter, { query: { t: token, i: '9' } })).code, 400);

// livro da Kulera: 100% Kulera
const c2 = await call(checkout, { method: 'POST', body: { ...body, bookId: U + '12' } });
await hook('payment.success', { id: 'ps_2' });
assert.deepEqual([S.sales[1].commission, S.sales[1].partner, S.sales[1].partner_id], [35000, 0, null]);

// não se vende rascunho, nem livro sem conteúdo, nem id inválido
for (const id of [U + '13', U + '14', U + '99']) assert.equal((await call(checkout, { method: 'POST', body: { ...body, bookId: id } })).code, 404);
assert.equal((await call(checkout, { method: 'POST', body: { ...body, bookId: 'x' } })).code, 400);
assert.equal((await call(checkout, { method: 'POST', body: { ...body, bookId: U + '11', phone: '12' } })).code, 400);
// PaySuite em baixo: erro claro
failNext = true; assert.equal((await call(checkout, { method: 'POST', body })).code, 502); failNext = false;
// leads: validação e armadilha de robôs
assert.equal((await call(lead, { method: 'POST', body: { name: 'A', kind: 'x', phone: '1' } })).code, 400);
assert.equal((await call(lead, { method: 'POST', body: { website: 'spam' } })).code, 200);
console.log('fluxo completo OK');
