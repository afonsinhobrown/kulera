// Relatório financeiro: global, semana, mês, ano (ou período escolhido).
//
// Lê das tabelas de venda e do livro de razão. Todos os valores saem em centavos e são
// convertidos para número na resposta (o Postgres devolve bigint como texto).

const n = (v) => Number(v ?? 0);

export const PERIODS = ['week', 'month', 'year', 'all', 'custom'];

/** Calcula o intervalo do período pedido. */
export function resolvePeriod(period, { from = null, to = null } = {}, now = new Date()) {
  const end = now;
  if (period === 'week') return { from: new Date(now.getTime() - 7 * 86400000), to: end, label: 'Últimos 7 dias' };
  if (period === 'month') {
    return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: end, label: 'Este mês' };
  }
  if (period === 'year') {
    return { from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), to: end, label: 'Este ano' };
  }
  if (period === 'custom' && from) {
    return { from: new Date(from), to: to ? new Date(to) : end, label: 'Período escolhido' };
  }
  return { from: new Date('2000-01-01T00:00:00Z'), to: end, label: 'Tudo' };
}

const safe = async (db, sql, params) => {
  try {
    return (await db.query(sql, params)).rows;
  } catch (e) {
    console.error('report.query', e?.message || String(e));
    return [];
  }
};

export async function buildReport(db, { from, to }) {
  const p = [from, to];

  const totalRows = await safe(
    db,
    `select count(*)::int as sales,
            coalesce(sum(gross_minor),0) as gross,
            coalesce(sum(gateway_minor),0) as gateway,
            coalesce(sum(author_minor),0) as author,
            coalesce(sum(partner_minor),0) as publisher,
            coalesce(sum(app_minor),0) as tech,
            coalesce(sum(editors_minor),0) as kulera
       from fair_sales where created_at >= $1 and created_at <= $2`,
    p,
  );
  const t = totalRows[0] || {};

  const sales = await safe(
    db,
    `select s.created_at, s.order_id,
            coalesce(b.title, '(livro removido)') as book,
            coalesce(pt.name, 'Editora Kulera') as publisher,
            s.gross_minor, s.gateway_minor, s.author_minor, s.partner_minor,
            s.app_minor, s.editors_minor
       from fair_sales s
       left join fair_books b on b.id = s.book_id
       left join fair_partners pt on pt.id = s.partner_id
      where s.created_at >= $1 and s.created_at <= $2
      order by s.created_at desc
      limit 2000`,
    p,
  );

  const byPublisherBook = await safe(
    db,
    `select coalesce(pt.name, 'Editora Kulera') as publisher,
            coalesce(b.title, '(livro removido)') as book,
            count(*)::int as sales,
            coalesce(sum(s.gross_minor),0) as gross,
            coalesce(sum(s.partner_minor),0) as publisher_share,
            coalesce(sum(s.app_minor),0) as tech_share,
            coalesce(sum(s.gateway_minor),0) as gateway
       from fair_sales s
       left join fair_books b on b.id = s.book_id
       left join fair_partners pt on pt.id = s.partner_id
      where s.created_at >= $1 and s.created_at <= $2
      group by 1, 2
      order by gross desc`,
    p,
  );

  const byAuthorBook = await safe(
    db,
    `select a.full_name as author,
            coalesce(b.title, '(livro removido)') as book,
            count(*)::int as movements,
            coalesce(sum(l.amount_minor),0) as received
       from fair_ledger l
       join fair_authors a on a.id = l.entity_id
       left join fair_books b on b.id = l.book_id
      where l.entity = 'author' and l.kind = 'sale' and l.created_at >= $1 and l.created_at <= $2
      group by 1, 2
      order by received desc`,
    p,
  );

  const withdrawals = await safe(
    db,
    `select id, kind, entity, amount_minor, fee_minor, net_minor, status, extraordinary,
            share_tech_minor, share_emilio_minor, requested_by, requested_at, paid_at
       from fair_withdrawals
      where requested_at >= $1 and requested_at <= $2
      order by requested_at desc`,
    p,
  );

  const balances = await safe(
    db,
    `select entity, entity_id, accrued_minor, paid_minor
       from fair_balances
      where entity in ('tecnoincubadora','kulera','emilio')
      order by entity`,
    [],
  );

  const balanceMap = {};
  for (const b of balances) {
    balanceMap[b.entity] = {
      accrued: n(b.accrued_minor),
      paid: n(b.paid_minor),
      available: n(b.accrued_minor) - n(b.paid_minor),
    };
  }

  const gross = n(t.gross);
  const gateway = n(t.gateway);
  const fees = withdrawals.reduce((s, w) => s + n(w.fee_minor), 0);

  return {
    totals: {
      sales: n(t.sales),
      gross,
      gateway,
      net: gross - gateway,
      author: n(t.author),
      publisher: n(t.publisher),
      tech: n(t.tech),
      kulera: n(t.kulera),
      emilio: 0, // o Emílio não recebe royalties: ganha na divisão de lucros
      withdrawalFees: fees,
      withDrawn: withdrawals.filter((w) => w.status === 'paid').reduce((s, w) => s + n(w.amount_minor), 0),
    },
    sales: sales.map((r) => ({
      at: r.created_at,
      order: r.order_id,
      book: r.book,
      publisher: r.publisher,
      gross: n(r.gross_minor),
      gateway: n(r.gateway_minor),
      author: n(r.author_minor),
      publisherShare: n(r.partner_minor),
      tech: n(r.app_minor),
      kulera: n(r.editors_minor),
    })),
    byPublisherBook: byPublisherBook.map((r) => ({
      publisher: r.publisher,
      book: r.book,
      sales: n(r.sales),
      gross: n(r.gross),
      publisherShare: n(r.publisher_share),
      tech: n(r.tech_share),
      gateway: n(r.gateway),
    })),
    byAuthorBook: byAuthorBook.map((r) => ({
      author: r.author,
      book: r.book,
      movements: n(r.movements),
      received: n(r.received),
    })),
    withdrawals: withdrawals.map((w) => ({
      id: w.id,
      kind: w.kind,
      entity: w.entity,
      amount: n(w.amount_minor),
      fee: n(w.fee_minor),
      net: n(w.net_minor),
      status: w.status,
      extraordinary: w.extraordinary,
      techShare: n(w.share_tech_minor),
      emilioShare: n(w.share_emilio_minor),
      requestedBy: w.requested_by,
      requestedAt: w.requested_at,
      paidAt: w.paid_at,
    })),
    balances: balanceMap,
  };
}
