# ADR-0002 — Pagamentos via PaySuite, isolados num adaptador

- **Estado**: Decidido (promotor); detalhes da API por confirmar

## Contexto
A PaySuite aceita M-Pesa, e-Mola, Mkesh e cartões Visa/Mastercard (qualquer cartão Visa, segundo o promotor).

## Decisão
Todo o conhecimento da API da PaySuite fica em `apps/api/src/payments/paysuiteHttpProvider.ts`, `signature.ts` e `events.ts`. O resto do sistema fala com a interface `PaymentProvider`. O estado de um pagamento só muda em `settlement.ts`.

## Consequências
Trocar ou acrescentar um fornecedor de pagamentos mexe em poucos ficheiros. Os pontos marcados «CONFIRMAR» no código têm de ser validados com a documentação oficial antes de produção.
