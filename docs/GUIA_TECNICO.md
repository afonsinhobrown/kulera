# Kulera+ — Guia Técnico do Programador

**Fonte única de verdade técnica do projecto, escrita para que qualquer programador novo seja produtivo em um dia, mesmo que a equipa mude várias vezes.**  
Versão 1.0 (rascunho) · Outubro de 2026 · Desenvolvimento: TECNOINCUBADORA  
Documentos relacionados: Termos de Referência (ToR) e Especificação de Requisitos (ERS)

---

## 1. Como usar este documento

**Regra de ouro:** se não está escrito aqui ou no repositório, não existe. Decisões, acessos, procedimentos e razões ficam registados, nunca só na cabeça de alguém.

- **Quem entra:** lê as secções 2 a 5 (cerca de uma hora) e segue a lista da secção 3.
- **Quem trabalha:** consulta as secções 6 a 12 antes de mexer em pagamentos, leitura, acessos ou conversão de livros.
- **Quem sai:** cumpre a secção 14 (passagem de testemunho).
- A ERS define o *quê* (requisitos com códigos RF e RNF); este guia define o *como*. Se houver conflito, resolve-se e corrige-se o documento errado.
- Todo o pedido de alteração (PR) que muda comportamento, arquitectura ou procedimentos actualiza este guia ou o registo de decisões (secção 13).
- Itens marcados *(Proposta)* ainda não foram decididos: confirmar na Fase 0 e registar como decisão (ADR).

---

## 2. O produto em um minuto

O Kulera+ é uma plataforma de venda e leitura de livros e artigos para a Editora Kulera, outras editoras e escritores independentes. Leitores pagam planos mensais ou compram obras avulsas; livros físicos têm delivery; um bot atende pagamentos e entregas.

### 2.1 Decisões já tomadas pelo promotor
- Web responsiva (PWA) primeiro; depois app Android distribuída em APK, fora da Play Store.
- Pagamentos exclusivamente via PaySuite, que aceita qualquer cartão Visa; outros meios a validar.
- Livros digitais gerados em EPUB 3 a partir de ficheiros Word e PDF, e consumidos apenas dentro da plataforma.
- Utilizadores em Moçambique e na diáspora; interface em vários idiomas e vários preços/moedas.
- Os parceiros (editoras e escritores) vendem na plataforma e a Kulera cobra comissão.

### 2.2 Fases
- **F1 MVP web:** contas, catálogo, leitor, conversão EPUB, pagamentos, planos, painéis.
- **F2:** APK Android, livros físicos com delivery, repasses.
- **F3:** Bot de atendimento.
- **F4:** Lançamento e optimização.

### 2.3 Prioridades de qualidade (por ordem de rigor)
1. **Nunca activar acesso, subscrição ou pedido sem pagamento confirmado.**
2. **Nunca expor conteúdo pago a quem não tem direito.**
3. **Nunca perder dinheiro, transacções nem dados de clientes.**
4. **Ser leve e rápido em redes lentas e telemóveis simples.**

---

## 3. Primeiros dias de um programador novo (Onboarding)

- [ ] Receber acessos: repositório, quadro de tarefas, ambiente de staging, canal da equipa.
- [ ] Ler este guia (secções 2 a 5), a ERS e os ToR.
- [ ] Instalar o ambiente local seguindo o ficheiro README do repositório e correr a aplicação.
- [ ] Correr os testes e confirmar que passam antes de mudar qualquer coisa.
- [ ] Fazer um primeiro PR pequeno (por exemplo, corrigir uma gralha ou melhorar este guia).
- [ ] Ler a secção 8.1 (pagamentos) e a secção 12 (runbooks) antes de tocar em dinheiro.
- [ ] Anotar o que foi confuso no onboarding e corrigir o documento.

---

## 4. Arquitectura

