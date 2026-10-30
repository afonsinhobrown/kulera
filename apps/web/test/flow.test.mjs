import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Pool, S } from './fake-pg.js';

globalThis.__kuleraPool = new Pool(); // base de dados falsa: testa a lógica sem PostgreSQL
process.env.PAYSUITE_WEBHOOK_SECRET = 'seg';
process.env.PAYSUITE_CREATE_URL = 'https://ps.test/pay';
process.env.PAYSUITE_TOKEN = 't';
process.env.SITE_URL = 'https://site.test';
delete process.env.SANDBOX;

let n = 0;
let failNext = false;
let failWithCompanyError = false;
let remotePaidIds = new Set();

globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/payments/') && (!opts.method || opts.method === 'GET')) {
    const id = decodeURIComponent(String(url).split('/payments/')[1]);
    return {
      ok: true,
      json: async () => ({ data: { id, status: remotePaidIds.has(id) ? 'paid' : 'pending' } }),
    };
  }
  if (failWithCompanyError) {
    return {
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ status: 'error', message: 'API access is only available for company accounts.' }),
    };
  }
  if (failNext) {
    return { ok: false, status: 500, text: async () => 'Gateway error' };
  }
  n++;
  return {
    ok: true,
    json: async () => ({ data: { id: 'ps_' + n, checkout_url: 'https://pay.test/' + n } }),
  };
};

const { default: checkout } = await import('../api/checkout.js');
const { default: webhook } = await import('../api/webhook.js');
const { default: chapter } = await import('../api/chapter.js');
const { default: status } = await import('../api/status.js');
const { default: books } = await import('../api/books.js');
const { default: bookCfg } = await import('../api/book.js');
const { default: lead } = await import('../api/lead.js');
const { default: subscriptions } = await import('../api/subscriptions.js');
const { default: partnerSubmit } = await import('../api/partner-submit.js');
const { default: admin } = await import('../api/admin.js');
const { setSandbox } = await import('../lib/payments.js');

const res = () => {
  const r = {
    code: 200,
    h: {},
    setHeader(k, v) {
      r.h[k] = v;
    },
    status(c) {
      r.code = c;
      return r;
    },
    json(b) {
      r.body = b;
      return r;
    },
    send(b) {
      r.body = b;
      return r;
    },
  };
  return r;
};
const call = async (h, req) => {
  const r = res();
  await h(req, r);
  return r;
};
const hook = async (event, data, sig) => {
  const raw = JSON.stringify({ event, data });
  const req = (async function* () {
    yield Buffer.from(raw);
  })();
  req.method = 'POST';
  req.headers = { 'x-signature': sig ?? createHmac('sha256', 'seg').update(raw).digest('hex') };
  const r = res();
  await webhook(req, r);
  return r;
};

const U = '00000000-0000-4000-8000-0000000000';
S.partners.push({ id: U + '01', name: 'Editora Sol', phone: '841112223', email: 'sol@editora.mz', commission_bps: 3000, status: 'active' });
S.partnerUsers.push({ id: U + '51', partner_id: U + '01', email: 'sol@editora.mz', status: 'active' });
S.books.push(
  {
    id: U + '11',
    title: 'Livro Parceiro',
    partner_id: U + '01',
    price_minor: 70000,
    currency: 'MZN',
    status: 'published',
    cover_url: 'data:image/jpeg;base64,' + 'A'.repeat(2000),
    content_html: '<h1>Cap Um</h1><p>a</p><h1>Cap Dois</h1><p>b</p>',
  },
  {
    id: U + '12',
    title: 'Livro Kulera',
    partner_id: null,
    price_minor: 35000,
    currency: 'MZN',
    status: 'published',
    content_html: '<h1>Único</h1><p>x</p>',
  },
  { id: U + '13', title: 'Rascunho', partner_id: null, price_minor: 1000, currency: 'MZN', status: 'draft', content_html: '<h1>x</h1>' },
  { id: U + '14', title: 'Sem conteúdo', partner_id: null, price_minor: 1000, currency: 'MZN', status: 'published', content_html: null },
  {
    id: U + '15',
    title: 'Livro Aprovado Pendente Taxa',
    partner_id: U + '01',
    price_minor: 50000,
    publication_fee_minor: 50000,
    publication_fee_paid_at: null,
    currency: 'MZN',
    status: 'draft',
    content_html: '<h1>Cap Taxa</h1><p>ok</p>',
  },
);

