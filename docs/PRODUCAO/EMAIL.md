# Email e novidades — configuração

A plataforma envia:

1. **Email de acesso** depois do pagamento confirmado (uma vez por encomenda) — link de leitura.
2. **Novidades** (anúncio de um livro) para todos os subscritores que autorizaram no checkout.
3. **Teste** de configuração a partir do painel.

Tudo é opcional: sem as variáveis abaixo, o site continua a funcionar e não envia email.

## 1. Escolher o provedor

| Provedor | Variáveis | Notas |
|---|---|---|
| **Resend** (recomendado) | `RESEND_API_KEY`, `EMAIL_FROM` | Fácil, bom para transaccional; plano gratuito limitado por dia |
| **Brevo** | `BREVO_API_KEY`, `EMAIL_FROM` | Plano gratuito maior por dia |

Usar **um** dos dois. `EMAIL_PROVIDER` só é necessário se houver as duas chaves ao mesmo tempo (`resend` ou `brevo`).

## 2. Verificar o domínio (Resend)

O subdomínio **`doremi.tecnoincubadora.org`** já está verificado no Resend e é usado por omissão
como remetente (`livros@doremi.tecnoincubadora.org`). **Não é preciso criar/alterar registos DNS.**

Se um dia quiser enviar de outro domínio:
1. resend.com → **Domains → Add Domain** → o domínio.
2. Copiar os registos DNS que o Resend mostra e criá-los no **Cloudflare** (DNS only):
   - **MX** + **TXT/SPF** no subdomínio `send.<dominio>`;
   - **TXT DKIM** em `resend._domainkey.<dominio>`;
   - recomendado **DMARC**: `TXT _dmarc.<dominio>` = `v=DMARC1; p=none; rua=mailto:livros@<dominio>`.
3. **Verify** no Resend até ficar *Verified*.
4. **API Keys → Create** e copiar a chave (`re_...`).

## 3. Variáveis na Vercel

Basta **uma** variável obrigatória (`RESEND_API_KEY`). Projecto → **Settings → Environment Variables**
(Production **e** Preview) e depois **Redeploy**:

```
RESEND_API_KEY=re_...
```

Opcionais (só se quiser personalizar):

```
EMAIL_PROVIDER=resend
EMAIL_FROM=Kulera+ <livros@doremi.tecnoincubadora.org>
EMAIL_SUPPORT_TO=nachingweya@gmail.com   # só o email de compra pede resposta
EMAIL_UNSUBSCRIBE_SECRET=<segredo longo>
MARKETING_ENABLED=true
SITE_URL=https://kulera.tecnoincubadora.org
```

Gerar o segredo de cancelamento (se quiser separá-lo do webhook):

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`EMAIL_UNSUBSCRIBE_SECRET` assina os links de cancelamento (`/sair.html?e=...&s=...`).
Sem ele, a assinatura usa o segredo do webhook (funciona, mas fica menos isolado).

## 4. Confirmar

1. `/admin.html` → **Vendas & Saques** → “Comunicação por Email”.
2. Escrever um email em “email para teste” → **Enviar teste**.
3. Se chegar, o envio está configurado.

## 5. Como funcionam as novidades

- No checkout, o comprador pode marcar **“Quero receber novidades…”** (opcional, e só com email preenchido).
- Ao confirmar o pagamento, o email de acesso é enviado e, se autorizou, o email fica na lista.
- No painel escolhe-se o livro e **“Anunciar este livro”**.
- **Limite por plano do parceiro** (por livro, por mês):
  - Básico: 1 anúncio
  - Profissional: 2
  - Premium: 4
  - Livros da própria Kulera: 4
- Cada anúncio fica registado (data, livro, nº de emails) na tabela do painel.
- Todos os emails de novidades têm link **Cancelar subscrição** (`/sair.html`), que passa a valer imediatamente.

## 6. Boas práticas

- Enviar no máximo **200 emails por anúncio** (o limite é por execução); listas maiores pedem envio em lotes.
- Evitar anunciar em dias seguidos o mesmo livro — o limite do plano já o impede.
- Quem compra recebe sempre o email de acesso, mesmo sem autorizar novidades.
- Resend/Brevo registam bounces e queixas; vale a pena verificar a entregabilidade nas primeiras semanas.

## 7. Resolução de problemas

| Sintoma | Causa provável |
|---|---|
| “email_not_configured” | Falta `RESEND_API_KEY` ou `EMAIL_FROM`, ou não houve redeploy |
| Envio devolve `resend_403` | Domínio não verificado ou remetente diferente do domínio verificado |
| Email cai em spam | Falta SPF/DKIM/DMARC, ou conteúdo demasiado “comercial” |
| Botão “Anunciar” diz “limite do plano atingido” | Quota mensal do plano já usada para esse livro |
