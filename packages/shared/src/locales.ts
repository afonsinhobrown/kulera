// Todos os textos para o utilizador vivem aqui (Guia Técnico 8.7). Nunca texto fixo no código.
// Para acrescentar um idioma: criar o objecto, registá-lo em `locales` e o teste de paridade diz o que falta.
export const pt = {
  common: { appName: 'Kulera+', loading: 'A carregar…', retry: 'Tentar novamente' },
  nav: { catalog: 'Catálogo', library: 'A minha biblioteca', plans: 'Planos', account: 'Conta' },
  payment: {
    pending: 'A aguardar confirmação do pagamento.',
    paid: 'Pagamento confirmado. Obrigado!',
    failed: 'O pagamento falhou. Pode tentar novamente.',
    cancelled: 'O pagamento foi cancelado. Nada foi cobrado.',
  },
  reader: {
    notAllowed: 'Não tem acesso a este conteúdo.',
    sample: 'Amostra gratuita',
    continueReading: 'Continuar a ler',
  },
  orders: { received: 'Pedido recebido', shipped: 'Enviado', delivered: 'Entregue', cancelled: 'Cancelado' },
  greeting: 'Olá, {name}!',
} as const;

export const en: typeof pt = {
  common: { appName: 'Kulera+', loading: 'Loading…', retry: 'Try again' },
  nav: { catalog: 'Catalogue', library: 'My library', plans: 'Plans', account: 'Account' },
  payment: {
    pending: 'Waiting for payment confirmation.',
    paid: 'Payment confirmed. Thank you!',
    failed: 'The payment failed. You can try again.',
    cancelled: 'The payment was cancelled. You have not been charged.',
  },
  reader: {
    notAllowed: 'You do not have access to this content.',
    sample: 'Free sample',
    continueReading: 'Continue reading',
  },
  orders: { received: 'Order received', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' },
  greeting: 'Hello, {name}!',
};

export const locales = { pt, en } as const;
export type LocaleCode = keyof typeof locales;
export const DEFAULT_LOCALE: LocaleCode = 'pt';