// 1. Catálogo: só publicados com conteúdo e capa preservada
const cat = await call(books, { method: 'GET' });
assert.deepEqual(cat.body.map((b) => b.title).sort(), ['Livro Kulera', 'Livro Parceiro']);
assert.ok(cat.body.find((b) => b.title === 'Livro Parceiro').coverUrl.startsWith('data:image/jpeg;base64,'));

// 2. Compra de e-book de parceiro: preço vem do catálogo
const body = { bookId: U + '11', name: 'Ana Silva', phone: '84 123 4567', email: '', amount: 1 };
const c1 = await call(checkout, { method: 'POST', body });
assert.equal(c1.code, 200);
assert.ok(c1.body.checkoutUrl.startsWith('https://pay.test/'));
assert.equal(S.orders[0].amount_minor, 70000);
assert.equal(S.orders[0].buyer_phone, '841234567');
const token = c1.body.token;
assert.equal((await call(status, { query: { t: token } })).body.status, 'pending');

// Sem pagamento, o livro não abre
assert.equal((await call(chapter, { query: { t: token, i: '0' } })).code, 403);
assert.equal((await call(chapter, { query: { t: 'x'.repeat(64) } })).code, 403);

// Webhook inválido não muda nada
assert.equal((await hook('payment.success', { id: 'ps_1' }, 'errada')).code, 401);
assert.equal(S.orders[0].status, 'pending');
// Cancelado não activa
await hook('payment.cancelled', { id: 'ps_1' });
assert.notEqual(S.orders[0].status, 'paid');

// Pagamento confirmado via webhook: activa e divide a receita (20% App + 10% Editores + 70% Parceiro)
const w1 = await hook('payment.success', { id: 'ps_1' });
assert.equal(w1.body.result, 'applied');
assert.equal(S.orders[0].status, 'paid');
assert.deepEqual([S.sales[0].commission, S.sales[0].partner, S.sales[0].app, S.sales[0].editors], [21000, 49000, 14000, 7000]);

// Webhook repetido não duplica
assert.equal((await hook('payment.success', { id: 'ps_1' })).body.result, 'duplicate');
assert.equal(S.sales.length, 1);

// Leitura após pagamento, com marca de água e capítulos
const ch = await call(chapter, { query: { t: token, i: '1' } });
assert.equal(ch.code, 200);
assert.equal(ch.body.total, 2);
assert.deepEqual(ch.body.toc, ['Cap Um', 'Cap Dois']);
assert.ok(ch.body.html.includes('Cap Dois') && ch.body.html.includes('Exemplar de Ana Silva'));
assert.equal((await call(chapter, { query: { t: token, i: '9' } })).code, 400);

// 3. Livro da própria Kulera: 20% App + 80% Editores (0% parceiro)
const c2 = await call(checkout, { method: 'POST', body: { ...body, bookId: U + '12' } });
assert.equal(c2.code, 200);
await hook('payment.success', { id: 'ps_2' });
assert.deepEqual([S.sales[1].commission, S.sales[1].partner, S.sales[1].partner_id, S.sales[1].app, S.sales[1].editors], [35000, 0, null, 7000, 28000]);

// 4. Verificação activa de pagamento (polling PaySuite no /api/status mesmo antes de chegar o webhook)
const c3 = await call(checkout, { method: 'POST', body: { ...body, bookId: U + '12' } });
assert.equal(c3.code, 200);
remotePaidIds.add('ps_3');
const stPolled = await call(status, { method: 'GET', query: { t: c3.body.token } });
assert.equal(stPolled.body.status, 'paid');

