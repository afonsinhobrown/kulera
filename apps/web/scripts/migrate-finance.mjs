// Cria as tabelas do financeiro (autores, livro↔autor, livro de razão, saldos) e garante
// que o Emílio existe como autor do sistema. Idempotente.
//
//   DATABASE_URL=... node scripts/migrate-finance.mjs

import pg from 'pg';
import { ensureFinanceSchema, ensureRelatedAuthor } from '../lib/finance.js';
import { ensureWithdrawalSchema } from '../lib/withdrawals.js';
import { ensureAuthorSchema } from '../lib/author-auth.js';

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL no ambiente.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

try {
  await ensureFinanceSchema(pool);
  await ensureRelatedAuthor(pool);
  await ensureWithdrawalSchema(pool);
  await ensureAuthorSchema(pool);
  const t = await pool.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name in
        ('fair_authors','fair_book_authors','fair_ledger','fair_balances','fair_withdrawals','fair_withdrawal_approvals','fair_author_accounts','fair_author_sessions')
      order by 1`,
  );
  console.log('Tabelas do financeiro:', t.rows.map((r) => r.table_name).join(', '));
  const a = await pool.query("select id, full_name, is_related from fair_authors where is_related = true");
  console.log('Autor da casa:', JSON.stringify(a.rows));
} catch (e) {
  console.error('Falhou:', e?.message || String(e));
  process.exitCode = 1;
} finally {
  await pool.end();
}
