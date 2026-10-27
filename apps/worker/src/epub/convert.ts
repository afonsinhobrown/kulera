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

// Constrói os argumentos do Pandoc. Sem shell: valores nunca são interpretados como comandos.
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

// Word (.docx) -> EPUB 3 (RF-CON-05). Requer o Pandoc instalado no worker.
export async function convertToEpub(opts: ConvertOptions, pandocCmd = 'pandoc'): Promise<void> {
  const problems = validateEpubMetadata(opts.metadata, Boolean(opts.coverPath));
  if (problems.length > 0) throw new ConversionError('invalid_metadata', problems.join(' '));

  const extension = extname(opts.sourcePath).toLowerCase();
  if (extension === '.pdf') {
    // RF-CON-06/07: PDF -> EPUB reflowable e OCR dependem de decisão técnica (ADR a abrir).
    throw new ConversionError('pdf_not_implemented', 'A conversão de PDF ainda não está implementada.');
  }
  if (extension !== '.docx') {
    throw new ConversionError('unsupported_format', 'Formato não suportado. Use Word (.docx) ou PDF.');
  }

  try {
    await run(pandocCmd, buildPandocArgs(opts), { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    throw new ConversionError('conversion_failed', `Falha ao converter o ficheiro: ${String(error)}`);
  }
}

export interface EpubValidation {
  valid: boolean;
  output: string;
}

// RF-CON-03: validação com EPUBCheck. Sai com código 0 se o EPUB for válido.
export async function validateEpub(epubPath: string, epubcheckCmd = 'epubcheck'): Promise<EpubValidation> {
  try {
    const { stdout, stderr } = await run(epubcheckCmd, [epubPath], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    return { valid: true, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };
    if (failure.code === 'ENOENT') {
      throw new ConversionError('epubcheck_missing', 'O EPUBCheck não está instalado no worker.');
    }
    return { valid: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}
