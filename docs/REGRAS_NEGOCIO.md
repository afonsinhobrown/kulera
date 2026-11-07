# Regras de negócio memorizadas

Notas de contexto para não se perderem entre sessões. Não é código nem especificação fechada —
é o que o promotor ditou, guardado tal e qual.

**Como ler:** este documento vale pela **regra de agora**. O promotor muda de regra quando
entende que deve; a nova **substitui** a antiga. O que está escrito abaixo é a versão vigente,
não a soma de todas as versões.

## 1. Entidades e propriedade

- **TecnoIncubadora** — dona da **plataforma** (Kulera+). É quem recebe a fatia residual das
  vendas e quem liquida os sócios. Referida como «eu» pelo promotor.
- **Editora Kulera** — casa editorial **de propriedade de Emílio Cossa**. Não é a plataforma;
  é um publicador que também vende livros dentro dela.
- **Emílio Cossa** — é **autor** e **dono da Editora Kulera**. É ainda **sócio 50%** do
  negócio (ver liquidação, secção 8).

Consequência: dinheiro da Kulera e dinheiro da plataforma são **contas separadas**. A Kulera
nunca é «a plataforma» — é um vendedor como os outros, com regras próprias.

## 2. Despesas do gateway de pagamento

- **Taxa de transação (venda): 7%** — retidos automaticamente sobre o **valor bruto** de cada
  livro vendido.
- **Taxa de transferência (saque): 1%** — deduzido sobre o **montante transferido** da
  plataforma para a conta bancária dos sócios.

## 3. Quem corta o quê

O **gateway** é quem retém e corta. **O sistema não corta nada.**
O sistema **apenas regista** o que o gateway descontou (valor bruto, taxa aplicada, valor
líquido). Nenhuma lógica nossa de subtração de taxa.

## 4. Repasse e retenção — três cenários

### Cenário A — livro de autor terceiro na Kulera
- Autor independente: percentual de direito configurado (**ex.: 50% do valor bruto**).
- Margem da Editora Kulera: **0%**.
- Sobra da transação → **integralmente para a TecnoIncubadora**.

### Cenário B — livro de Emílio Cossa (na Kulera ou noutra editora)
- Ganho de autor de Emílio Cossa: **0%**.
- Margem da Editora Kulera: **0%**.
- Restante (valor bruto − 7% do gateway) → **integralmente para a TecnoIncubadora**.

### Cenário C — livros de outras editoras do mercado
- TecnoIncubadora retém a **taxa padrão de 30%** sobre o valor bruto da venda.

### Tabela por 100 MT de venda

| Cenário | Bruto | Gateway 7% | Autor | Editora Kulera | TecnoIncubadora |
|---|---|---|---|---|---|
| A (autor 50%) | 100 | 7 | 50 | 0 | 43 |
| B (Emílio Cossa) | 100 | 7 | 0 | 0 | 93 |
| C (editora do mercado) | 100 | 7 | — | — | 30 (23 líquidos) |

No Cenário C os 30% **já incluem** as taxas do gateway: o publicador fica com 70% limpos e a
plataforma com ~23% líquidos.

A percentagem do autor é declarada **no livro**, na altura de publicar — não é um valor solto
no perfil do autor. E é, na prática, **quanto ele recebe naquele livro**: o valor em dinheiro
por exemplar vendido. Gravam-se as duas coisas — a percentagem e o valor que dá.

## 5. Identidade da Kulera — cadastro proibido

A **Editora Kulera já existe no sistema**, pré-criada e associada. Ela **não nasce de um
cadastro** e **é proibida de se cadastrar**.

- **Tudo o que é Kulera é bloqueado** — conta de editora, de autor, de utilizador comum, de
  parceiro. Sem exceção por tipo de conta.
- O bloqueio é **no servidor**, na validação da criação de conta — não apenas esconder o
  botão no formulário.
