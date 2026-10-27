import { money } from './money.ts';
import type { Money } from './money.ts';

export interface Split {
  gross: Money;
  commission: Money; // parte da Kulera
  partner: Money; // parte da editora/escritor
  commissionBps: number; // percentagem aplicada, em pontos base (100 bps = 1%)
}

// Comissão em pontos base: 2000 = 20%. O valor real é definido pela Kulera (ver ERS, RN-04).
export function computeSplit(gross: Money, commissionBps: number): Split {
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
    throw new RangeError('A comissão tem de ser um inteiro entre 0 e 10000 pontos base');
  }
  if (gross.amount < 0) {
    throw new RangeError('O valor bruto não pode ser negativo');
  }
  // BigInt evita erros de arredondamento e de precisão. Arredonda ao mais próximo (meio para cima).
  const commissionAmount = Number(
    (BigInt(gross.amount) * BigInt(commissionBps) + 5_000n) / 10_000n,
  );
  const commission = money(commissionAmount, gross.currency);
  const partner = money(gross.amount - commissionAmount, gross.currency);
  return { gross, commission, partner, commissionBps };
}
