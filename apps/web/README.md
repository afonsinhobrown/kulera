# Kulera+ — Plataforma de venda e leitura de livros

Catálogo de vários livros, cada um com o seu preço, parceiros (editoras e escritores) com comissão própria, pagamento real PaySuite e leitura protegida, só na plataforma. Os preços vivem na base de dados: **nada de preços no código**.

## Colocar no ar (cerca de 20 minutos)
1. **Neon:** crie a base de dados e corra `db/schema.sql` no editor SQL.
2. **Chave do painel (só na base de dados):** o acesso ao `/admin.html` usa a chave guardada em `fair_settings.admin_key`. Defina-a uma vez no editor SQL do Neon (nunca em variáveis de ambiente):
   ```sql
   insert into fair_settings (key, value) values ('admin_key', 'UMA-SENHA-LONGA-E-FORTE')
   on conflict (key) do update set value = excluded.value, updated_at = now();
   ```
3. **Vercel:** importe esta pasta como projecto e defina as variáveis de `.env.example`: `DATABASE_URL`, `SITE_URL`, `PAYSUITE_CREATE_URL`, `PAYSUITE_TOKEN`, `PAYSUITE_WEBHOOK_SECRET`. Faça deploy.
4. **PaySuite:** configure o webhook `https://SEU-SITE/api/webhook`.
5. **Confirme `lib/paysuite.js`** com a implementação PaySuite que já usa (campos do pedido e da resposta, nomes dos eventos, formato da assinatura). Está tudo marcado no ficheiro.
6. **Textos:** edite `book.config.json` (WhatsApp de suporte e oferta aos parceiros).
7. Abra `/admin.html`, entre com a chave definida na base de dados e:
   - crie os **parceiros** (com a comissão da Kulera para cada um);
   - crie os **livros**: título, autor, sinopse, **preço**, parceiro (ou «Kulera»), capa (ficheiro, Ctrl+V, arrastar ou endereço de imagem) e o ficheiro do livro (Word .docx, HTML ou PDF, lido no leitor da plataforma); cada «Título 1» do Word vira um capítulo;
   - ponha o estado em **Publicado**. Um livro sem conteúdo nunca fica publicado nem se vende.

## O que a plataforma faz
- Loja com todos os livros publicados; comprar com M-Pesa, e-Mola ou Visa; confirmação automática; leitura logo a seguir (telemóvel e computador).
- **Link de partilha por livro** (`/livro/<id>`): mostra a capa, os preços e um botão **Compre agora** por formato, que leva à página de pagamento desse livro. A pré-visualização no WhatsApp/Facebook mostra a capa, o título e os preços (a capa é servida pela mesma função, em `/api/livro?id=<id>&capa=1`, mesmo quando está guardada em base64 no painel).
- Divisão da receita registada em cada venda (comissão aplicada na altura, que não muda depois) e valores a pagar a cada parceiro no painel, com CSV.
- Captação de parceiros (`parceiros.html`) com lista, estado e WhatsApp directo no painel.
- Segurança: o livro só sai com pagamento confirmado; sem ficheiro nem link público; marca de água com nome e telemóvel; webhooks com assinatura e sem duplicados; preço e disponibilidade sempre da base de dados; livros físicos só se vendem com stock > 0. **Nenhum token de pagamento no código nem na base de dados:** o token da PaySuite vem apenas de `PAYSUITE_TOKEN`/`PAYSUITE_API_KEY` (ambiente do servidor) e não é mostrado nem editável no painel. A chave do painel vive só em `fair_settings.admin_key`.

## Testes
`npm install && npm test` (testes da lógica e do fluxo completo comprar → pagar → ler, com base de dados simulada). **Isto não substitui a compra de teste real** com a PaySuite e o Neon antes de vender:
- [ ] Compra real de valor baixo, no telemóvel, por M-Pesa e por Visa; a página confirma sozinha e o livro abre.
- [ ] Cancelar o pagamento: o livro NÃO abre. Token inventado em `/ler.html?t=`: «Sem acesso».
- [ ] Em `fair_orders` aparece `paid`, em `fair_sales` a divisão, e no painel os valores.

## Plano B
Link de pagamento PaySuite e envio manual do livro por WhatsApp, para a venda não depender só do código.

## Limites actuais (o que falta para a plataforma completa)
- **Parceiros ainda não entram sozinhos:** hoje é a Kulera que cria parceiros e carrega livros no painel. Falta o portal do parceiro (login, carregar e acompanhar os seus livros e vendas) e a **subscrição de parceiros e de leitores** com pagamento recorrente. O esquema completo (`apps/api` do repositório `kulera-plus`) já prevê planos, subscrições, repasses e pedidos físicos.
- **Conteúdo de parceiros:** quando os parceiros carregarem livros sozinhos, é obrigatório sanitizar o HTML (por exemplo, com `sanitize-html`) antes de o mostrar. Hoje só a Kulera carrega, por isso o risco é controlado.
- Quem perder o endereço do livro perde o acesso: reenvie `/ler.html?t=<token>` consultando `fair_orders` pelo telemóvel do comprador.
- Ninguém impede fotografar o ecrã; a marca de água serve para identificar fugas.