// 5. Subscrição de plano de parceiro via PaySuite
await call(subscriptions, { method: 'GET' }); // inicializa planos
const basicPlan = S.plans[0];
const subPay = await call(subscriptions, {
  method: 'POST',
  headers: { 'x-partner-token': U + '51' },
  body: { planId: basicPlan.id, phone: '84 999 8888' },
});
assert.equal(subPay.code, 200);
await hook('payment.success', { id: 'ps_4' });
assert.equal(S.subscriptions.length, 1);
assert.equal(S.subscriptions[0].partner_id, U + '01');

// 6. Pagamento de taxa de publicação (500 MT) publica o livro automaticamente
const feePay = await call(partnerSubmit, {
  method: 'POST',
  headers: { 'x-partner-token': U + '51' },
  body: { action: 'pay_fee', bookId: U + '15', phone: '841112223' },
});
assert.equal(feePay.code, 200);
await hook('payment.success', { id: 'ps_5' });
assert.equal(S.publicationFees.length, 1);
assert.equal(S.books.find((b) => b.id === U + '15').status, 'published');

// 7. Modo Sandbox + Fallback de Simulação quando a conta PaySuite não é empresarial (403)
await setSandbox(true);
failWithCompanyError = true;
const cSim = await call(checkout, { method: 'POST', body: { ...body, bookId: U + '11' } });
assert.equal(cSim.code, 200);
assert.equal(cSim.body.sandbox, true);
assert.equal(cSim.body.simulated, true);
assert.equal(cSim.body.amountMinor, 1000); // 10 MT em sandbox
assert.ok(cSim.body.checkoutUrl.includes('/pagamento.html?t=') && cSim.body.checkoutUrl.includes('sim=1'));

// O catálogo/configuração pública diz se o modo de teste está activo e qual o valor cobrado
const cfgSandbox = await call(bookCfg, { method: 'GET' });
assert.equal(cfgSandbox.body.sandbox, true);
assert.equal(cfgSandbox.body.sandboxPriceMinor, 1000);

const simConfirm = await call(status, {
  method: 'POST',
  body: { token: cSim.body.token, simulate: 'paid' },
});
assert.equal(simConfirm.code, 200);
assert.equal(simConfirm.body.status, 'paid');
failWithCompanyError = false;
await setSandbox(false);
assert.equal((await call(bookCfg, { method: 'GET' })).body.sandbox, false);

// 8. Modificar capa do livro no Admin actualiza imediatamente a montra (/api/books sem cache antigo) e venda física exige endereço
const newCover = 'data:image/jpeg;base64,' + 'B'.repeat(2500);
const admSave = await call(admin, {
  method: 'POST',
  headers: { 'x-admin-key': 'kulera' },
  body: {
    action: 'save_book',
    id: U + '11',
    title: 'Livro Parceiro',
    author: 'Autor Sol',
    priceMinor: 70000,
    pricePhysicalMinor: 120000,
    hasDigital: true,
    hasPhysical: true,
    stock: 5,
    partnerId: U + '01',
    status: 'published',
    coverUrl: newCover,
  },
});
assert.equal(admSave.code, 200);
const catAfter = await call(books, { method: 'GET' });
assert.ok(String(catAfter.h['Cache-Control']).includes('no-store'));
const updatedBook = catAfter.body.find((b) => b.id === U + '11');
assert.equal(updatedBook.coverUrl, newCover);
assert.equal(updatedBook.hasPhysical, true);
assert.equal(updatedBook.physicalPriceMinor, 120000);

// Venda física sem endereço deve falhar com 400 invalid_address
const physNoAddr = await call(checkout, {
  method: 'POST',
  body: { bookId: U + '11', format: 'physical', name: 'Carlos', phone: '841234567' },
});
assert.equal(physNoAddr.code, 400);
assert.equal(physNoAddr.body.error, 'invalid_address');

