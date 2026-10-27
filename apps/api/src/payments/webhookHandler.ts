import { createHash } from 'node:crypto';
import type { PaymentStatus } from '../domain/types.ts';
import { normalizeEvent } from './events.ts';
import type { NormalizedEventKind } from './events.ts';
import type { PaymentsRepository } from './repository.ts';
import { settle } from './settlement.ts';
import { verifySignature } from './signature.ts';

export interface WebhookDeps {
  repo: PaymentsRepository;
  secret: string;
  now: () => Date;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface WebhookResponse {
  status: number;
  body: { ok: boolean; result: string };
}

const TARGET_STATUS: Partial<Record<NormalizedEventKind, PaymentStatus>> = {
  payment_paid: 'paid',
  payment_failed: 'failed',
  payment_cancelled: 'cancelled',
  refund_succeeded: 'refunded',
};

const reply = (status: number, ok: boolean, result: string): WebhookResponse => ({
  status,
  body: { ok, result },
});

// Ordem importa: assinatura → JSON → evento → transacção → deduplicação → liquidação.
// Respostas: 2xx = recebido (não reenviar); 4xx/5xx = a PaySuite pode reenviar.
export async function handlePaysuiteWebhook(
  deps: WebhookDeps,
  rawBody: string,
  signatureHeader: string | undefined,
): Promise<WebhookResponse> {
  if (!verifySignature(rawBody, signatureHeader, deps.secret)) {
    deps.log?.('paysuite.webhook.invalid_signature');
    return reply(401, false, 'invalid_signature');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return reply(400, false, 'invalid_json');
  }

  const event = normalizeEvent(payload);
  if (!event) return reply(400, false, 'invalid_payload');

  const target = TARGET_STATUS[event.kind];
  if (!target) {
    deps.log?.('paysuite.webhook.unknown_event', { type: event.rawType });
    return reply(200, true, 'unknown_event');
  }

  const eventKey = createHash('sha256').update(rawBody).digest('hex');

  return deps.repo.transaction(async (tx) => {
    // Procura primeiro pelo id da PaySuite e depois pela nossa referência
    // (o webhook pode chegar antes de guardarmos o id do pagamento).
    const transaction =
      (event.providerPaymentId ? await tx.findTransactionByProviderId(event.providerPaymentId) : null) ??
      (event.reference ? await tx.findTransactionByReference(event.reference) : null);

    if (!transaction) {
      // Não registamos o evento: assim, um reenvio posterior ainda pode ser processado.
      deps.log?.('paysuite.webhook.transaction_not_found', { type: event.rawType });
      return reply(404, false, 'transaction_not_found');
    }

    const isNew = await tx.recordWebhookEvent({ eventKey, eventType: event.rawType, payload });
    if (!isNew) return reply(200, true, 'duplicate');

    if (!transaction.providerPaymentId && event.providerPaymentId) {
      await tx.updateTransactionStatus(transaction.id, { providerPaymentId: event.providerPaymentId });
    }

    const outcome = await settle(tx, transaction, target, deps.now(), 'webhook');
    await tx.markWebhookOutcome(eventKey, outcome);
    return reply(200, true, outcome);
  });
}
