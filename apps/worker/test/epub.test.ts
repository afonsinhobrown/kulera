import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConversionError, buildPandocArgs, convertToEpub } from '../src/epub/convert.ts';
import { validateEpubMetadata } from '../src/epub/metadata.ts';

const good = { title: 'Terra Sonâmbula', author: 'Autor Exemplo', publisher: 'Kulera', language: 'pt-MZ' };

describe('metadados EPUB', () => {
  it('válidos', () => {
    assert.deepEqual(validateEpubMetadata(good, true), []);
  });
  it('lista o que falta', () => {
    const problems = validateEpubMetadata({ title: ' ', language: 'Português' }, false);
    assert.ok(problems.includes('Falta o título.'));
    assert.ok(problems.includes('Falta o autor.'));
    assert.ok(problems.includes('Falta a editora.'));
    assert.ok(problems.includes('Falta a capa.'));
    assert.ok(problems.some((p) => p.includes('idioma deve estar')));
  });
  it('valida o formato da data', () => {
    assert.ok(validateEpubMetadata({ ...good, date: '26/10/2026' }, true).length > 0);
    assert.deepEqual(validateEpubMetadata({ ...good, date: '2026-10-26' }, true), []);
  });
});

describe('argumentos do Pandoc', () => {
  it('inclui metadados, capa e ficheiro de origem no fim', () => {
    const args = buildPandocArgs({ sourcePath: 'in.docx', outputPath: 'out.epub', metadata: { ...good, identifier: '978-0' }, coverPath: 'capa.jpg' });
    assert.ok(args.includes('epub3'));
    assert.ok(args.includes('lang=pt-MZ'));
    assert.ok(args.includes('identifier=978-0'));
    assert.equal(args[args.indexOf('--epub-cover-image') + 1], 'capa.jpg');
    assert.equal(args.at(-1), 'in.docx');
  });
  it('valores com espaços ou caracteres de shell ficam como um único argumento', () => {
    const args = buildPandocArgs({ sourcePath: 'in.docx', outputPath: 'out.epub', metadata: { ...good, title: 'A; rm -rf / $(x)' } });
    assert.ok(args.includes('title=A; rm -rf / $(x)'));
  });
});

describe('convertToEpub (validações antes de chamar o Pandoc)', () => {
  const base = { outputPath: 'out.epub', metadata: good, coverPath: 'capa.jpg' };
  it('rejeita metadados inválidos', async () => {
    await assert.rejects(
      () => convertToEpub({ ...base, sourcePath: 'a.docx', metadata: { ...good, title: '' } }),
      (e: unknown) => e instanceof ConversionError && e.code === 'invalid_metadata',
    );
  });
  it('PDF agora suportado com conversores disponíveis', async () => {
    await assert.rejects(
      () => convertToEpub({ ...base, sourcePath: 'a.pdf' }),
      (e: unknown) =>
        e instanceof ConversionError &&
        (e.code === 'pdf_conversion_unavailable' || e.code === 'converter_missing'),
    );
  });
  it('formato desconhecido', async () => {
    await assert.rejects(
      () => convertToEpub({ ...base, sourcePath: 'a.txt' }),
      (e: unknown) => e instanceof ConversionError && e.code === 'unsupported_format',
    );
  });
});
