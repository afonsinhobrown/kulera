// Base de dados falsa em memória, só para testar a lógica das funções (não é o PostgreSQL real).
export const S = { books: [], partners: [], orders: [], events: [], sales: [] };
const rows = (r) => ({ rows: r, rowCount: r.length });
async function q(sql, p = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return rows([]);
  if (s.startsWith('select id, title, price_minor, currency from fair_books')) return rows(S.books.filter((b) => b.id === p[0] && b.status === 'published' && b.content_html != null));
  if (s.startsWith('select id, title, author, description, language, price_minor')) return rows(S.books.filter((b) => b.status === 'published' && b.content_html != null).map((b) => ({ id: b.id, title: b.title, author: 'A', description: null, language: 'pt', price_minor: b.price_minor, currency: b.currency, cover_url: null })));
  if (s.startsWith('insert into fair_orders')) { S.orders.push({ id: p[0], token: p[1], reference: p[2], buyer_name: p[3], buyer_phone: p[4], amount_minor: p[6], currency: p[7], book_id: p[8], status: 'created', provider_payment_id: null }); return rows([{}]); }
  if (s.startsWith('update fair_orders set provider_payment_id = $2, checkout_url')) { const o = S.orders.find((x) => x.id === p[0]); o.provider_payment_id = p[1]; if (o.status === 'created') o.status = 'pending'; return rows([{}]); }
  if (s.startsWith("update fair_orders set status = 'failed'")) return rows([]);
  if (s.startsWith('select id, status from fair_orders where provider_payment_id')) return rows(S.orders.filter((o) => (p[0] && o.provider_payment_id === p[0]) || o.reference === p[1]));
  if (s.startsWith('insert into fair_events')) { if (S.events.includes(p[0])) return { rows: [], rowCount: 0 }; S.events.push(p[0]); return rows([{}]); }
  if (s.startsWith("update fair_orders set status = 'paid'")) { const o = S.orders.find((x) => x.id === p[0]); if (!o || o.status === 'paid') return rows([]); o.status = 'paid'; return rows([{}]); }
  if (s.startsWith('update fair_orders set status = $2')) return rows([]);
  if (s.startsWith('select o.book_id, o.amount_minor')) { const o = S.orders.find((x) => x.id === p[0]); const b = S.books.find((x) => x.id === o.book_id); const pt = S.partners.find((x) => x.id === b.partner_id); return rows([{ book_id: o.book_id, amount_minor: o.amount_minor, partner_id: b.partner_id ?? null, commission_bps: pt?.commission_bps }]); }
  if (s.startsWith('insert into fair_sales')) { if (S.sales.find((x) => x.order_id === p[0])) return rows([]); S.sales.push({ order_id: p[0], partner_id: p[2], gross: p[3], bps: p[4], commission: p[5], partner: p[6] }); return rows([{}]); }
  if (s.startsWith('select status from fair_orders where token')) return rows(S.orders.filter((o) => o.token === p[0]).map((o) => ({ status: o.status })));
  if (s.startsWith('select o.buyer_name, o.buyer_phone, b.title')) return rows(S.orders.filter((o) => o.token === p[0] && o.status === 'paid').map((o) => ({ buyer_name: o.buyer_name, buyer_phone: o.buyer_phone, title: S.books.find((b) => b.id === o.book_id).title, content_html: S.books.find((b) => b.id === o.book_id).content_html })));
  throw new Error('SQL não previsto no teste: ' + s.slice(0, 80));
}
export class Pool { query(s, p) { return q(s, p); } async connect() { return { query: q, release() {} }; } }
export default { Pool };
