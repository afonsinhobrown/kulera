import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { escapeHtml, splitChapters } from '../lib/content.js';
import { resolvePaysuiteCreateUrl, verifySignature } from '../lib/paysuite.js';
import { computeSplit } from '../lib/split.js';

test('split: app + editors + parceiro = bruto, sempre', () => {
  for (const g of [1, 3, 99, 35000, 70000, 123457]) {
    for (const hasPartner of [false, true]) {
      const s = computeSplit(g, hasPartner);
      assert.equal(s.app + s.editors + s.partner, g);
      assert.ok(s.app >= 0 && s.editors >= 0 && s.partner >= 0);
    }
  }
  assert.deepEqual(computeSplit(70000, true), { app: 14000, editors: 7000, partner: 49000 });
  assert.deepEqual(computeSplit(35000, false), { app: 7000, editors: 28000, partner: 0 });
  assert.throws(() => computeSplit(-1, true));
  assert.throws(() => computeSplit(10.5, false));
});

test('capítulos', () => {
  const ch = splitChapters('<h1>Um</h1><p>a</p><h1 id="x">Dois <em>b</em></h1><p>c</p>');
  assert.equal(ch.length, 2);
  assert.equal(ch[1].title, 'Dois b');
  assert.equal(splitChapters('<p>sem títulos</p>')[0].title, 'Parte 1');
  assert.deepEqual(splitChapters(''), []);
  assert.equal(escapeHtml('<b>"x"&</b>'), '&lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;');
});

test('assinatura do webhook', () => {
  const body = '{"event":"payment.success"}';
  const sig = createHmac('sha256', 's').update(body).digest('hex');
  assert.ok(verifySignature(body, sig, 's') && verifySignature(body, 'sha256=' + sig, 's'));
  assert.ok(!verifySignature(body, sig, 'outro') && !verifySignature(body, undefined, 's') && !verifySignature(body + ' ', sig, 's'));
});

test('normalização do URL da PaySuite (corrige api.paysuite.tech para paysuite.tech/api/v1)', () => {
  const prevCreate = process.env.PAYSUITE_CREATE_URL;
  const prevBase = process.env.PAYSUITE_BASE_URL;
  try {
    process.env.PAYSUITE_CREATE_URL = 'https://api.paysuite.tech/v1/payments';
    assert.equal(resolvePaysuiteCreateUrl(), 'https://paysuite.tech/api/v1/payments');
    delete process.env.PAYSUITE_CREATE_URL;
    process.env.PAYSUITE_BASE_URL = 'https://api.paysuite.tech/v1';
    assert.equal(resolvePaysuiteCreateUrl(), 'https://paysuite.tech/api/v1/payments');
  } finally {
    if (prevCreate !== undefined) process.env.PAYSUITE_CREATE_URL = prevCreate;
    else delete process.env.PAYSUITE_CREATE_URL;
    if (prevBase !== undefined) process.env.PAYSUITE_BASE_URL = prevBase;
    else delete process.env.PAYSUITE_BASE_URL;
  }
});

test('o token da PaySuite vem do ambiente e nunca do código', async () => {
  const { resolvePaysuiteToken, createPayment } = await import('../lib/paysuite.js');
  const prevApi = process.env.PAYSUITE_API_KEY;
  const prevTok = process.env.PAYSUITE_TOKEN;
  try {
    delete process.env.PAYSUITE_API_KEY;
    delete process.env.PAYSUITE_TOKEN;
    assert.equal(resolvePaysuiteToken(), '');
    await assert.rejects(
      () => createPayment({ reference: 'X', amountMinor: 1000, description: 'Teste' }),
      /Token da PaySuite não configurado/,
    );
    process.env.PAYSUITE_TOKEN = 'abc123';
    assert.equal(resolvePaysuiteToken(), 'abc123');
    assert.equal(resolvePaysuiteToken('def456'), 'def456'); // token explícito (ex.: vindo do painel) tem prioridade
  } finally {
    if (prevApi !== undefined) process.env.PAYSUITE_API_KEY = prevApi;
    else delete process.env.PAYSUITE_API_KEY;
    if (prevTok !== undefined) process.env.PAYSUITE_TOKEN = prevTok;
    else delete process.env.PAYSUITE_TOKEN;
  }
  // Guarda contra voltar a colar credenciais no código: um token tem o formato "1234|..." com 30+ caracteres.
  const src = readFileSync(new URL('../lib/paysuite.js', import.meta.url), 'utf8');
  assert.ok(!/\d{4}\|[A-Za-z0-9]{30,}/.test(src), 'lib/paysuite.js não deve conter tokens');
});

