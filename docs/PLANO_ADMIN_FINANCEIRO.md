# Plano — administração, finanças, saques e relatórios

## O que já existe (verificado no código)

- App publicada: `apps/web` — funções serverless em `api/`, HTML estático em `public/`,
  base PostgreSQL via `lib/db.js`. Esquema em `db/schema.sql` + `ensurePaymentSchema()`.
- **Divisão atual:** `lib/split.js` faz 20% App / 10% Kulera Editores / 70% parceiro, com a
  taxa de 7% do gateway a sair da parte da App. **Não é a regra nova.**
- **Admin:** uma única chave partilhada (`fair_settings.admin_key`, cabeçalho `x-admin-key`).
  Não há utilizadores, não há sessões. *(Já substituído na fase 1 — ver Estado.)*
- **Parceiros:** `fair_partners` + `fair_partner_users` (e-mail + senha com pbkdf2).
- **Saques:** `fair_partner_withdrawals` — um tipo só, sem aprovação, sem regra de período.
- **Livros:** o autor é **texto livre** (`fair_books.author`). Não existe registo de autores.

## Fases

### Fase 1 — Administradores (a base de tudo)
1. Tabela `fair_admin_users` (utilizador, hash, papel, estado).
2. Semear os dois admins com hash pbkdf2 e **recomendar** troca de senha (nunca obrigatória;
   a senha da TecnoIncubadora não se altera).
3. Sessões: cookie httpOnly assinado, expiração, CSRF, limite de tentativas.
4. **Retirar** a chave única `x-admin-key`; todos os endpoints do admin passam a exigir sessão.
5. Dados bancários por admin (`fair_admin_bank`), alteráveis **só na própria sessão**, com
   registo de quem alterou, quando, e valores antigos.

### Fase 2 — Modelo de dinheiro
6. `fair_authors` — registo global: NUIT, BI, cópia, classe (nacional / estrangeiro não
   residente), estado, ligação à conta.
7. `fair_book_authors` — ligação livro↔autor com o **valor que o autor recebe por livro**, e a
   **editora vê o seu valor real ao guardar o livro**, antes de publicar.
8. `fair_ledger` — livro de razão: cada movimento (venda, taxa de 7%, parte de cada um,
   saque, ajuste), com valores em centavos, inteiros.
9. `fair_balances` — saldo por entidade: TecnoIncubadora, Kulera, Emílio, cada editora, cada
   autor; direito adquirido / pago / por receber.
10. Reescrever `lib/split.js` com os três cenários e o valor declarado por livro, mais o
    **guarda que impede a Kulera de ficar acima da TecnoIncubadora**.

### Fase 3 — Saques
11. `fair_withdrawals` — tipo (editora / divisão de lucros), modo (automático / aprovado),
    estado.
12. `fair_withdrawal_approvals` — aprovações, uma por admin.
13. **Sócios:** saques de lucros **só de 3 em 3 meses**, e cada saque conta a partir do
    anterior. **Editoras:** a qualquer momento. Saque extraordinário de sócio só com
    autorização da **TecnoIncubadora**.
14. Direito adquirido **sempre registado**, mesmo sem saque.
15. Taxa de **1%** aplicada no saque, sobre o montante transferido, e registada.

### Fase 4 — Painel financeiro
16. Filtros: **global, semana, mês, ano**.
17. Vistas: cada venda; saldo por editora no livro X; saldo por autor no livro X; taxas; bruto
    e líquido; retido da Kulera e do Emílio; saques.
18. Exportação CSV.

### Fase 5 — Relatórios PDF
19. Modelos: vendas do período, saldo por editora, saldo por autor, retidos Kulera/Emílio,
    saques, divisão de lucros.
20. Forma de geração a decidir (ver decisões).

### Fase 6 — Migração e testes
21. Passar o texto livre de `fair_books.author` para `fair_authors`.
22. Testes: cálculos, saques, permissões, guarda Kulera ≤ TecnoIncubadora.

## Estado

**Fase 1 — feita e testada** (13 testes em `apps/web/test/admin-auth.test.mjs`, mais a suite
antiga a continuar verde).

| Peça | Como ficou |
|---|---|
| Contas | `fair_admin_users` — `tecnoincubadora` e `kulera` |
| Senhas | hash pbkdf2 com sal; nunca em texto, nunca no repositório |
| Sessões | `fair_admin_sessions` — cookie `kadm` httpOnly, SameSite=Lax, 8 h; na base só o sha256 do token |
| CSRF | cabeçalho `x-requested-with: kulera-admin` obrigatório nos POST |
| Força bruta | 8 falhas por 15 min, por conta + IP |
| Dados bancários | `fair_admin_bank` + `fair_admin_bank_changes`; cada admin só altera os seus, com antes/depois e IP |
| Senha da TecnoIncubadora | bloqueada (`can_change_password = false`) |
| Senha da Kulera | troca recomendada, não obrigatória |
| Chave antiga | `x-admin-key` removida do servidor e do painel |

**Falta correr o seed uma vez** (as senhas não entram no repositório):

```
cd apps/web
$env:TECNOINCUBADORA_PASSWORD='...'; $env:KULERA_PASSWORD='...'; node scripts/seed-admins.mjs
```

Sem o seed, o login responde `admin_not_seeded` — a app não inventa senha nenhuma.

**Fase 2 — feita e verificada na base real** (dentro de uma transacção desfeita no fim: nada
ficou gravado).