- A correspondência compara contra o registo oficial já existente e apanha disfarces:
  maiúsculas/minúsculas (KULERA), acentos (Kúlera), espaços, pontos e hífenes (Kulera+,
  Kulera Livros, Editora Kulera, KULERA–MZ), e também **domínios de e-mail** (@kulera.*,
  @editorakulera.*).
- **Em caso de dúvida, o subscritor solicita a resolução pelo admin** — o bloqueio não é
  silencioso: a pessoa pede revisão e o administrador decide. Não há auto-desbloqueio.
- A conta legítima que já existe **continua a operar normalmente** — a regra bloqueia novos
  registos, não a entidade.
- A tentativa bloqueada fica **registada** (nome, e-mail, IP, data) como sinal de
  impersonação, sem punir automaticamente o humano por trás.
- Colaboradores da Kulera, se precisarem de acesso, entram por **convite do administrador**,
  nunca por cadastro público.
- **Os livros da Kulera são publicados só pelo admin.** A conta Kulera não publica sozinha.
- **O Emílio Cossa não publica de forma independente.** Os livros dele entram pelo admin,
  como os da Kulera.

Razão: um cadastro falso de Kulera daria acesso indevido à fatia e ao caixa da editora e
contornaria a regra de ouro da secção 7.

## 6. Autores — registo único e partilhado

- Ao criar um livro, **o autor é selecionado** de uma lista. **Se o autor não existir, é
  primeiro cadastrado** — não se escreve um nome à mão dentro do livro.
- **Cada autor entra uma vez.** O registo é único e global. Um autor cadastrado por uma
  editora **fica visível e selecionável para as outras**.
- Ou seja: **o autor não pertence à editora que o cadastrou**. A editora não é dona do autor,
  e o mesmo autor não é recriado por cada editora que o publica.
- **Documentos obrigatórios** — para **autores moçambicanos**: **NUIT**, **BI** e **cópia do
  BI** (digitalização anexada). Obrigatórios quer o cadastro seja feito **pelo próprio autor
  quer pela editora**.
- **Autores estrangeiros não residentes em Moçambique: são geridos pela editora.** Não entram
  no registo partilhado, não levam NUIT/BI/cópia do BI, não são reclamáveis por ninguém. O
  registo é **privado da editora que os publica**, e é essa editora que lhes paga — a
  plataforma paga à editora, não ao autor.

Duas classes de autor, portanto:

| Classe | Registo | Documentos | Paga |
|---|---|---|---|
| Nacional ou residente | **global e partilhado**, reclamável | NUIT + BI + cópia do BI | plataforma (se Kulera) |
| Estrangeiro não residente | **privado da editora** | à ordem da editora | a editora |
- **Dados de recebimento de dinheiro** (banco / mobile money): exigidos **no caso específico
  da Kulera**. Para as **outras editoras ainda não há decisão**.
- Identidade e duplicados: o **NUIT** serve de chave natural. Se o NUIT já existir, **não se
  cria outro autor** — liga-se ao existente.

### Quem preenche o quê

| | Toda editora | Kulera (admin) |
|---|---|---|
| Cadastrar o autor, se ele não existir | **obrigatório** | **obrigatório** |
| Documentos: NUIT, BI e cópia do BI (autor moçambicano) | **obrigatório** | **obrigatório** |
| Valor que o autor recebe por livro | opcional — **exceto se o autor for o Emílio Cossa**, que tem de ser declarado | **obrigatório sempre** |

O que é exclusivo da Kulera é a **informação do valor que o autor recebe em cada livro**. O
cadastro do autor e os documentos são iguais para todas as editoras.

Motivo da exceção do Emílio: sendo dono da Kulera e sócio 50%, qualquer valor dele é negócio
entre partes relacionadas. Quem publica declara, e a plataforma fica a saber exatamente quanto
ele leva (hoje: 0%).

### Autor já cadastrado por uma editora cria conta própria

O sistema **não bloqueia** o cadastro. Deixa entrar e **reconcilia no fim**.

1. O autor cria a conta pessoal normalmente.
2. No fim do cadastro, o sistema procura registos existentes com o mesmo **NUIT** (ou BI).
3. Se encontrar, mostra: «encontrámos um registo teu, criado por [editora]» e pede prova —
   BI e código no telemóvel.
