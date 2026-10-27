// Metadados obrigatórios antes de uma obra poder seguir para aprovação (Guia Técnico 8.2, ERS RF-CON-02).
export interface EpubMetadata {
  title: string;
  author: string;
  publisher: string;
  language: string; // BCP 47, ex.: pt, pt-MZ, en
  identifier?: string; // ISBN quando existir
  date?: string; // AAAA-MM-DD
  description?: string;
}

const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Devolve a lista de problemas (vazia = válido). As mensagens são mostradas ao parceiro.
export function validateEpubMetadata(meta: Partial<EpubMetadata>, hasCover: boolean): string[] {
  const problems: string[] = [];
  const required: Array<[keyof EpubMetadata, string]> = [
    ['title', 'o título'],
    ['author', 'o autor'],
    ['publisher', 'a editora'],
    ['language', 'o idioma'],
  ];
  for (const [field, label] of required) {
    const value = meta[field];
    if (typeof value !== 'string' || value.trim() === '') problems.push(`Falta ${label}.`);
  }
  if (meta.language && !LANGUAGE_PATTERN.test(meta.language)) {
    problems.push('O idioma deve estar no formato internacional (ex.: pt, pt-MZ, en).');
  }
  if (meta.date && !DATE_PATTERN.test(meta.date)) {
    problems.push('A data deve estar no formato AAAA-MM-DD.');
  }
  if (!hasCover) problems.push('Falta a capa.');
  return problems;
}
