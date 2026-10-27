import type { Money } from '../domain/money.ts';

export type ProviderPaymentStatus = 'pending' | 'paid' | 'failed' | 'cancelled';

export interface CreatePaymentInput {
  reference: string;
  amount: Money;
  description: string;
  returnUrl?: string;
}

export interface CreatePaymentResult {
  providerPaymentId: string;
  checkoutUrl: string;
}

// Contrato que o resto do sistema usa. Só o adaptador conhece a API real da PaySuite.
export interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  getPaymentStatus(providerPaymentId: string): Promise<ProviderPaymentStatus>;
}

// Implementação para testes e desenvolvimento local.
export class FakePaymentProvider implements PaymentProvider {
  created: CreatePaymentInput[] = [];
  statuses = new Map<string, ProviderPaymentStatus>();
  failNext = false;
  private counter = 0;

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('fake provider error');
    }
    this.counter += 1;
    this.created.push(input);
    const providerPaymentId = `fake_${this.counter}`;
    this.statuses.set(providerPaymentId, 'pending');
    return { providerPaymentId, checkoutUrl: `https://pay.example.test/checkout/${providerPaymentId}` };
  }

  async getPaymentStatus(providerPaymentId: string): Promise<ProviderPaymentStatus> {
    return this.statuses.get(providerPaymentId) ?? 'pending';
  }
}
