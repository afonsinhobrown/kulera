import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { escapeHtml, splitChapters } from '../lib/content.js';
import { resolvePaysuiteCreateUrl, verifySignature } from '../lib/paysuite.js';
import { SCENARIOS, gatewayFee, goldenRule, splitSale } from '../lib/split.js';

test('divisão: as partes somam sempre o bruto, nos três cenários', () => {
  for (const g of [1, 3, 99, 35000, 70000, 123457]) {
    for (const scenario of [SCENARIOS.KULERA_AUTHOR, SCENARIOS.RELATED_AUTHOR, SCENARIOS.MARKET]) {
      const s = splitSale({ grossMinor: g, scenario, authorShareBps: 5000 });
      assert.equal(s.author + s.publisher + s.kulera + s.emilio + s.techNet + s.gateway, g);
      assert.ok(s.author >= 0 && s.publisher >= 0 && s.techNet >= 0);
      assert.equal(s.golden.ok, true);
    }
  }
  assert.throws(() => splitSale({ grossMinor: -1, scenario: 'C' }));
  assert.throws(() => splitSale({ grossMinor: 10.5, scenario: 'C' }));
  assert.throws(() => splitSale({ grossMinor: 1000, scenario: 'Z' }));
});

test('cenário C: 30% da plataforma (gateway dentro) e 70% da editora do mercado', () => {
  const s = splitSale({ grossMinor: 100000, scenario: SCENARIOS.MARKET });
  assert.deepEqual([s.tech, s.gateway, s.techNet, s.publisher], [30000, 7000, 23000, 70000]);
});

test('cenário A: autor recebe o combinado, Kulera 0%, resto para a TecnoIncubadora', () => {
  const porPercentagem = splitSale({ grossMinor: 100000, scenario: SCENARIOS.KULERA_AUTHOR, authorShareBps: 5000 });
  assert.deepEqual([porPercentagem.author, porPercentagem.kulera, porPercentagem.techNet, porPercentagem.publisher], [50000, 0, 43000, 0]);

  const porValorFixo = splitSale({ grossMinor: 100000, scenario: SCENARIOS.KULERA_AUTHOR, authorAmountMinor: 25000 });
  assert.equal(porValorFixo.author, 25000);
  assert.equal(porValorFixo.techNet, 68000);
});

test('cenário B: o Emílio não leva royalties — ganha pelo capital', () => {
  const s = splitSale({ grossMinor: 100000, scenario: SCENARIOS.RELATED_AUTHOR, authorShareBps: 5000 });
  assert.deepEqual([s.author, s.publisher, s.kulera, s.techNet], [0, 0, 0, 93000]);
});

