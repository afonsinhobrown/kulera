// Normaliza os eventos recebidos da PaySuite.
// CONFIRMAR nomes de eventos e formato do corpo na documentação oficial.
// Nomes usados aqui vêm de exemplos da comunidade: payment.success, payment.failed, refund.success.

export type NormalizedEventKind =
  | 'payment_paid'
  | 'payment_failed'
  | 'payment_cancelled'
  | 'refund_succeeded'
  | 'unknown';

export interface NormalizedEvent {
  kind: NormalizedEventKind;
  rawType: string;
  providerPaymentId: string | null;
  reference: string | null;
}

const EVENT_MAP: Record<string, NormalizedEventKind> = {
  'payment.success': 'payment_paid',
  'payment.failed': 'payment_failed',
  'payment.cancelled': 'payment_cancelled',
  'payment.canceled': 'payment_cancelled',
  'refund.success': 'refund_succeeded',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function normalizeEvent(payload: unknown): NormalizedEvent | null {
  const root = asRecord(payload);
  if (!root) return null;

  const rawType = typeof root.event === 'string' ? root.event : null;
  if (!rawType) return null;

  const data = asRecord(root.data) ?? root;
  const isRefund = rawType.startsWith('refund.');

  const providerPaymentId = isRefund
    ? asId(data.payment_id) ?? asId(data.paymentId)
    : asId(data.id) ?? asId(data.payment_id);

  return {
    kind: EVENT_MAP[rawType] ?? 'unknown',
    rawType,
    providerPaymentId,
    reference: asId(data.reference),
  };
}
