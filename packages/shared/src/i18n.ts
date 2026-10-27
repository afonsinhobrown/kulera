import { DEFAULT_LOCALE, locales } from './locales.ts';
import type { LocaleCode } from './locales.ts';

type Tree = { readonly [key: string]: string | Tree };

export function flattenKeys(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else Object.assign(out, flattenKeys(value, path));
  }
  return out;
}

const flat: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(locales).map(([code, tree]) => [code, flattenKeys(tree as Tree)]),
);

export function isLocale(value: string): value is LocaleCode {
  return value in locales;
}

// Fallback: idioma pedido -> idioma por defeito -> a própria chave (visível, para se notar a falta).
export function t(locale: string, key: string, params: Record<string, string | number> = {}): string {
  const lang = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const template = flat[lang]?.[key] ?? flat[DEFAULT_LOCALE]?.[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

export function availableLocales(): LocaleCode[] {
  return Object.keys(locales) as LocaleCode[];
}