### 4.1 Componentes
- **Web (PWA):** interface para leitores, parceiros e administradores; leitor de EPUB integrado.
- **App Android (APK):** a mesma interface empacotada, com verificação de actualização.
- **API backend:** regras de negócio, autenticação, catálogo, acessos, pagamentos, pedidos.
- **Workers (tarefas em segundo plano):** conversão de livros, reconciliação de pagamentos, lembretes, repasses.
- **Base de dados PostgreSQL:** dados principais.
- **Fila e cache (Redis):** tarefas, limites de pedidos e sessões curtas.
- **Armazenamento privado de ficheiros:** originais, EPUBs e capas, sem acesso público directo.
- **Serviço do bot:** liga o canal de mensagens à API com credenciais próprias e limitadas.
- **Integrações:** PaySuite, email transaccional, canal do bot (WhatsApp e/ou Telegram).

### 4.2 Fluxos críticos em resumo
- **Pagamento:** cliente pede compra → API cria transacção e pedido de pagamento na PaySuite → cliente paga → PaySuite avisa por webhook → API valida, marca como paga e activa acesso/pedido na mesma transacção de base de dados → recibo e notificação.
- **Publicação de livro:** parceiro carrega Word/PDF → worker converte para EPUB 3 → validação automática → pré-visualização → aprovação do administrador → publicado.
- **Leitura:** leitor pede capítulo → API verifica direito de acesso → entrega o conteúdo por pedido curto, com marca de água → progresso sincronizado.

### 4.3 Ambientes
| Ambiente | Para quê | Dados | Quem faz deploy |
|---|---|---|---|
| **Local** | Desenvolvimento | Fictícios | Cada programador |
| **Staging** | Testes e demonstrações | Fictícios, PaySuite em modo de teste (se existir) | Automático a partir do ramo principal |
| **Produção** | Utilizadores reais | Reais | Com aprovação do líder técnico |

---

## 5. Stack tecnológica (Proposta)

*A confirmar na Fase 0 e registar na secção 13. Princípio: poucas tecnologias, comuns no mercado, fáceis de contratar.*

- **Linguagem:** TypeScript em todo o projecto, com validação de dados de entrada (ex.: Zod).
- **Web/PWA:** React com Next.js.
- **Android:** a PWA empacotada com Capacitor para gerar o APK.
- **Backend:** Node.js com NestJS ou Fastify.
- **Base de dados:** PostgreSQL, com migrações versionadas.
- **Fila e cache:** Redis com BullMQ.
- **Ficheiros:** armazenamento compatível com S3, bucket privado.
- **Conversão de livros:** Pandoc e LibreOffice (modo headless) para Word, EPUBCheck para validar, Tesseract para OCR (F2).
- **Hospedagem:** web na Vercel ou equivalente; API e workers em serviço que suporte processos longos (conversões não correm em serverless curtos).
- **Monitorização:** registo de erros (Sentry) e registos estruturados.

---

## 6. Repositório e convenções

### 6.1 Estrutura (Proposta de Monorepo)
- `apps/web`: PWA.
- `apps/api`: backend.
- `apps/worker`: tarefas em segundo plano.
- `apps/bot`: serviço do bot.
- `packages/shared`: tipos, validações e utilitários partilhados.
- `docs/`: este guia, ADRs, runbooks e OpenAPI.
- `.env.example` com todas as variáveis (sem valores secretos) e `README.md` com os passos para arrancar.

