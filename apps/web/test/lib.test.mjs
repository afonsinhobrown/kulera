import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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