test('retorno do pagamento usa o domínio do pedido (ignora um SITE_URL errado)', async () => {
  const { resolveSiteUrl } = await import('../lib/payments.js');
  const prev = process.env.SITE_URL;
  try {
    process.env.SITE_URL = 'https://kulera.vercel.app';
    assert.equal(
      resolveSiteUrl({ headers: { host: 'kulera.tecnoincubadora.org', 'x-forwarded-proto': 'https' } }),
      'https://kulera.tecnoincubadora.org',
    );
    assert.equal(
      resolveSiteUrl({ headers: { origin: 'https://kulera.tecnoincubadora.org' } }),
      'https://kulera.tecnoincubadora.org',
    );
    assert.equal(resolveSiteUrl({}), 'https://kulera.vercel.app'); // sem pedido, o SITE_URL é a reserva
  } finally {
    if (prev !== undefined) process.env.SITE_URL = prev;
    else delete process.env.SITE_URL;
  }
});

test('email: cancelamento assinado, quota por plano e envio sem configuração', async () => {
  const { unsubscribeToken, verifyUnsubscribe, unsubscribeUrl, sendEmail, emailConfigured } = await import('../lib/email.js');
  const { promoQuotaForPlan } = await import('../lib/marketing.js');

  const token = unsubscribeToken('Ana@Example.com');
  assert.ok(verifyUnsubscribe('ana@example.com', token));
  assert.ok(!verifyUnsubscribe('outra@example.com', token));
  assert.match(unsubscribeUrl('ana@example.com'), /\/sair\.html\?e=ana%40example\.com&s=[a-f0-9]{64}$/);

  assert.deepEqual(['basic', 'pro', 'premium', 'desconhecido'].map(promoQuotaForPlan), [1, 2, 4, 1]);

  const prev = {
    from: process.env.EMAIL_FROM,
    resend: process.env.RESEND_API_KEY,
    brevo: process.env.BREVO_API_KEY,
  };
  try {
    delete process.env.EMAIL_FROM;
    delete process.env.RESEND_API_KEY;
    delete process.env.BREVO_API_KEY;
    assert.equal(emailConfigured(), false);
    // Sem configuração não envia e não lança: o site continua a funcionar.
    assert.deepEqual(await sendEmail({ to: 'x@y.z', subject: 's', html: '<p>x</p>' }), {
      ok: false,
      error: 'email_not_configured',
    });
  } finally {
    if (prev.from !== undefined) process.env.EMAIL_FROM = prev.from;
    else delete process.env.EMAIL_FROM;
    if (prev.resend !== undefined) process.env.RESEND_API_KEY = prev.resend;
    else delete process.env.RESEND_API_KEY;
    if (prev.brevo !== undefined) process.env.BREVO_API_KEY = prev.brevo;
    else delete process.env.BREVO_API_KEY;
  }
});

test('leitor: bónus de carregamento (10% a partir de 1.000 MT) e palavra-passe', async () => {
  const { topupBonus, makeHash, verifyHash, TOPUP_BONUS_MIN_MINOR } = await import('../lib/reader.js');
  assert.equal(topupBonus(TOPUP_BONUS_MIN_MINOR - 1), 0);
  assert.equal(topupBonus(TOPUP_BONUS_MIN_MINOR), 10000); // 1.000 MT -> 100 MT
  assert.equal(topupBonus(2 * TOPUP_BONUS_MIN_MINOR), 20000);
  assert.equal(topupBonus(150000), 15000);
  const h = makeHash('segredo123');
  assert.ok(h.startsWith('pbkdf2$'));
  assert.ok(verifyHash('segredo123', h));
  assert.ok(!verifyHash('errada', h));
});