### 6.2 Regras de trabalho
- Ramo principal sempre estável e publicável; trabalho em ramos curtos.
- Commits no formato **Conventional Commits** (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`).
- Todo PR tem: descrição do que e porquê, ligação ao requisito (código RF/RNF), testes e revisão.
- CI verde obrigatório: formatação, tipos, testes, build e dependências.
- Código e nomes em inglês; textos para o utilizador sempre via ficheiros de tradução (i18n).
- Versionamento semântico (SemVer) para o backend e para o APK.
- Dívida técnica registada com etiqueta `tech-debt`.

---

## 7. Dados

- **Identificadores:** UUID v4 em todas as tabelas; `created_at` e `updated_at` em UTC.
- **Valores monetários:** inteiros na menor unidade da moeda (ex.: centavos), acompanhados do código ISO 4217 da moeda. **Nunca usar números decimais de vírgula flutuante (float/double) para dinheiro.**
- **Imutabilidade:** Transacções, repasses e registos de auditoria nunca são apagados nem editados. Ajustes criam novos registos.
- **Privacidade:** Dados pessoais minimizados e sensíveis encriptados em repouso. Dados de entrega usados estritamente para logística.
- **Entidades:** Seguir secção 6 da ERS. Migrações no repositório são a referência final.

---

## 8. Módulos críticos

### 8.1 Pagamentos (PaySuite) — Regras Invioláveis
1. **A fonte de verdade é a PaySuite:** um pagamento só conta quando confirmado por webhook validado ou por consulta direta à API. O retorno do navegador nunca ativa nada.
2. **Webhooks:** validar assinatura/autenticidade, responder depressa (200 OK), salvar payload e processar com **idempotência estrita** (repetições não duplicam nada).
3. **Máquina de estados:** `criada` → `pendente` → `paga`, `falhada` ou `cancelada`; `paga` → `reembolsada`. Transições inválidas rejeitadas e auditadas.
4. **Atomicidade:** A ativação do acesso/pedido ocorre **na mesma transação de base de dados** que marca o pagamento como pago.
5. **Pagamento não confirmado:** Nada é ativado. Utilizador e interface são devidamente informados.
6. **Reconciliação:** Worker periódico consulta a PaySuite para transações pendentes expiradas.
7. **Servidor calcula tudo:** Preços e totais calculados exclusivamente no backend; o cliente nunca envia valores.
8. **Segurança PCI:** Nunca guardar dados de cartão ou credenciais sensíveis em banco ou logs.
9. **Testes obrigatórios:** cancelado, falhado, duplicado, atrasado, webhook repetido e webhook fora de ordem.

### 8.2 Conversão de livros para EPUB 3
- Upload Word (.docx) ou PDF → salvar original criptografado → fila do worker → converter para EPUB 3 → validação EPUBCheck → preview pelo autor/editora → submissão para aprovação admin → publicação.
- Assíncrono e repetível: falha a meio não deixa obra inconsistente.
- Metadados obrigatórios validados antes de qualquer aprovação (título, autor, editora, idioma, capa).

### 8.3 Leitor e protecção de conteúdo
- EPUB nunca exposto em URL público ou para download livre. Conteúdo fatiado e servido via API autenticada com marca d'água invisível/visível contendo dados do leitor.
- Leitura offline (Android) restrita à app, com cache encriptada e licença temporária com TTL.

### 8.4 Acessos (Entitlements)
- Toda a autorização de leitura passa obrigatoriamente por uma função centralizada: `canAccess(user, work)`.
- Regras: compra definitiva = acesso perpétuo; item de catálogo do plano = acesso enquanto subscrição estiver ativa; cancelamento mantém até fim do período pago.

### 8.5 Split e repasses
- Cálculo de comissão efetuado no instante da confirmação do pagamento, gravando a taxa percentual histórica exata da transação.
- Repasses periódicos geram extratos imutáveis.

### 8.6 Bot de atendimento
- Microsserviço com credenciais isoladas e permissões estritas de leitura e atualização de dados de entrega.
- Nunca altera valores ou aciona reembolsos sem aprovação de agente humano.
- Transfere para atendente com histórico completo quando necessário.

### 8.7 Idiomas e moedas
- 100% dos textos extraídos em dicionários de tradução (i18n).
- Moeda base de cálculo: MZN. Moedas de visualização: USD, EUR, BRL calculadas via taxa de conversão cadastrada pelo admin.

### 8.8 App Android (APK)
- Assinatura com chave guardada em cofre protegido (acesso restrito ao tech lead).
- Cheque de integridade (SHA-256) publicado na página oficial de download.
- Verificação automática de nova versão ao iniciar a app.
- Meta de tamanho: < 30 MB.

---

## 9. Convenções da API

- **Padrão:** RESTful JSON versionada em `/v1`.
- **Autenticação:** Bearer JWT com tempo de expiração e refresh token seguro.
- **Idempotência:** Cabeçalho `Idempotency-Key` obrigatório para endpoints de criação de compras, pedidos e subscrições.
- **Respostas de erro padronizadas:**
  ```json
  {
    "code": "ERROR_CODE",
    "message": "Mensagem amigável",
    "details": {}
  }
  ```
- **Paginação:** baseada em cursor para listas grandes.
- **Documentação:** Contrato OpenAPI (Swagger) mantido no repositório e validado no CI.

---

## 10. Segurança e privacidade

- HTTPS/TLS mandatório em todas as comunicações.
- Hash de senhas: `Argon2id` ou `bcrypt`.
- Proteção contra OWASP Top 10, sanitização de entradas e rate limiting no gateway/API.
- Princípio de menor privilégio para credenciais de serviços e contas de equipe.

---

## 11. Qualidade e Definição de Pronto (DoD)

- [ ] Cobertura de testes unitários e de integração em pagamentos, `canAccess`, split e webhooks.
- [ ] Pipeline CI 100% verde (Lint, Typecheck, Testes, Build).
- [ ] Revisão de código (Code Review) aprovada.
- [ ] Textos internacionalizados e acessibilidade respeitada (WCAG 2.1 AA).
- [ ] Validação em conexões lentas (3G simulado) e dispositivos modestos.
- [ ] Testado no ambiente de staging antes do merge.

---

## 12. Runbooks de Operação

1. **Cliente pagou mas não tem acesso:**
   - Verificar transação na base local e no painel PaySuite.
   - Se paga na PaySuite e pendente localmente: disparar reconciliação e investigar falha de webhook.
   - Se confirmada em ambos mas sem acesso: auditar `canAccess` e histórico de compras. Realizar ajuste via script auditado, nunca edição direta sem rastreio.
2. **Webhooks PaySuite em atraso ou indisponíveis:**
   - Checar logs de entrada e certificados do endpoint `/v1/webhooks/paysuite`.
   - Executar worker de reconciliação para cobrir transações pendentes no intervalo.
3. **Segredo comprometido:**
   - Revogar e rodar imediatamente credenciais no cofre, derrubar sessões ativas e auditar logs.
4. **Falha na validação de EPUB:**
   - Analisar log do EPUBCheck e informar o parceiro de forma clara sobre quais formatações do Word/PDF causaram a rejeição.

---

## 13. Registo de Decisões de Arquitectura (ADRs)

| ID | Decisão | Estado |
|---|---|---|
| **ADR-001** | Web responsiva (PWA) primeiro e APK Android depois | Decidido |
| **ADR-002** | Pagamentos via PaySuite | Decidido |
| **ADR-003** | EPUB 3 gerado a partir de Word e PDF; leitura exclusiva in-app | Decidido |
| **ADR-004** | Stack técnica proposta (Next.js, Node.js/NestJS, PostgreSQL, Redis, BullMQ) | Proposta |
| **ADR-005** | Hospedagem da API e workers em ambiente persistente (não serverless curto) | Proposta |
| **ADR-006** | Canal de atendimento do bot (WhatsApp / Telegram / App Chat) | Em aberto |
| **ADR-007** | Idiomas iniciais da interface (PT e EN propostos) | Em aberto |
| **ADR-008** | Modelo definitivo de proteção de conteúdo (Watermark + DRM leve) | Em aberto |

---

## 14. Passagem de Testemunho

Ao sair do projeto:
- Redigir nota em `docs/handover/` documentando o estado das tarefas, pendências e riscos.
- Transferir credenciais e acessos sem reter permissões em contas pessoais.
- Garantir que pelo menos 2 desenvolvedores dominam cada módulo crítico (pagamentos, conversor de livros, APK e infraestrutura).

---

## 15. Glossário de Termos
- **Parceiro:** Editora ou escritor independente credenciado.
- **Obra:** Livro digital ou físico catalogado.
- **Entitlement:** Direito de leitura/acesso a uma obra ou artigo.
- **Split:** Divisão percentual da receita entre a plataforma Kulera e o parceiro.
- **Idempotência:** Propriedade de uma operação de produzir o mesmo efeito mesmo se executada repetidas vezes.
