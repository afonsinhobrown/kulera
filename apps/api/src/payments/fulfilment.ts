import { computeSplit } from '../domain/split.ts';
import type { Transaction } from '../domain/types.ts';
import type { PaymentsTx } from './repository.ts';

// Entrega o que foi comprado. Corre SEMPRE dentro da mesma transacção de base de dados
// que marca o pagamento como pago (Guia Técnico 8.1, regra 4).
export async function fulfil(tx: PaymentsTx, transaction: Transaction, now: Date): Promise<void> {
  for (const item of transaction.items) {
    switch (item.kind) {
      case 'work':
        await tx.grantPurchase({
          userId: transaction.userId,
          workId: item.refId,
          transactionId: transaction.id,
        });
        break;
      case 'plan':
        await tx.activateSubscription({
          userId: transaction.userId,
          planId: item.refId,
          transactionId: transaction.id,
          now,
        });
        break;
      case 'order':
        await tx.markOrderPaid({ orderId: item.refId, transactionId: transaction.id });
        break;
    }

    // Split: a comissão aplicada fica guardada no registo da venda (não muda com o tempo).
    if (item.kind === 'work' && item.partnerId) {
      const commissionBps = await tx.getCommissionBps(item.partnerId);
      const split = computeSplit(item.amount, commissionBps);
      await tx.recordSale({
        transactionId: transaction.id,
        workId: item.refId,
        partnerId: item.partnerId,
        gross: split.gross,
        commission: split.commission,
        partnerShare: split.partner,
        commissionBps: split.commissionBps,
      });
    }
  }
}
