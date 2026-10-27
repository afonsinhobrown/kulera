import type { PaymentStatus } from './types.ts';

export type TransitionDecision = 'apply' | 'ignore' | 'reject';

// Regra: a PaySuite é a fonte de verdade (ver Guia Técnico 8.1).
// - Um estado nunca recua (ex.: «pendente» depois de «pago» é ignorado).
// - Uma confirmação verificada de pagamento vence um «falhado/cancelado» anterior
//   (o dinheiro foi recebido). Esse caso é marcado como confirmação tardia.
export function decideTransition(from: PaymentStatus, to: PaymentStatus): TransitionDecision {
  if (from === to) return 'ignore';

  switch (to) {
    case 'created':
      return 'reject';
    case 'pending':
      return from === 'created' ? 'apply' : 'ignore';
    case 'paid':
      if (from === 'created' || from === 'pending') return 'apply';
      if (from === 'failed' || from === 'cancelled') return 'apply'; // confirmação tardia
      return 'ignore'; // já pago ou reembolsado
    case 'failed':
    case 'cancelled':
      return from === 'created' || from === 'pending' ? 'apply' : 'ignore';
    case 'refunded':
      return from === 'paid' ? 'apply' : 'reject';
  }
}

export function isLateConfirmation(from: PaymentStatus, to: PaymentStatus): boolean {
  return to === 'paid' && (from === 'failed' || from === 'cancelled');
}
