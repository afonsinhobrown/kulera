// Corrige as vendas gravadas com o modelo antigo (20% plataforma / 80% Kulera, sem gateway),
// aplicando-lhes as regras actuais. Não há saques registados, portanto ninguém recebeu por elas:
// o que se corrige é a repartição e o saldo, não um pagamento.
//
//   node scripts/fix-legacy-sales.mjs            → mostra o que faria
//   node scripts/fix-legacy-sales.mjs --apply    → grava
//
// Idempotente: o livro de razão usa chave por encomenda, por isso correr duas vezes não duplica.

import pg from 'pg';
import { ensureFinanceSchema, postSale, resolveSaleScenario } from '../lib/finance.js';
import { splitSale } from '../lib/split.js';

const apply = process.argv.includes('--apply');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

const n = (v) => Number(v ?? 0);

try {
  await ensureFinanceSchema(pool);

  // Vendas antigas: gateway nulo/zero e a comissão a absorver tudo (app + editors = bruto).
  const rows = (
    await pool.query(
      `select s.order_id, s.book_id, s.partner_id, s.gross_minor, s.gateway_minor,
              coalesce(s.app_minor,0) as app_minor, coalesce(s.editors_minor,0) as editors_minor,
              coalesce(s.partner_minor,0) as partner_minor, coalesce(s.author_minor,0) as author_minor,
              b.title
         from fair_sales s left join fair_books b on b.id = s.book_id
        where coalesce(s.gateway_minor,0) = 0
          and coalesce(s.author_minor,0) = 0
        order by s.created_at`,
    )
  ).rows;

  console.log(`${rows.length} venda(s) com o modelo antigo.`);

  let mudadas = 0;
  for (const r of rows) {
    const gross = n(r.gross_minor);
    const resolved = await resolveSaleScenario(pool, { bookId: r.book_id, publisherId: r.partner_id });
    const split = splitSale({
      grossMinor: gross,
      scenario: resolved.scenario,
      authorShareBps: resolved.authorShareBps,
      authorAmountMinor: resolved.authorAmountMinor,
    });

    const bps = (m) => (gross > 0 ? Math.min(10000, Math.round((m * 10000) / gross)) : 0);
    const commission = split.techNet + split.kulera;

    console.log(
      `  ${r.title}: ${r.app_minor}/${r.editors_minor} → plataforma ${split.techNet}, Kulera ${split.kulera}, gateway ${split.gateway} (cenário ${split.scenario})`,
    );

    if (!apply) continue;

    await pool.query(
      `update fair_sales set
         app_minor = $2, editors_minor = $3, partner_minor = $4, author_minor = $5,
         gateway_minor = $6, gateway_bps = 700,
         commission_minor = $7, commission_bps = $8, app_bps = $9, editors_bps = $10, app_net_minor = $2
       where order_id = $1`,
      [
        r.order_id,
        split.techNet,
        split.kulera,
        split.publisher,
        split.author,
        split.gateway,
        commission,
        bps(commission),
        bps(split.techNet),
        bps(split.kulera),
      ],
    );

    await postSale(pool, {
      orderId: r.order_id,
      bookId: r.book_id,
      publisherId: r.partner_id,
      authorId: resolved.authorId,
      split,
    });
    mudadas += 1;
  }

  if (!apply) {
    console.log('Correr com --apply para gravar.');
  } else {
    console.log(`Vendas corrigidas: ${mudadas}.`);
    const saldos = await pool.query(
      `select entity, coalesce(accrued_minor,0) as accrued, coalesce(paid_minor,0) as paid
         from fair_balances where entity in ('tecnoincubadora','kulera','emilio') order by entity`,
    );
    console.log('Saldos:', JSON.stringify(saldos.rows));
  }
} catch (e) {
  console.error('Falhou:', e?.message || String(e));
  process.exitCode = 1;
} finally {
  await pool.end();
}
