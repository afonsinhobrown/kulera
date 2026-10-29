import { APP_BPS, EDITORS_BPS } from './pricing.js';

// Arredonda ao centavo mais próximo (metade para cima), sem erros de vírgula flutuante.
const share = (grossMinor, bps) => Number((BigInt(grossMinor) * BigInt(bps) + 5000n) / 10000n);

// Venda: 20% App + 10% Kulera Editores + 70% parceiro (livros externos).
// Livros da própria Kulera Editores: 20% App + 80% Editores.
export function computeSplit(grossMinor, hasPartner) {
  if (!Number.isInteger(grossMinor) || grossMinor < 0) throw new RangeError('valor inválido');
  const app = share(grossMinor, APP_BPS);
  if (!hasPartner) return { app, editors: grossMinor - app, partner: 0 };
  const editors = share(grossMinor, EDITORS_BPS);
  return { app, editors, partner: grossMinor - app - editors };
}
