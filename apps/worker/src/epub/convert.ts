import { execFile } from 'node:child_process';
import { extname } from 'node:path';
import { promisify } from 'node:util';
import { validateEpubMetadata } from './metadata.ts';
import type { EpubMetadata } from './metadata.ts';

const run = promisify(execFile);

export class ConversionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConversionError';
    this.code = code;
  }
}

export interface ConvertOptions {
  sourcePath: string;
  outputPath: string;
  metadata: EpubMetadata;
  coverPath?: string;
}

export function buildPandocArgs(opts: ConvertOptions): string[] {
  const m = opts.metadata;
  const args = [
    '--from', 'docx',
    '--to', 'epub3',
    '--toc',
    '--toc-depth=2',
    '--output', opts.outputPath,
    '--metadata', `title=${m.title}`,
    '--metadata', `author=${m.author}`,
    '--metadata', `publisher=${m.publisher}`,
    '--metadata', `lang=${m.language}`,
  ];
  if (m.identifier) args.push('--metadata', `identifier=${m.identifier}`);
  if (m.date) args.push('--metadata', `date=${m.date}`);
  if (m.description) args.push('--metadata', `description=${m.description}`);
  if (opts.coverPath) args.push('--epub-cover-image', opts.coverPath);
  args.push(opts.sourcePath);
  return args;
}

export function buildCalibreArgs(opts: ConvertOptions): string[] {
  const m = opts.metadata;
  const args = [opts.sourcePath, opts.outputPath];
  args.push('--output-profile', 'tablet');
  args.push('--enable-heuristics');
  args.push('--title', m.title);
  args.push('--authors', m.author);
  args.push('--publisher', m.publisher);
  args.push('--language', m.language);
  if (m.identifier) args.push('--isbn', m.identifier);
  if (m.date) args.push('--pubdate', m.date);
  if (m.description) args.push('--comments', m.description);
  if (opts.coverPath) args.push('--cover', opts.coverPath);
  return args;
}

export function buildPandocPdfArgs(opts: ConvertOptions): string[] {
  const m = opts.metadata;
  const args = [
    '--from', 'pdf',
    '--to', 'epub3',
    '--toc',
    '--toc-depth=2',
    '--output', opts.outputPath,
    '--metadata', `title=${m.title}`,
    '--metadata', `author=${m.author}`,
    '--metadata', `publisher=${m.publisher}`,
    '--metadata', `lang=${m.language}`,
  ];
  if (m.identifier) args.push('--metadata', `identifier=${m.identifier}`);
  if (m.date) args.push('--metadata', `date=${m.date}`);
  if (m.description) args.push('--metadata', `description=${m.description}`);
  if (opts.coverPath) args.push('--epub-cover-image', opts.coverPath);
  args.push(opts.sourcePath);
  return args;
}

async function tryConvertWith(cmd: string, args: string[], timeout = 180000): Promise<void> {
  try {
    await run(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: string | number };
    if (failure.code === 'ENOENT') {
      throw new ConversionError('converter_missing', `Conversor nao encontrado: ${cmd}`);
    }
    throw error;
  }
}

async function convertFromDocx(opts: ConvertOptions, pandocCmd: string): Promise<void> {
  try {
    await tryConvertWith(pandocCmd, buildPandocArgs(opts));
  } catch (error) {
    if (error instanceof ConversionError && error.code === 'converter_missing') {
      throw new ConversionError('converter_missing', 'Pandoc nao esta instalado no worker. Instale o Pandoc para converter .docx para EPUB3.');
    }
    if (error instanceof ConversionError) throw error;
    throw new ConversionError('conversion_failed', `Falha ao converter o ficheiro: ${String(error)}`);
  }
}

async function convertFromPdf(opts: ConvertOptions): Promise<void> {
  const errors: string[] = [];
  try {
    await tryConvertWith('ebook-convert', buildCalibreArgs(opts));
    return;
  } catch (error) {
    if (error instanceof ConversionError && error.code === 'converter_missing') {
      errors.push('ebook-convert (Calibre) nao encontrado');
    } else if (error instanceof Error) {
      errors.push(`ebook-convert: ${error.message}`);
    }
  }
  try {
    await tryConvertWith('pandoc', buildPandocPdfArgs(opts));
    return;
  } catch (error) {
    if (error instanceof ConversionError && error.code === 'converter_missing') {
      errors.push('pandoc nao encontrado');
    } else if (error instanceof Error) {
      errors.push(`pandoc: ${error.message}`);
    }
  }
  throw new ConversionError(
    'pdf_conversion_unavailable',
    `Nao foi possivel converter PDF para EPUB. Instale o Calibre (ebook-convert) ou o Pandoc com suporte a PDF. Tentativas: ${errors.join('; ')}.`
  );
}

export async function convertToEpub(opts: ConvertOptions, pandocCmd = 'pandoc'): Promise<void> {
  const problems = validateEpubMetadata(opts.metadata, Boolean(opts.coverPath));
  if (problems.length > 0) throw new ConversionError('invalid_metadata', problems.join(' '));

  const extension = extname(opts.sourcePath).toLowerCase();
  if (extension === '.pdf') {
    await convertFromPdf(opts);
    return;
  }
  if (extension === '.docx') {
    await convertFromDocx(opts, pandocCmd);
    return;
  }
  if (extension === '.html' || extension === '.htm') {
    try {
      await tryConvertWith(pandocCmd, [
        '--from', 'html',
        '--to', 'epub3',
        '--toc',
        '--toc-depth=2',
        '--output', opts.outputPath,
        '--metadata', `title=${opts.metadata.title}`,
        '--metadata', `author=${opts.metadata.author}`,
        '--metadata', `publisher=${opts.metadata.publisher}`,
        '--metadata', `lang=${opts.metadata.language}`,
        ...(opts.metadata.identifier ? ['--metadata', `identifier=${opts.metadata.identifier}`] : []),
        ...(opts.metadata.date ? ['--metadata', `date=${opts.metadata.date}`] : []),
        ...(opts.metadata.description ? ['--metadata', `description=${opts.metadata.description}`] : []),
        ...(opts.coverPath ? ['--epub-cover-image', opts.coverPath] : []),
        opts.sourcePath,
      ]);
      return;
    } catch (error) {
      if (error instanceof ConversionError && error.code === 'converter_missing') {
        throw new ConversionError('converter_missing', 'Pandoc nao esta instalado no worker. Instale o Pandoc para converter HTML para EPUB3.');
      }
      if (error instanceof ConversionError) throw error;
      throw new ConversionError('conversion_failed', `Falha ao converter o ficheiro: ${String(error)}`);
    }
  }

  throw new ConversionError('unsupported_format', 'Formato nao suportado. Use Word (.docx), PDF ou HTML (.html/.htm).');
}

export async function validateEpub(epubPath: string, epubcheckCmd = 'epubcheck'): Promise<EpubValidation> {
  try {
    const { stdout, stderr } = await run(epubcheckCmd, [epubPath], { timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
    return { valid: true, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };
    if (failure.code === 'ENOENT') {
      throw new ConversionError('epubcheck_missing', 'O EPUBCheck nao esta instalado no worker.');
    }
    return { valid: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

export interface EpubValidation {
  valid: boolean;
  output: string;
}