4. Confirma → os dois registos **ligam-se**. O autor fica dono dos dados, e os livros que
   apontavam para o registo da editora passam a apontar para ele.
5. **Divergências não se apagam em silêncio**: nome, BI ou data diferentes ficam marcados e
   vão para o admin decidir qual fica. O registo antigo fica no histórico.
6. Se não encontrar nada: conta nova, sem drama.
7. Se o registo encontrado **já estiver ligado a outra conta**, não há reconciliação
   automática — vai para o admin, porque pode ser fraude.

### Conta do autor — opcional; registo — obrigatório

**A conta não é obrigatória.** O autor pode nunca entrar na plataforma. O que é obrigatório é
estar **registado** sempre que exista um livro à venda de que ele é autor.

- Livro **à venda sem autor registado**: não pode acontecer. Sem autor ligado, o livro volta a
  rascunho.
- A conta serve para o autor ver e corrigir os seus dados — e é por onde ele os completa.

### Quando o autor tem conta — dados obrigatórios antes de usar

Se o autor tem conta e falta algum destes dados, a conta **fica bloqueada**: só vê o
formulário de completação, sem acesso a mais nada.

- **NUIT**
- **BI**
- **Percentagem que recebe na venda**
- **Forma de recebimento: M-Pesa, e-Mola ou NIB**
- **Número da conta que vai receber o valor**

Enquanto faltar um, o servidor recusa qualquer outra acção. Ao completar o NUIT, o sistema
**reconcilia** com um registo que uma editora tenha criado antes: os livros passam para a conta
do autor e o registo órfão desaparece.

### Solução proposta (a aprovar)

O erro de desenho seria guardar identidade, documentos e dinheiro na mesma linha, editável por
quem tem o autor na lista. Separa-se em **três camadas**:

**1. Registo de identidade** — durável e partilhado: nome completo, pseudónimo, NUIT
(normalizado, único, mascarado na interface), número de BI, estado. É o que todas as editoras
veem.

**2. Vínculo de controlo** — quem manda no registo: uma conta de utilizador que provou
identidade. Só o dono edita.

**3. Cofre de dados sensíveis** — cópia do BI, NUIT completo, dados de recebimento. Acesso
**campo a campo**, com registo de cada leitura.

**Ciclo de vida do autor**

| Estado | Quem cria | O que permite | Dados sensíveis |
|---|---|---|---|
| Registo inicial | editora, ou o admin pela Kulera | escolher o autor e publicar o livro | a editora não vê nada |
| Ligado ao autor | o próprio autor, no fim do cadastro | só o autor edita | o autor vê os seus |
| Confirmado | admin (ou automático) | **só aqui se paga** | admin vê, com registo de acessos |

**Regra do dinheiro**

- Royalties de autor ainda sem conta ligada ficam numa **conta de dinheiro à espera** — não é
  receita da plataforma e nunca é paga a uma editora.
- A editora **nunca** escreve dados de recebimento por conta do autor. Só o autor, depois de o
  registo estar ligado a ele.
- Alterar dados de recebimento exige: reautenticação + código para o contacto **antigo** +
  **carência de 48 horas** + aviso ao autor e às editoras com saldo pendente. É o golpe
  clássico: troca-se o IBAN e levanta-se.
- A plataforma só precisa de dados de recebimento do autor **quando é ela que paga** — que é o
  caso da Kulera. Nas outras editoras, a plataforma paga a editora e a editora paga o seu
  autor.

**Matriz de acesso**

| Campo | Editora (mesmo a que criou) | Autor dono | Admin |
|---|---|---|---|
| Nome / pseudónimo | ver | ver, editar | ver |
| NUIT completo | mascarado | ver, editar | ver |
| Número de BI | mascarado | ver, editar | ver |
| Cópia do BI | só «carregado ✓» | ver, editar | ver |
| Dados de recebimento | **nunca** | ver, editar | ver (auditado) |
| % de royalties do livro | ver | ver | editar |
| Estado de verificação | ver | ver | editar |

