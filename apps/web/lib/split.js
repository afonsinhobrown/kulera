import { APP_BPS, EDITORS_BPS, GATEWAY_BPS } from './pricing.js';

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

// Taxa do gateway (7%) calculada sobre o valor bruto de cada pagamento.
export function gatewayFee(grossMinor) {
  if (!Number.isInteger(grossMinor) || grossMinor < 0) throw new RangeError('valor inválido');
  return share(grossMinor, GATEWAY_BPS);
}

/**
 * Resultado líquido de uma operação depois do gateway.
 * A taxa de gateway é suportada pela comissão da plataforma (parte App).
 * Para uma compra de crédito, o líquido é o valor que fica para a plataforma.
 */
export function computeNet(grossMinor, hasPartner = false) {
  const split = computeSplit(grossMinor, hasPartner);
  const gateway = gatewayFee(grossMinor);
  return {
    ...split,
    gross: grossMinor,
    gateway,
    net: grossMinor - gateway,
    appNet: split.app - gateway,
  };
}
