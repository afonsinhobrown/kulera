import { decideTransition, isLateConfirmation } from '../domain/paymentState.ts';
import type { PaymentStatus, Transaction } from '../domain/types.ts';
import { fulfil } from './fulfilment.ts';
import type { PaymentsTx } from './repository.ts';

// Único sítio onde o estado de um pagamento muda. Usado pelo webhook e pela reconciliação.
export async function settle(
  tx: PaymentsTx,
  transaction: Transaction,
  target: PaymentStatus,
  now: Date,
  source: 'webhook' | 'reconcile',
): Promise<string> {
  const decision = decideTransition(transaction.status, target);

  if (decision === 'reject') {
    await tx.appendAudit({
      action: 'payment.transition_rejected',
      entity: 'transaction',
      entityId: transaction.id,
      data: { from: transaction.status, to: target, source },
    });
    return 'rejected';
  }
  if (decision === 'ignore') return 'ignored';

  const late = isLateConfirmation(transaction.status, target);

  await tx.updateTransactionStatus(transaction.id, {
    status: target,
    ...(target === 'paid' ? { paidAt: now } : {}),
    ...(target === 'failed' ? { failureReason: 'provider_reported_failure' } : {}),
    ...(target === 'cancelled' ? { failureReason: 'cancelled' } : {}),
  });

  if (target === 'paid') {
    await fulfil(tx, transaction, now);
  } else if (target === 'refunded') {
    await tx.revokeAccess(transaction.id, now);
    await tx.reverseSales(transaction.id, now);
  }

  await tx.appendAudit({
    action: late ? 'payment.late_confirmation' : 'payment.status_changed',
    entity: 'transaction',
    entityId: transaction.id,
    data: { from: transaction.status, to: target, source },
  });

  return late ? 'applied_late_confirmation' : 'applied';
}
