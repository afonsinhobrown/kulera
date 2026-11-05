// Regras fixas da plataforma (em pontos base: 2000 = 20%).
export const APP_BPS = 2000;
export const EDITORS_BPS = 1000;
export const PARTNER_BPS = 7000;
export const PUBLICATION_FEE_MINOR = 50000; // 500,00 MZN por livro de parceiro externo

// Revisão V3: custo do gateway (PaySuite) suportado pela comissão da plataforma.
export const GATEWAY_BPS = 700; // 7%
// Falha/lapso de assinatura: 3 dias de tolerância antes de suspender as obras.
export const SUBSCRIPTION_GRACE_DAYS = 3;
// Avisos prévios de expiração (créditos e assinaturas), em horas.
export const EXPIRY_WARNING_HOURS = [72, 24];
