import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { availableLocales, flattenKeys, t } from '../src/i18n.ts';
import { locales, pt } from '../src/locales.ts';

describe('i18n', () => {
  it('traduz e preenche parâmetros', () => {
    assert.equal(t('pt', 'greeting', { name: 'Ana' }), 'Olá, Ana!');
    assert.equal(t('en', 'greeting', { name: 'Ana' }), 'Hello, Ana!');
  });
  it('idioma desconhecido cai no português', () => {
    assert.equal(t('fr', 'nav.plans'), 'Planos');
  });
  it('chave inexistente devolve a própria chave', () => {
    assert.equal(t('pt', 'nao.existe'), 'nao.existe');
  });
  it('parâmetro em falta mantém o marcador', () => {
    assert.equal(t('pt', 'greeting'), 'Olá, {name}!');
  });
  it('todos os idiomas têm exactamente as mesmas chaves que o português', () => {
    const base = Object.keys(flattenKeys(pt)).sort();
    for (const code of availableLocales()) {
      assert.deepEqual(Object.keys(flattenKeys(locales[code])).sort(), base, `idioma ${code}`);
    }
  });
});