**Duplicados e disputas**

- Um NUIT, um autor.
- Dois autores com o mesmo NUIT → **fila do admin**, com prova de identidade.
- Nunca juntar nem apagar em silêncio: a junção fica registada.

**Contra quem se faz passar por outro autor**

- Editora não pode criar autor com NUIT de alguém que já tem conta — recebe «já existe; o autor
  tem de reclamar».
- Autor criado por editora e nunca ligado a ninguém é sinalizado, e **não impede** o autor
  verdadeiro de reclamar.

**Consentimento e auditoria**

- Consentimento guardado para tratamento dos dados (Lei 3/2017, proteção de dados).
- Registo de acessos e alterações a campos sensíveis.
- Direitos do titular: exportar, corrigir, apagar.

## 7. Impostos — ninguém vende sem pagar

Regra do promotor: **nenhuma venda escapa a imposto**. A plataforma não é mercado informal.

**O IVA está fora de âmbito por agora** — o tratamento fiscal só entra quando o promotor
voltar para alterar a app. O que fica registado é a obrigação de tributar, não as alíquotas.

- Toda a venda gera **documento fiscal** ao comprador.
- A plataforma **declara e paga** imposto sobre a sua receita (as fatias de 30% / 43% / 93%).
- Pagamentos a autores são rendimento: pode haver **retenção na fonte**.
- O autor estrangeiro não residente é pago **pela editora** — logo é a editora que retém e
  declara; a plataforma limita-se a pagar à editora.

**Perguntas para o contabilista** (não inventar valores):

1. O livro digital paga IVA como os outros serviços, ou é isento como o livro de papel?
2. O preço que o leitor paga já tem IVA dentro? Se tem, tira-se o IVA primeiro e só depois se
   divide? Isto muda os números da secção 4.
3. Quando se paga ao autor, sai imposto antes? Quanto? Quem entrega esse dinheiro ao Estado —
   nós ou a editora?
4. Autor que vive fora do país: o imposto fica cá, ou é tratado no país dele?
5. A fatura ao comprador precisa sempre do NUIT dele, ou só a partir de um certo valor?
6. O que se paga ao gateway (7% e 1%) conta como despesa para abater no imposto?

## 8. Regra de ouro — a Kulera nunca ganha mais que a TecnoIncubadora

**Em nenhum momento a Editora Kulera pode ganhar mais do que a TecnoIncubadora** — nem pela
Kulera, nem pelo Emílio Cossa.

**É a regra-mãe.** Todas as outras estão ao serviço desta: o bloqueio de cadastro Kulera, o
registo único de autores, a declaração de valores por livro, a separação de contas entre
plataforma e editora. Se alguma regra entrar em conflito com esta, esta ganha.

Conta-se do lado da Kulera: **margem da editora + royalties de autor do Emílio Cossa**.
Do outro lado: **a fatia da TecnoIncubadora** na mesma transação.

Na configuração atual a regra cumpre-se **por construção**, porque a Kulera está a 0% em
todos os cenários (0 ≤ 43 no A, 0 ≤ 93 no B, 0 ≤ 30 no C).

Se um dia se puser margem à Kulera, o teto é **metade do que sobra depois do gateway e do
autor**. Com autor a 50%: M ≤ (93 − 50) / 2 → **M ≤ 21,5%**. Acima disso a Kulera passa a
ganhar mais que a plataforma e a regra é violada.

Isto é um **guarda de validação**, não um corte: o sistema recusa configurações que violem o
teto e mostra o conflito a quem estiver a configurar.

## 9. Liquidação e divisão societária

O saque de **1%** incide sobre o **saldo acumulado** no momento da transferência, não livro a
livro. Depois divide-se o líquido.

Exemplo com 23.000 MT:

