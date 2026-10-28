# Preparação para Produção - Kulera+

## 1) Variáveis de ambiente (obrigatórias)
Configure no painel da Vercel/servidor:

| Variável | Onde | Descrição |
| --- | --- | --- |
| `DATABASE_URL` | web/api | Postgres (Neon/Render/Railway). Obrigatório. |
| `SITE_URL` | web/api | URL pública ex: `https://seu-dominio.co.mz` |
| `PAYSUITE_CREATE_URL` | web | Endpoint para criar pagamento PaySuite |
| `PAYSUITE_TOKEN` | web | Token Bearer PaySuite |
| `PAYSUITE_WEBHOOK_SECRET` | web/api | Segredo para validar assinatura HMAC do webhook |
| `ADMIN_KEY` | web | Chave para aceder ao `/admin.html` (usar chave longa aleatória) |
| `DEFAULT_COMMISSION_BPS` | api | Comissão padrão Kulera (2000 = 20%) |
| `PANDOC_CMD` | worker | `pandoc` (se usar worker) |
| `EPUBCHECK_CMD` | worker | `epubcheck` (se usar worker) |

**Remover em produção:** `SANDBOX`, `TEST_PRICE_MT`, `TEST_PRICE_MT_ALL`, `FORCE_TEST_PRICE`

## 2) Base de dados
### Web (Vercel + Postgres)
O schema está em `apps/web/db/schema.sql`. Pode aplicar com `psql` ou via Neon SQL Editor.

### API
Tem migrações em `apps/api/migrations/001_init.sql`. Aplicar com:
```bash
DATABASE_URL="postgres://..." node apps/api/src/db/migrate.ts
```

## 3) Deploy
### Frontend/API (Vercel)
- Root Directory: `apps/web` ou usar monorepo
- Build Command: (vazio)
- Install Command: `npm install`
- Output: estático + funções em `/api`

### API standalone (Railway/Render)
```bash
npm install
cd apps/api && DATABASE_URL="..." node src/db/migrate.ts
node src/server.ts
```

### Worker
Requer: `pandoc`, `epubcheck`, opcional `calibre` (ebook-convert). Definir PATH ou variáveis `*_CMD`.

## 4) Checklist pré-produção
- [ ] Trocar `ADMIN_KEY` por valor forte
- [ ] Remover variáveis de teste
- [ ] Configurar webhook PaySuite para apontar para `https://SEU-DOMINIO/api/webhook`
- [ ] Testar compra real com 1 MT ou valor pequeno
- [ ] Verificar `GET /health` na API
- [ ] Garantir HTTPS
- [ ] Backup da base de dados
- [ ] Validar permissões do painel admin
- [ ] Confirmar split/comissões corretos

## 5) Comandos úteis
```bash
# Testes
npm test
npx tsx --test apps/worker/test/epub.test.ts

# Migrar API
DATABASE_URL=... node apps/api/src/db/migrate.ts
```

## Segurança
- Nunca commitar `.env*` com segredos reais
- Webhook sempre validado por HMAC
- Preços vêm sempre da BD
- Conteúdo pago protegido por token + verificação de acesso
- Idempotência em webhooks