| Peça | Como ficou |
|---|---|
| Autores | `fair_authors` — NUIT único, BI, classe, estado, parte relacionada |
| Livro↔autor | `fair_book_authors` — valor declarado por livro (% e/ou valor em dinheiro) |
| Razão | `fair_ledger` — cada movimento, com chave de idempotência |
| Saldos | `fair_balances` — direito adquirido e pago, por entidade |
| Cálculo | `lib/split.js` reescrito: cenários A, B e C + regra de ouro |
| Vendas | `fair_sales.author_minor` e restrição das cinco partes (soma = bruto) |
| Migração | `node scripts/migrate-finance.mjs` (já corrida) |

Verificado na base real: NUIT repetido devolve o mesmo autor; autor nacional sem NUIT é
recusado; Emílio com royalties é recusado; A = 50 autor / 43 plataforma / 0 Kulera / 7 gateway;
B = 0 / 93 / 0 / 7; C = 70 editora / 30 plataforma (23 líquidos) / 7 gateway. Reenvio da mesma
venda não duplica saldo.

**Pendente de dados:** os livros que já existem não têm autor ligado. Livro da Kulera sem autor
cai no cenário A com autor a 0 — a TecnoIncubadora leva tudo menos o gateway. Ligar autores aos
livros entra no painel na fase 4.

**Fase 3 — feita e verificada na base real** (transacção desfeita no fim).

| Peça | Como ficou |
|---|---|
| Pedidos | `fair_withdrawals` — tipo, entidade, bruto, taxa 1%, líquido, modo, extraordinário, estado |
| Aprovações | `fair_withdrawal_approvals` — uma por admin; só com as duas o saque é aprovado |
| Modo | `withdrawal_mode`, por omissão `approved`; só a TecnoIncubadora o muda |
| Período | sócios: 90 dias desde o último saque pago; editoras: sem limite |
| Extraordinário | fora dos 90 dias; só a TecnoIncubadora autoriza |
| Divisão 50/50 | um único pedido sobre o caixa da plataforma, com a metade de cada dono registada — o Emílio não tem saldo nem pedido próprio |
| Pagamento | debita o saldo, regista a taxa e deixa rasto no livro de razão |

Verificado: 1 aprovação mantém pendente, 2 aprovam; pagamento debita e regista; acima do saldo
recusado; divisão de 230,00 MT num único pedido deu 115,00 MT a cada dono com 2,30 MT de taxa,
e o Emílio continua **sem saldo** na plataforma; segundo saque de sócio recusado até 3 meses
depois, com a data; extraordinário recusado à Kulera e aceite pela TecnoIncubadora; mudança de
modo recusada à Kulera.

**Fase 4 — feita e verificada na base real.** Página `/financeiro.html` (ligada no painel) e
`/api/finance`, com filtros **semana / mês / ano / tudo**:

- totais: vendas, bruto, gateway 7%, líquido, plataforma, autores, editoras, retido Kulera,
  retido Emílio, saques pagos;
- **cada venda**, uma a uma;
- **saldo por editora, por livro**;
- **saldo por autor, por livro**;
- saques e divisões de lucros;
- saldos das entidades (direito adquirido, pago, disponível).

**Fase 5 — PDF:** o relatório tem folha de estilo de impressão própria — «Imprimir / PDF»
produz o documento com os quadros e os KPIs, sem os botões. Geração no servidor por fazer.

**Fase 6 — feita** (ligação dos autores aos livros existentes e edição no painel).

- `scripts/import-authors.mjs` — importa o nome do autor dos livros antigos para `fair_authors`
  e liga ao livro. Corre primeiro em seco; `--apply` grava. Já corrido na base real: **2 livros,
  2 autores, 2 ligações**.
- Livro do Emílio fica ligado ao **autor da casa** (parte relacionada, 0% de royalties).
- Separador **«Autores»** no painel: criar autor (nome, NUIT, BI, classe), ligar autor a livro
  com percentagem **ou** valor fixo por livro, ver e remover ligações.
- Ao **guardar um livro**, o painel mostra logo **quanto a editora ganha** com ele (e quanto
  leva o autor), calculado com as regras e o valor declarado.
- Autor nacional sem NUIT é recusado; Emílio com royalties é recusado.

**Pendente de decisão:** os dois autores importados não têm NUIT nem valor declarado — os livros
deles pagam 0 ao autor até isso ser preenchido no separador «Autores».

**Fase 7 — registo do autor obrigatório; conta opcional.** Página `/autor.html` e `/api/author-auth`.

- **Conta é opcional.** O autor pode nunca entrar. O que não pode faltar é o **registo** dele
  quando existe um livro à venda: ao publicar sem autor ligado, o livro **volta a rascunho**
  (`sem_autor_ficou_rascunho`).
- Quem tem conta e tem dados em falta fica **preso no formulário**: NUIT, BI, percentagem na
  venda, forma de recebimento (M-Pesa/e-Mola/NIB) e conta. O servidor responde
  `profile_incomplete` a qualquer outra acção.
- Ao completar o NUIT, reconcilia com o registo criado pela editora: os livros passam para a
  conta do autor e o registo órfão desaparece.
- O painel mostra na lista de autores o que falta a cada um (`Falta: NUIT, BI, %`).
- A percentagem definida na conta vale para os livros onde a editora não declarou valor.

**Por fazer:** PDF gerado no servidor, se for preciso.

## Decidido

1. **Modo padrão dos saques: aprovado** — os dois admins autorizam. Só a TecnoIncubadora muda
   o modo.
2. **Todos os pedidos de saque de editora vão para os dois admins.**
3. **3 meses só para sócios** (lucros); editoras sacam a qualquer momento. Extraordinário de
   sócio só com autorização da TecnoIncubadora.
4. **Senhas com hash**, troca **recomendada e não obrigatória**; a da TecnoIncubadora não muda.
   As senhas não são escritas em nenhum ficheiro do repositório.
5. **PDF** — começo por relatório HTML próprio para impressão; geração no servidor depois, se
   for preciso.
