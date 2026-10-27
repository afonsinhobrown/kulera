// Dinheiro: sempre inteiros na menor unidade da moeda (ex.: centavos). Nunca decimais.
export type CurrencyCode = 'MZN' | 'USD' | 'EUR' | 'BRL';

export const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = ['MZN', 'USD', 'EUR', 'BRL'];

export interface Money {
  readonly amount: number; // menor unidade (inteiro)
  readonly currency: CurrencyCode;
}

export function money(amount: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError('O valor monetário tem de ser um inteiro na menor unidade da moeda');
  }
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new RangeError(`Moeda não suportada: ${currency}`);
  }
  return Object.freeze({ amount, currency });
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new RangeError(`Moedas diferentes: ${a.currency} e ${b.currency}`);
  }
  return money(a.amount + b.amount, a.currency);
}

export function sumMoney(items: readonly Money[], currency: CurrencyCode): Money {
  return items.reduce((acc, item) => addMoney(acc, item), money(0, currency));
}

// Só para mostrar ao utilizador. Nunca usar o resultado em cálculos.
export function formatMoney(value: Money, locale = 'pt-MZ'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: value.currency }).format(
    value.amount / 100,
  );
}
