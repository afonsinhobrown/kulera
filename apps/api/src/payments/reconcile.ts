import type { PaymentProvider } from './provider.ts';
import type { PaymentsRepository } from './repository.ts';
import { settle } from './settlement.ts';

export interface ReconcileDeps {
  repo: PaymentsRepository;
  provider: PaymentProvider;
  now: () => Date;
  minAgeMs: number; // só reconcilia o que está pendente há mais tempo (valor a decidir; ver Guia 8.1)
  log?: (message: string, data?: Record<string, unknown>) => void;
}

// Corre periodicamente (worker). Corrige pagamentos cujo webhook nunca chegou.
export async function reconcilePending(deps: ReconcileDeps): Promise<{ checked: number; changed: number }> {
  const cutoff = new Date(deps.now().getTime() - deps.minAgeMs);
  const candidates = await deps.repo.listUnsettledBefore(cutoff);
  let changed = 0;

  for (const candidate of candidates) {
    if (!candidate.providerPaymentId) continue;
    try {
      const status = await deps.provider.getPaymentStatus(candidate.providerPaymentId);
      if (status === 'pending') continue;

      const outcome = await deps.repo.transaction(async (tx) => {
        // Relê dentro da transacção: o webhook pode ter acabado de resolver este pagamento.
        const fresh = await tx.findTransactionByProviderId(candidate.providerPaymentId as string);
        if (!fresh) return 'missing';
        return settle(tx, fresh, status, deps.now(), 'reconcile');
      });
      if (outcome.startsWith('applied')) changed += 1;
    } catch (error) {
      // Um erro num pagamento não pode parar os outros.
      deps.log?.('reconcile.error', { transactionId: candidate.id, error: String(error) });
    }
  }
  return { checked: candidates.length, changed };
}