// Venda física com endereço válido guarda morada e desconta stock
const physOk = await call(checkout, {
  method: 'POST',
  body: {
    bookId: U + '11',
    format: 'physical',
    name: 'Carlos',
    phone: '841234567',
    shippingAddress: 'Av. Julius Nyerere 123, Polana',
    shippingCity: 'Maputo',
  },
});
assert.equal(physOk.code, 200);
assert.equal(physOk.body.format, 'physical');
assert.equal(S.books.find((b) => b.id === U + '11').stock, 4);
const lastOrder = S.orders[S.orders.length - 1];
assert.equal(lastOrder.type, 'physical');
assert.equal(lastOrder.shipping_address, 'Av. Julius Nyerere 123, Polana');
assert.equal(lastOrder.shipping_city, 'Maputo');

// 9. Validações e protecções de catálogo
for (const id of [U + '13', U + '14', U + '99']) {
  assert.equal((await call(checkout, { method: 'POST', body: { ...body, bookId: id } })).code, 404);
}
assert.equal((await call(checkout, { method: 'POST', body: { ...body, bookId: 'x' } })).code, 400);
assert.equal((await call(checkout, { method: 'POST', body: { ...body, bookId: U + '11', phone: '12' } })).code, 400);

// PaySuite em baixo fora de sandbox: erro 502 claro com detalhe
failNext = true;
const cFail = await call(checkout, { method: 'POST', body });
assert.equal(cFail.code, 502);
assert.ok(cFail.body.detail);
failNext = false;

// Leads: validação e armadilha de robôs
assert.equal((await call(lead, { method: 'POST', body: { name: 'A', kind: 'x', phone: '1' } })).code, 400);
assert.equal((await call(lead, { method: 'POST', body: { website: 'spam' } })).code, 200);

// 10. Link de partilha (/livro/<id>): mostra capa, preços, "Compre agora" e leva à página de pagamento do livro
const { default: livroPage } = await import('../api/livro.js');
S.books.push({
  id: U + '21',
  title: 'Livro Partilhado',
  author: 'Autor Partilha',
  description: 'Sinopse do livro partilhado.',
  price_minor: 45000,
  price_physical_minor: 90000,
  currency: 'MZN',
  status: 'published',
  has_digital: true,
  has_physical: true,
  cover_url: 'https://cdn.test/capa.jpg',
  content_html: '<h1>Cap</h1><p>x</p>',
});
const share = await call(livroPage, { query: { id: U + '21' } });
assert.equal(share.code, 200);
assert.ok(String(share.h['Content-Type']).includes('text/html'));
assert.ok(String(share.h['Cache-Control']).includes('public'));
const shareHtml = share.body;
assert.ok(shareHtml.includes('Livro Partilhado'));
assert.ok(shareHtml.includes('og:image') && shareHtml.includes('https://site.test/api/livro?id=' + U + '21') && shareHtml.includes('capa=1'));
assert.ok(shareHtml.includes('450,00') && shareHtml.includes('900,00')); // preços do catálogo
assert.ok((shareHtml.match(/Compre agora/g) || []).length >= 2); // um botão por formato
assert.ok(shareHtml.includes('comprar.html?id=' + encodeURIComponent(U + '21') + '&amp;fmt=digital'));
assert.ok(shareHtml.includes('&amp;fmt=physical'));
assert.ok(shareHtml.includes('og:description') && shareHtml.includes('Compre agora'));

// A capa é servida como imagem (?capa=1), mesmo quando está guardada em base64 no painel (og:image funciona sempre)
const shareData = await call(livroPage, { query: { id: U + '11' } });
assert.equal(shareData.code, 200);
assert.ok(shareData.body.includes('/api/livro?id=' + U + '11') && shareData.body.includes('capa=1'));
const capaData = await call(livroPage, { query: { id: U + '11', capa: '1' } });
assert.equal(capaData.code, 200);
assert.ok(String(capaData.h['Content-Type']).startsWith('image/'));
assert.equal(capaData.h['X-Content-Type-Options'], 'nosniff');
assert.ok(Buffer.isBuffer(capaData.body) && capaData.body.length > 100);
const capaExternal = await call(livroPage, { query: { id: U + '21', capa: '1' } });
assert.equal(capaExternal.code, 302);
assert.equal(capaExternal.h['Location'], 'https://cdn.test/capa.jpg');
assert.equal((await call(livroPage, { query: { id: U + '99', capa: '1' } })).code, 404);

