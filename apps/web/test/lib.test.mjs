import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { escapeHtml, splitChapters } from '../lib/content.js';
import { verifySignature } from '../lib/paysuite.js';
import { computeSplit } from '../lib/split.js';

test('split: comissão + parceiro = bruto, sempre', () => {
  for (const g of [1, 3, 99, 35000, 70000, 123457]) for (const bps of [0, 1, 333, 2000, 9999, 10000]) {
    const s = computeSplit(g, bps); assert.equal(s.commission + s.partner, g); assert.ok(s.commission >= 0 && s.partner >= 0);
  }
  assert.deepEqual(computeSplit(70000, 2000), { commission: 14000, partner: 56000 });
  assert.throws(() => computeSplit(100, 10001)); assert.throws(() => computeSplit(10.5, 100));
});
test('capítulos', () => {
  const ch = splitChapters('<h1>Um</h1><p>a</p><h1 id="x">Dois <em>b</em></h1><p>c</p>');
  assert.equal(ch.length, 2); assert.equal(ch[1].title, 'Dois b');
  assert.equal(splitChapters('<p>sem títulos</p>')[0].title, 'Parte 1'); assert.deepEqual(splitChapters(''), []);
  assert.equal(escapeHtml('<b>"x"&</b>'), '&lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;');
});
test('assinatura do webhook', () => {
  const body = '{"event":"payment.success"}', sig = createHmac('sha256', 's').update(body).digest('hex');
  assert.ok(verifySignature(body, sig, 's') && verifySignature(body, 'sha256=' + sig, 's'));
  assert.ok(!verifySignature(body, sig, 'outro') && !verifySignature(body, undefined, 's') && !verifySignature(body + ' ', sig, 's'));
});
