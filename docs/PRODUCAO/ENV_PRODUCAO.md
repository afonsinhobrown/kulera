# Variáveis para Produção

Copie para o painel de ambiente do seu deploy (Vercel/Railway/Render).

## Obrigatórias
```env
DATABASE_URL=postgres://user:pass@host:5432/dbname
SITE_URL=https://seu-dominio.co.mz
PAYSUITE_CREATE_URL=https://api.paysuite.tech/payments  # ajustar conforme doc
PAYSUITE_TOKEN=seu_token_real
PAYSUITE_WEBHOOK_SECRET=seu_webhook_secret_real
ADMIN_KEY=gerar_chave_aleatoria_forte
```

## Recomendadas
```env
DEFAULT_COMMISSION_BPS=2000
NODE_ENV=production
```

## Remover em Produção
```env
# REMOVER ESTAS
SANDBOX
TEST_PRICE_MT
TEST_PRICE_MT_ALL
FORCE_TEST_PRICE
```

## Gerar chaves
Pode usar:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
