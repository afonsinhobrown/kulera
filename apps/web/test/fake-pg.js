// Base de dados falsa em memória, só para testar a lógica das funções (não é o PostgreSQL real).
export const S = {
  books: [],
  partners: [],
  partnerUsers: [],
  plans: [],
  subscriptions: [],
  orders: [],
  events: [],
  sales: [],
  publicationFees: [],
  settings: {},
};

const rows = (r) => ({ rows: r, rowCount: r.length });

function canSellPartner(partnerId) {
  if (!partnerId) return true;
  const subs = S.subscriptions.filter((s) => s.partner_id === partnerId);
  if (subs.length === 0) return true;
  return subs.some((s) => s.status === 'active' && new Date(s.ends_at) > new Date());
}

async function q(sql, p = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return rows([]);
  if (/^(create table|alter table)/i.test(s)) return rows([]);
  if (/^insert into fair_settings/i.test(s)) {
    if (s.includes("'sandbox'")) S.settings.sandbox = p[0];
    else if (s.includes("'admin_key'") && p.length) S.settings.admin_key = p[0];
    else if (s.includes("'admin_key'") && !S.settings.admin_key) S.settings.admin_key = 'kulera';
    return rows([]);
  }
  if (/^select value from fair_settings where key='sandbox'/i.test(s)) {
    return S.settings.sandbox !== undefined ? rows([{ value: S.settings.sandbox }]) : rows([]);
  }
  if (/^select value from fair_settings where key='admin_key'/i.test(s)) {
    return rows([{ value: S.settings.admin_key || 'kulera' }]);
  }
  if (/^select value from fair_settings where key='paysuite_token'/i.test(s)) {
    return S.settings.paysuite_token ? rows([{ value: S.settings.paysuite_token }]) : rows([]);
  }
  if (/^insert into fair_plans/i.test(s)) {
    const [code, name, description, price_minor, max_publications, showcase_priority] = p;
    if (!S.plans.find((x) => x.code === code)) {
      S.plans.push({
        id: '00000000-0000-4000-8000-00000000090' + (S.plans.length + 1),
        code,
        name,
        description,
        price_minor,
        currency: 'MZN',
        interval: 'month',
        status: 'active',
        max_publications,
        showcase_priority,
      });
    }
    return rows([]);
  }
  if (/^update fair_plans set status='archived'/i.test(s)) return rows([]);
  if (/^select id,code,name,description,price_minor,currency,interval,max_publications,showcase_priority from fair_plans/i.test(s)) {
    return rows(S.plans.filter((x) => x.status === 'active'));
  }
  if (/^select \* from fair_plans where id=\$1 and status='active'/i.test(s)) {
    return rows(S.plans.filter((x) => x.id === p[0] && x.status === 'active'));
  }
  if (/^select interval from fair_plans where id=\$1/i.test(s)) {
    return rows(S.plans.filter((x) => x.id === p[0]).map((x) => ({ interval: x.interval || 'month' })));
  }
  if (/^select u\.partner_id, p\.name, p\.phone, p\.email from fair_partner_users/i.test(s)) {
    const u = S.partnerUsers.find((x) => x.id === p[0] && x.status === 'active');
    if (!u) return rows([]);
    const pt = S.partners.find((x) => x.id === u.partner_id);
    return pt ? rows([{ partner_id: pt.id, name: pt.name, phone: pt.phone, email: pt.email }]) : rows([]);
  }
  if (/^select partner_id,status from fair_partner_users/i.test(s)) {
    return rows(S.partnerUsers.filter((x) => x.id === p[0] && x.status === 'active'));
  }
  if (/^select name,phone,email from fair_partners where id=\$1/i.test(s)) {
    return rows(S.partners.filter((x) => x.id === p[0]));
  }
  if (/^select id,title,publication_fee_minor from fair_books where id=\$1 and partner_id=\$2/i.test(s)) {
    return rows(
      S.books.filter(
        (b) => b.id === p[0] && b.partner_id === p[1] && !b.publication_fee_paid_at && (b.publication_fee_minor || 0) > 0,
      ),
    );
  }
  if (s.startsWith('select b.id, b.title, b.price_minor, b.currency, b.kind') || s.startsWith('select id, title, price_minor, currency')) {
    return rows(
      S.books
        .filter((b) => b.id === p[0] && b.status === 'published')
        .map((b) => ({
          id: b.id,
          title: b.title,
          price_minor: b.price_minor,
          currency: b.currency || 'MZN',
          kind: b.kind || 'ebook',
          requires_shipping: b.requires_shipping || false,
          stock: b.stock ?? null,
          content_html: b.content_html ?? null,
          has_digital: b.has_digital ?? b.kind !== 'physical',
          has_physical: b.has_physical ?? (b.kind === 'physical' || Boolean(b.requires_shipping)),
          price_physical_minor: b.price_physical_minor ?? null,
          partner_id: b.partner_id ?? null,
          can_sell: canSellPartner(b.partner_id),
        })),
    );
  }
  if (s.startsWith('select b.id, b.title, b.author, b.description') || s.startsWith('select id, title, author, description, language, price_minor')) {
    return rows(
      S.books
        .filter(
          (b) =>
            b.status === 'published' &&
            (b.kind === 'physical' || b.has_physical || b.content_html != null) &&
            canSellPartner(b.partner_id),
        )
        .map((b) => ({
          id: b.id,
          title: b.title,
          author: b.author || 'A',
          description: b.description ?? null,
          language: b.language || 'pt',
          price_minor: b.price_minor,
          currency: b.currency || 'MZN',
          cover_url: b.cover_url ?? null,
          kind: b.kind || 'ebook',
          requires_shipping: b.requires_shipping || false,
          stock: b.stock ?? null,
          has_digital: b.has_digital ?? b.kind !== 'physical',
          has_physical: b.has_physical ?? (b.kind === 'physical' || Boolean(b.requires_shipping)),
          has_content: b.content_html != null,
          price_physical_minor: b.price_physical_minor ?? null,
          updated_at: b.updated_at ?? null,
          priority: b.partner_id ? 1 : 99,
        })),
    );
  }
  if (s.startsWith('update fair_books set title=$2')) {
    const b = S.books.find((x) => x.id === p[0]);
    if (b) {
      b.title = p[1];
      b.author = p[2];
      b.description = p[3];
      b.language = p[4];
      b.price_minor = p[5];
      b.partner_id = p[6];
      b.status = p[7];
      b.cover_url = p[8];
      if (p[9]) b.content_html = p[9];
      if (p.length > 10) {
        b.kind = p[10];
        b.stock = p[11];
        b.requires_shipping = p[12];
        b.has_digital = p[13];
        b.has_physical = p[14];
      }
      b.updated_at = new Date().toISOString();
    }
    return rows([]);
  }
  if (s.startsWith('update fair_books set price_physical_minor=$2')) {
    const b = S.books.find((x) => x.id === p[0]);
    if (b) b.price_physical_minor = p[1];
    return rows([]);
  }
  if (s.startsWith('update fair_books set publication_fee_minor = case')) {
    return rows([]);
  }
  if (s.startsWith("update fair_books set status='draft' where id=$1")) {
    return rows([]);
  }
  if (s.startsWith('insert into fair_orders')) {
    const colMatch = s.match(/insert into fair_orders \(([^)]+)\)/i);
    const cols = colMatch ? colMatch[1].split(',').map((c) => c.trim()) : [];
    const obj = { status: 'created', provider_payment_id: null };
    cols.forEach((c, idx) => {
      obj[c] = p[idx];
    });
    S.orders.push(obj);
    return rows([{}]);
  }
  if (s.startsWith('update fair_books set stock = stock - 1')) {
    const b = S.books.find((x) => x.id === p[0]);
    if (b && b.stock != null && b.stock >= 1) b.stock--;
    return rows([{}]);
  }
  if (s.startsWith('update fair_books set stock = stock + 1')) {
    const b = S.books.find((x) => x.id === p[0]);
    if (b && b.stock != null) b.stock++;
    return rows([{}]);
  }
  if (s.startsWith('update fair_orders set provider_payment_id')) {
    const o = S.orders.find((x) => x.id === p[0]);
    if (o) {
      o.provider_payment_id = p[1];
      o.checkout_url = p[2];
      if (o.status === 'created') o.status = 'pending';
    }
    return rows([{}]);
  }
  if (s.startsWith("update fair_orders set status = 'failed'") || s.startsWith("update fair_orders set status='failed'")) {
    const o = S.orders.find((x) => x.id === p[0]);
    if (o && (o.status === 'created' || o.status === 'pending')) o.status = 'failed';
    return rows([]);
  }
  if (s.startsWith('select id, status from fair_orders where provider_payment_id')) {
    return rows(S.orders.filter((o) => (p[0] && o.provider_payment_id === p[0]) || (p[1] && o.reference === p[1])));
  }
  if (s.startsWith('insert into fair_events')) {
    if (S.events.includes(p[0])) return { rows: [], rowCount: 0 };
    S.events.push(p[0]);
    return rows([{}]);
  }
  if (s.startsWith("update fair_orders set status = 'paid'")) {
    const o = S.orders.find((x) => x.id === p[0]);
    if (!o || o.status === 'paid') return rows([]);
    o.status = 'paid';
    o.paid_at = new Date().toISOString();
    if (!o.provider_payment_id && p[1]) o.provider_payment_id = p[1];
    return rows([{}]);
  }
  if (s.startsWith('update fair_orders set status = $2')) {
    const o = S.orders.find((x) => x.id === p[0]);
    if (o && (o.status === 'created' || o.status === 'pending')) o.status = p[1];
    return rows([]);
  }
  if (s.startsWith('select o.book_id, o.amount_minor')) {
    const o = S.orders.find((x) => x.id === p[0]);
    const b = S.books.find((x) => x.id === o?.book_id);
    const pt = S.partners.find((x) => x.id === b?.partner_id);
    return rows([
      {
        book_id: o?.book_id ?? null,
        amount_minor: o?.amount_minor,
        plan_id: o?.plan_id ?? null,
        type: o?.type || 'book',
        partner_id: b?.partner_id ?? o?.partner_id ?? null,
        commission_bps: pt?.commission_bps,
        kind: b?.kind || 'ebook',
        content_html: b?.content_html ?? null,
      },
    ]);
  }
  if (s.startsWith('insert into fair_sales')) {
    if (S.sales.find((x) => x.order_id === p[0])) return rows([]);
    S.sales.push({
      order_id: p[0],
      book_id: p[1],
      partner_id: p[2],
      gross: p[3],
      bps: p[4],
      commission: p[5],
      partner: p[6],
      app_bps: p[7],
      editors_bps: p[8],
      app: p[9],
      editors: p[10],
    });
    return rows([{}]);
  }
  if (s.startsWith('insert into fair_publication_fees')) {
    S.publicationFees.push({ order_id: p[0], book_id: p[1], partner_id: p[2], amount_minor: p[3], paid_at: new Date().toISOString() });
    return rows([{}]);
  }
  if (s.startsWith('update fair_books set publication_fee_paid_at')) {
    const b = S.books.find((x) => x.id === p[0]);
    if (b) {
      b.publication_fee_paid_at = new Date().toISOString();
      if (b.kind === 'physical' || b.content_html != null) b.status = 'published';
    }
    return rows([{}]);
  }
  if (s.startsWith('select buyer_name,buyer_phone,buyer_email')) {
    const o = S.orders.find((x) => x.id === p[0]);
    return o ? rows([{ buyer_name: o.buyer_name, buyer_phone: o.buyer_phone, buyer_email: o.buyer_email, partner_id: o.partner_id }]) : rows([]);
  }
  if (s.startsWith('select max(ends_at) e from fair_subscriptions')) {
    return rows([{ e: null }]);
  }
  if (s.startsWith('insert into fair_subscriptions')) {
    S.subscriptions.push({
      id: 'sub_' + (S.subscriptions.length + 1),
      buyer_name: p[0],
      buyer_phone: p[1],
      buyer_email: p[2],
      plan_id: p[3],
      order_id: p[4],
      status: 'active',
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
      partner_id: p[7],
    });
    return rows([{}]);
  }
  if (
    s.startsWith('select status from fair_orders where token') ||
    s.startsWith('select status, type from fair_orders where token') ||
    s.startsWith('select id, status, type, provider_payment_id, sandbox, amount_minor, currency from fair_orders where token')
  ) {
    return rows(
      S.orders
        .filter((o) => o.token === p[0])
        .map((o) => ({
          id: o.id,
          status: o.status,
          type: o.type || 'book',
          provider_payment_id: o.provider_payment_id,
          sandbox: Boolean(o.sandbox),
          amount_minor: o.amount_minor,
          currency: o.currency || 'MZN',
        })),
    );
  }
  if (s.startsWith('select o.buyer_name, o.buyer_phone, b.title')) {
    return rows(
      S.orders
        .filter((o) => o.token === p[0] && o.status === 'paid' && (!o.type || o.type !== 'physical'))
        .map((o) => {
          const bk = S.books.find((b) => b.id === o.book_id);
          return bk
            ? {
                buyer_name: o.buyer_name,
                buyer_phone: o.buyer_phone,
                title: bk.title,
                content_html: bk.content_html,
                kind: bk.kind || 'ebook',
              }
            : null;
        })
        .filter(Boolean),
    );
  }
  throw new Error('SQL não previsto no teste: ' + s.slice(0, 80));
}

export class Pool {
  query(s, p) {
    return q(s, p);
  }
  async connect() {
    return { query: q, release() {} };
  }
}
export default { Pool };
