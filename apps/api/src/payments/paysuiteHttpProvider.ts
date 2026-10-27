import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  ProviderPaymentStatus,
} from './provider.ts';

export interface PaysuiteHttpConfig {
  baseUrl: string;
  token: string;
  createPath: string; // ex.: /payments
  getPath: string; // ex.: /payments/:id
  timeoutMs?: number;
}

// ATENÇÃO: adaptador a validar contra a documentação oficial (https://paysuite.tech/docs).
// Caminhos, nomes de campos e formato do valor (decimal vs. inteiro) são suposições marcadas
// com «CONFIRMAR». Tudo o que depende da API real está APENAS neste ficheiro.
export class PaysuiteHttpProvider implements PaymentProvider {
  private readonly config: PaysuiteHttpConfig;

  constructor(config: PaysuiteHttpConfig) {
    this.config = config;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    // CONFIRMAR: nomes dos campos e formato do valor.
    const body = {
      reference: input.reference,
      amount: (input.amount.amount / 100).toFixed(2),
      currency: input.amount.currency,
      description: input.description,
      return_url: input.returnUrl,
    };

    const json = await this.request('POST', this.config.createPath, body);
    const data = (json.data ?? json) as Record<string, unknown>;

    // CONFIRMAR: nomes dos campos de resposta.
    const providerPaymentId = data.id;
    const checkoutUrl = data.checkout_url ?? data.checkoutUrl ?? data.url;
    if (
      (typeof providerPaymentId !== 'string' && typeof providerPaymentId !== 'number') ||
      typeof checkoutUrl !== 'string'
    ) {
      throw new Error('Resposta inesperada da PaySuite ao criar pagamento');
    }
    return { providerPaymentId: String(providerPaymentId), checkoutUrl };
  }

  async getPaymentStatus(providerPaymentId: string): Promise<ProviderPaymentStatus> {
    const path = this.config.getPath.replace(':id', encodeURIComponent(providerPaymentId));
    const json = await this.request('GET', path);
    const data = (json.data ?? json) as Record<string, unknown>;
    return mapProviderStatus(data.status);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(path, this.config.baseUrl), {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      // Nunca registar o token nem o corpo completo (pode conter dados pessoais).
      throw new Error(`PaySuite respondeu com HTTP ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}

// CONFIRMAR a lista de estados da PaySuite.
export function mapProviderStatus(status: unknown): ProviderPaymentStatus {
  switch (typeof status === 'string' ? status.toLowerCase() : '') {
    case 'paid':
    case 'completed':
    case 'success':
    case 'succeeded':
      return 'paid';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'pending';
  }
}
