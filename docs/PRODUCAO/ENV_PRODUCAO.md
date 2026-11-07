# Variáveis para Produção

Copie para o painel de ambiente do seu deploy (Vercel/Railway/Render).

## Obrigatórias
```env
DATABASE_URL=postgres://user:pass@host:5432/dbname
SITE_URL=https://seu-dominio.co.mz
PAYSUITE_CREATE_URL=https://paysuite.tech/api/v1/payments
PAYSUITE_TOKEN=seu_token_real
PAYSUITE_WEBHOOK_SECRET=seu_webhook_secret_real
```

## Recomendadas
```env
DEFAULT_COMMISSION_BPS=2000
NODE_ENV=production
```

## Chave do painel admin (só na base de dados)
Não existe `ADMIN_KEY` no ambiente. A chave do `/admin.html` é lida exclusivamente de
`fair_settings.admin_key`. Defina/altere no editor SQL da base de dados:

```sql
insert into fair_settings (key, value) values ('admin_key', 'UMA-SENHA-LONGA-E-FORTE')
on conflict (key) do update set value = excluded.value, updated_at = now();
```

Se a chave não existir, o painel responde `admin_key_not_configured` e não deixa entrar
(não há palavra-passe por omissão).

## Remover em Produção
```env
# REMOVER ESTAS
ADMIN_KEY
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
