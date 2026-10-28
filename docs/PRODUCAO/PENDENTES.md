# PENDENTES PARA PRODUÇÃO - Kulera+

## A FAZER MAIS TARDE

### 1) Vercel - Variáveis
- [ ] Adicionar `PAYSUITE_CREATE_URL` (Production)
- [ ] Adicionar `PAYSUITE_TOKEN` (Production) - secret
- [ ] Adicionar `PAYSUITE_WEBHOOK_SECRET` (Production) - secret
- [ ] Atualizar `SITE_URL` para domínio final (se diferente de kulera.vercel.app)
- [ ] Remover `SANDBOX`, `TEST_PRICE_MT`, `TEST_PRICE_MT_ALL`, `FORCE_TEST_PRICE` de Production
- [ ] Definir `NODE_ENV=production` (se não existir)

### 2) PaySuite
- [ ] Configurar callback/webhook para: `https://SEU-DOMINIO/api/webhook`
- [ ] Verificar assinatura HMAC no painel PaySuite
- [ ] Testar com valor real pequeno

### 3) Base de Dados
- [ ] Aplicar schema `apps/web/db/schema.sql` no Neon/Postgres produção
- [ ] Aplicar migrações API: `DATABASE_URL=... node apps/api/src/db/migrate.ts`
- [ ] Fazer backup antes

### 4) Verificações
- [ ] Testar compra end-to-end
- [ ] Testar webhook com pagamento real
- [ ] Verificar split de comissões
- [ ] Testar acesso ao leitor após pagamento
- [ ] Verificar painel admin com `ADMIN_KEY` real

**Estado atual:** Dev/test funcional. Só falta configuração de produção.