| Passo | Valor |
|---|---|
| Saldo acumulado na plataforma | 23.000,00 MT |
| Taxa de saque do gateway (1%) | − 230,00 MT |
| **Lucro líquido na conta bancária** | **22.770,00 MT** |
| Repasse líquido — sócio 1 (TecnoIncubadora) | 11.385,00 MT |
| Repasse líquido — Emílio Cossa | 11.385,00 MT |

Divisão societária: **50% / 50%**. O Emílio é **dono da plataforma, como a TecnoIncubadora** —
recebe a metade dele pela **divisão de lucros**, não por royalties nem por saque próprio. Daí o
ganho de autor dele ser 0%.

## 10. O que o sistema deve mostrar (funcionalidade futura)

Ao **guardar os dados de um livro**, a **editora vê o valor real que vai ganhar** com aquele
livro — antes de publicar, não depois. O autor vê o dele. O ganho real de quem publica fica
nos dados do livro, não só o preço de capa.

Mostra-se das duas formas: a **percentagem** e o **valor em dinheiro** (percentagem × preço).
O que o autor quer ver é o valor: «recebo X MT por livro». Por 100 MT com 50%: «50 MT por
livro».

Cada transação regista a taxa histórica e a divisão efetivamente aplicadas — as percentagens
não podem ser reescritas retroativamente.

## 11. Painel financeiro do admin

Completo, com filtros **global, semana, mês, ano**. Tem de mostrar:

- **Cada venda**, uma a uma.
- **Saldo por editora no livro X**.
- **Saldo por autor no livro X**.
- **Taxas** do gateway (7% e 1%).
- **Bruto e líquido**.
- **Quanto ficou retido** para a Kulera e para o Emílio.
- Saques feitos e por fazer.

## 12. Saques

- **Dois tipos:** saque de editora e saque de divisão de lucros (sócios).
- **Dois modos:** automático e aprovado. **Por padrão é aprovado**, e **só a TecnoIncubadora**
  pode mudar o modo.
- **Aprovado** exige autorização dos **dois** admins: TecnoIncubadora **e** Kulera.
- **Todos os pedidos de saque de editora vão para os dois admins.**
- **Sócios:** saques de lucros **só de 3 em 3 meses**.
- **Editoras:** sacam **a qualquer momento**; cada saque fica registado.
- **Saque extraordinário** de sócio, fora dos 3 meses, só a **TecnoIncubadora** autoriza.
- **O Emílio Cossa não é sacador.** É **dono da plataforma como a TecnoIncubadora**. Não tem
  saldo nem pedido de saque próprio: a parte dele sai na **divisão de lucros**.
- Sacar **não é obrigatório**: o sistema guarda sempre **quanto cada um tem direito** —
  editoras e sócios.
- A taxa de **1%** entra no saque, sobre o montante transferido.

## 13. Administradores

- O admin único atual **desaparece**. Passam a existir **dois** utilizadores admin:
  **kulera** e **tecnoincubadora**.
- As senhas foram definidas pelo promotor em conversa. Ficam **guardadas com hash, nunca em
  texto**, e em ficheiro nenhum do repositório.
- **A senha da TecnoIncubadora não deve ser alterada.** Trocar de senha é **recomendado, nunca
  obrigatório**.
- Cada um tem **dados bancários próprios**, bem definidos.
- Os dados bancários **só se alteram na própria sessão** — um admin não mexe na conta do
  outro.
- Toda a alteração fica registada.

## 14. Relatórios PDF

Relatórios em PDF são **importantes** e fazem parte do painel: vendas do período, saldo por
editora, saldo por autor, valores retidos Kulera/Emílio, saques e divisão de lucros.

## 15. Em aberto

**IVA saiu do âmbito.** O promotor disse que o IVA não se trata agora — volta para alterar a
app quando for altura.

**Pendente por decisão do promotor:** dados de recebimento nas outras editoras — disse «não
tenho certeza agora».

## 16. Estado

Apenas memorizado. **Nada implementado no código** — o `GUIA_TECNICO.md` (secção de comissões),
o adaptador PaySuite e o fluxo de cadastro continuam como estavam.