test('regra de ouro: o lado Kulera nunca fica acima da TecnoIncubadora', () => {
  assert.equal(goldenRule({ kulera: 0, emilio: 0, tech: 43000 }).ok, true);
  assert.equal(goldenRule({ kulera: 43000, emilio: 0, tech: 43000 }).ok, true, 'empatar é permitido');
  const bad = goldenRule({ kulera: 30000, emilio: 20000, tech: 40000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.excess, 10000);
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
    assert.equal(resolvePaysuiteToken('def456'), 'def456'); // token explícito passado internamente
  } finally {
    if (prevApi !== undefined) process.env.PAYSUITE_API_KEY = prevApi;
    else delete process.env.PAYSUITE_API_KEY;
    if (prevTok !== undefined) process.env.PAYSUITE_TOKEN = prevTok;
    else delete process.env.PAYSUITE_TOKEN;
  }
  // Guarda contra voltar a colar credenciais no código: um token tem o formato "1234|..." com 30+ caracteres.
  const src = readFileSync(new URL('../lib/paysuite.js', import.meta.url), 'utf8');
  assert.ok(!/\d{4}\|[A-Za-z0-9]{30,}/.test(src), 'lib/paysuite.js não deve conter tokens');
  // O token de pagamento não é guardado nem lido da base de dados nem exposto no painel.
  const paySrc = readFileSync(new URL('../lib/payments.js', import.meta.url), 'utf8');
  const adminSrc = readFileSync(new URL('../api/admin.js', import.meta.url), 'utf8');
  assert.ok(!/paysuite_token/i.test(paySrc), 'lib/payments.js não deve ler/guardar paysuite_token');
  assert.ok(!/key='paysuite_token'|paysuiteTokenHint|save_paysuite_token/i.test(adminSrc), 'api/admin.js não deve guardar nem expor o token');
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

test('Revisão V3: planos mensais e créditos temporários', async () => {
  const { DEFAULT_PLANS } = await import('../lib/plans.js');
  assert.deepEqual(
    DEFAULT_PLANS.map((p) => [p.code, p.name, p.price_minor, p.max_publications]),
    [
      ['basic', 'Básico', 50000, 2],
      ['pro', 'Padrão', 250000, 15],
      ['premium', 'Premium', 750000, null],
    ],
  );

  const { CREDIT_PACKS, packByCode, packByPrice } = await import('../lib/credits.js');
  assert.deepEqual(
    CREDIT_PACKS.map((p) => [p.code, p.priceMinor, p.slots, p.days]),
    [
      ['bronze', 20000, 1, 10],
      ['prata', 60000, 2, 15],
      ['ouro', 100000, 5, 20],
    ],
  );
  assert.equal(packByCode('bronze').slots, 1);
  assert.equal(packByCode('p600').code, 'prata'); // código antigo continua válido
  assert.equal(packByPrice(100000).slots, 5);
});

test('saques: 3 meses contam-se a partir do último saque pago', async () => {
  const { addDays, PROFIT_PERIOD_DAYS } = await import('../lib/withdrawals.js');
  assert.equal(PROFIT_PERIOD_DAYS, 90);
  const dia = new Date('2026-11-05T12:00:00Z');
  assert.equal(addDays(dia, 90).toISOString(), '2027-02-03T12:00:00.000Z');
});

test('autor: enquanto faltar um dado, a conta fica presa no formulário', async () => {
  const { missingFields, isComplete } = await import('../lib/author-auth.js');
  const completo = {
    full_name: 'Autor',
    nuit: '123456789',
    bi_number: '110100123456A',
    default_share_bps: 5000,
    payout_method: 'mpesa',
    payout_account: '841234567',
  };
  assert.equal(isComplete(completo), true);
  assert.deepEqual(missingFields({ ...completo, nuit: null }), ['NUIT']);
  assert.deepEqual(missingFields({ ...completo, bi_number: '  ' }), ['BI']);
  assert.deepEqual(missingFields({ ...completo, default_share_bps: 0 }), ['percentagem na venda']);
  assert.deepEqual(missingFields({ ...completo, payout_method: 'banco' }), ['forma de recebimento']);
  assert.deepEqual(missingFields({ ...completo, payout_account: '' }), ['conta de recebimento']);
  assert.deepEqual(missingFields(null), ['registo']);
  // O Emílio é parte relacionada: 0% é a regra, não é dado em falta.
  assert.equal(isComplete({ ...completo, is_related: true, default_share_bps: 0 }), true);
});

test('gateway 7% nas duas pontas do fluxo', async () => {
  assert.equal(gatewayFee(20000), 1400); // 200 MT -> 14 MT
  assert.equal(gatewayFee(100000), 7000); // 1.000 MT -> 70 MT
  assert.throws(() => gatewayFee(-1));

  const bronzeNet = 20000 - gatewayFee(20000); // 186 MT
  const venda = splitSale({ grossMinor: 100000, scenario: SCENARIOS.MARKET });
  assert.equal(venda.tech, 30000); // 30% retidos, gateway incluído
  assert.equal(venda.techNet, 23000); // 230 MT depois do gateway
  assert.equal(venda.publisher, 70000);
  assert.equal(bronzeNet + venda.techNet, 41600);
});

test('tolerância de 3 dias, cobertura durante a tolerância e avisos 72h/24h', async () => {
  const { addDays, graceDeadline, warningDue, subscriptionCovers } = await import('../lib/lifecycle.js');
  const now = new Date('2026-11-05T12:00:00Z');
  assert.equal(graceDeadline(now).toISOString(), '2026-11-08T12:00:00.000Z');

  assert.ok(subscriptionCovers({ status: 'active', ends_at: addDays(now, 1) }, now));
  assert.ok(
    subscriptionCovers(
      { status: 'past_due', ends_at: addDays(now, -1), grace_ends_at: addDays(now, 2) },
      now,
    ),
  );
  assert.ok(!subscriptionCovers({ status: 'expired', ends_at: addDays(now, -1) }, now));
  assert.ok(!subscriptionCovers({ status: 'past_due', ends_at: addDays(now, -1), grace_ends_at: addDays(now, -1) }, now));

  assert.equal(warningDue(addDays(now, 3), now), 72);
  assert.equal(warningDue(addDays(now, 0.5), now), 24);
  assert.equal(warningDue(addDays(now, -1), now), null);
  assert.equal(warningDue(addDays(now, 3), now, { h72: true }), null);
  assert.equal(warningDue(addDays(now, 0.5), now, { h24: true }), null);
});

