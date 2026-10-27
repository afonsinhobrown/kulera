// Comissão em pontos base (2000 = 20%). BigInt: sem erros de arredondamento. Comissão + parceiro = bruto.
export function computeSplit(grossMinor, commissionBps) {
  if (!Number.isInteger(grossMinor) || grossMinor < 0) throw new RangeError('valor inválido');
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10000) throw new RangeError('comissão inválida');
  const commission = Number((BigInt(grossMinor) * BigInt(commissionBps) + 5000n) / 10000n);
  return { commission, partner: grossMinor - commission };
}