// Livro só digital e sem capa: um único "Compre agora" e nenhum og:image partido
const shareDigital = await call(livroPage, { query: { id: U + '12' } });
assert.equal(shareDigital.code, 200);
assert.ok(shareDigital.body.includes('350,00'));
assert.ok(shareDigital.body.includes('&amp;fmt=digital') && !shareDigital.body.includes('fmt=physical'));
assert.ok(!shareDigital.body.includes('og:image'));

// Livro inexistente ou id inválido: página amigável, sem quebrar o link
assert.equal((await call(livroPage, { query: { id: U + '99' } })).code, 404);
assert.equal((await call(livroPage, { query: { id: 'x' } })).code, 404);
assert.ok((await call(livroPage, { query: { id: U + '99' } })).body.includes('Ver todos os livros'));

// 11. Reconciliação: confirma pedidos pendentes junto da PaySuite (o webhook da conta é partilhado com outros sistemas)
const c11 = await call(checkout, { method: 'POST', body: { ...body, bookId: U + '12' } });
assert.equal(c11.code, 200);
const order11 = S.orders.find((o) => o.token === c11.body.token);
assert.equal(order11.status, 'pending');
remotePaidIds.add(order11.provider_payment_id);
const rec = await call(admin, {
  method: 'POST',
  headers: { 'x-admin-key': 'kulera' },
  body: { action: 'reconcile_payments' },
});
assert.equal(rec.code, 200);
assert.equal(rec.body.ok, true);
assert.ok(rec.body.paid >= 1);
assert.equal(S.orders.find((o) => o.token === c11.body.token).status, 'paid');

// 12. Livro em PDF: o leitor mostra o PDF no visualizador, sempre atrás do token de compra
const PDF_B64 = 'JVBERi0xLjQKJcfsj6IKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4KJSVFT0YK';
S.books.push({
  id: U + '22',
  title: 'Livro PDF',
  author: 'Autor',
  price_minor: 1000,
  currency: 'MZN',
  status: 'published',
  has_digital: true,
  content_html: 'data:application/pdf;base64,' + PDF_B64,
});
const c12 = await call(checkout, { method: 'POST', body: { ...body, bookId: U + '22' } });
assert.equal(c12.code, 200);
const o12 = S.orders.find((o) => o.token === c12.body.token);
await hook('payment.success', { id: o12.provider_payment_id });
const pdfMeta = await call(chapter, { query: { t: c12.body.token } });
assert.equal(pdfMeta.code, 200);
assert.equal(pdfMeta.body.pdf, true);
assert.equal(pdfMeta.body.pdfUrl, '/api/chapter?t=' + c12.body.token + '&pdf=1');
const pdfBytes = await call(chapter, { query: { t: c12.body.token, pdf: '1' } });
assert.equal(pdfBytes.code, 200);
assert.ok(String(pdfBytes.h['Content-Type']).includes('application/pdf'));
assert.ok(Buffer.isBuffer(pdfBytes.body) && pdfBytes.body.length > 10);

// 13. Livro antigo carregado como PDF em texto: mensagem clara em vez de código do PDF
S.books.push({
  id: U + '23',
  title: 'PDF Antigo',
  author: 'Autor',
  price_minor: 1000,
  currency: 'MZN',
  status: 'published',
  has_digital: true,
  content_html: '%PDF-1.4\nconteudo antigo',
});
const c13 = await call(checkout, { method: 'POST', body: { ...body, bookId: U + '23' } });
const o13 = S.orders.find((o) => o.token === c13.body.token);
await hook('payment.success', { id: o13.provider_payment_id });
const pdfLegacy = await call(chapter, { query: { t: c13.body.token } });
assert.equal(pdfLegacy.code, 409);
assert.equal(pdfLegacy.body.error, 'pdf_legacy');

console.log('fluxo completo OK');
