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
  recoveryAttempts: [],
  deviceRequests: [],
  settings: {},
  adminUsers: [],
  adminSessions: [],
  adminBank: [],
  adminBankChanges: [],
  adminAttempts: [],
  authors: [],
  bookAuthors: [],
  ledger: [],
  balances: [],
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
  if (/^(create table|alter table|create unique index|create index|do \$\$)/i.test(s)) return rows([]);
  // ===== Financeiro: autores, livro↔autor, razão e saldos =====
  if (/^insert into fair_authors/i.test(s)) {
    const id = '00000000-0000-4000-8000-00000000e2' + String(S.authors.length + 1).padStart(2, '0');
    S.authors.push({ id, full_name: p[0], pen_name: p[1], nuit: p[2], bi_number: p[3], class: p[4], is_related: p[7] === true, owner_partner_id: p[5] });
    return rows([{ id }]);
  }
  if (/^select id, nuit from fair_authors where nuit/i.test(s)) {
    return rows(S.authors.filter((a) => a.nuit === p[0]).map((a) => ({ id: a.id, nuit: a.nuit })));
  }
  if (/^select is_related from fair_authors where id/i.test(s)) {
    return rows(S.authors.filter((a) => a.id === p[0]).map((a) => ({ is_related: Boolean(a.is_related) })));
  }
  if (/^insert into fair_book_authors/i.test(s)) {
    const i = S.bookAuthors.findIndex((x) => x.book_id === p[0] && x.author_id === p[1]);
    const row = { book_id: p[0], author_id: p[1], role: p[2], share_bps: p[3], amount_minor: p[4] };
    if (i >= 0) S.bookAuthors[i] = row;
    else S.bookAuthors.push(row);
    return rows([]);
  }
  if (/^select ba\.author_id, ba\.share_bps/i.test(s)) {
    return rows(
      S.bookAuthors
        .filter((x) => x.book_id === p[0])
        .map((x) => {
          const a = S.authors.find((y) => y.id === x.author_id) || {};
          return { author_id: x.author_id, share_bps: x.share_bps, amount_minor: x.amount_minor, is_related: Boolean(a.is_related) };
        }),
    );
  }
  if (/^insert into fair_ledger/i.test(s)) {
    if (S.ledger.find((x) => x.entry_key === p[0])) return rows([]);
    const gateway = s.includes("'gateway_fee'");
    S.ledger.push(
      gateway
        ? { entry_key: p[0], kind: 'gateway_fee', entity: 'gateway', entity_id: null, order_id: p[1], book_id: p[2], amount: Number(p[3]) }
        : { entry_key: p[0], kind: 'sale', entity: p[1], entity_id: p[2], order_id: p[3], book_id: p[4], amount: Number(p[5]) },
    );
    return s.includes('returning id') ? rows([{ id: S.ledger.length }]) : rows([]);
  }
  if (/^insert into fair_balances/i.test(s)) {
    const [entity, entityId, currency, amount] = p;
    const found = S.balances.find((b) => b.entity === entity && b.entity_id === entityId && b.currency === currency);
    if (found) found.accrued += Number(amount);
    else S.balances.push({ entity, entity_id: entityId, currency, accrued: Number(amount), paid: 0 });
    return rows([]);
  }
  if (/^insert into fair_settings/i.test(s)) {
    if (s.includes("'sandbox'")) S.settings.sandbox = p[0];
    else if (s.includes("'admin_key'") && p.length) S.settings.admin_key = p[0];
    return rows([]);
  }
  if (/^select value from fair_settings where key='sandbox'/i.test(s)) {
    return S.settings.sandbox !== undefined ? rows([{ value: S.settings.sandbox }]) : rows([]);
  }
  if (/^select value from fair_settings where key='admin_key'/i.test(s)) {
    // Sem valor na BD = chave não configurada (o código já não inventa uma).
    return S.settings.admin_key !== undefined ? rows([{ value: S.settings.admin_key }]) : rows([]);
  }
  if (/^select value from fair_settings where key='paysuite_token'/i.test(s)) {
    return S.settings.paysuite_token ? rows([{ value: S.settings.paysuite_token }]) : rows([]);
  }
  // ===== Administradores (fair_admin_users / fair_admin_sessions) =====
  if (/^insert into fair_admin_users/i.test(s)) {
    S.adminUsers.push({
      id: '00000000-0000-4000-8000-0000000000a' + (S.adminUsers.length + 1),
      username: p[0],
      password_hash: p[1],
      role: p[2],
      display_name: p[3],
      can_change_password: p[4] !== false,
      status: 'active',
      last_login_at: null,
    });
    return rows([]);
  }
  if (/^update fair_admin_users set password_hash = \$2, role/i.test(s)) {
    const u = S.adminUsers.find((x) => x.username === p[0]);
    if (u) Object.assign(u, { password_hash: p[1], role: p[2], display_name: p[3], can_change_password: p[4] !== false, status: 'active' });
    return rows([]);
  }
  if (/^select id, username, password_hash.*from fair_admin_users where username/i.test(s)) {
    return rows(S.adminUsers.filter((x) => x.username === p[0]));
  }
  if (/^select count\(\*\)::int as n from fair_admin_users/i.test(s)) return rows([{ n: S.adminUsers.length }]);
  if (/^update fair_admin_users set last_login_at/i.test(s)) return rows([]);
  if (/^update fair_admin_users set password_hash = \$2 where id/i.test(s)) {
    const u = S.adminUsers.find((x) => x.id === p[0]);
    if (u) u.password_hash = p[1];
    return rows([]);
  }
  if (/^insert into fair_admin_sessions/i.test(s)) {
    S.adminSessions.push({ token_hash: p[0], user_id: p[1], expires_at: p[2] });
    return rows([]);
  }
  if (/^select s\.token_hash, u\.id/i.test(s)) {
    const sess = S.adminSessions.find((x) => x.token_hash === p[0] && new Date(x.expires_at) > new Date());
    if (!sess) return rows([]);
    const u = S.adminUsers.find((x) => x.id === sess.user_id);
    return rows(u ? [{ ...u, token_hash: sess.token_hash }] : []);
  }
  if (/^delete from fair_admin_sessions where token_hash/i.test(s)) {
    const i = S.adminSessions.findIndex((x) => x.token_hash === p[0]);
    if (i >= 0) S.adminSessions.splice(i, 1);
    return rows([]);
  }
  if (/^delete from fair_admin_sessions where user_id/i.test(s)) {
    for (let i = S.adminSessions.length - 1; i >= 0; i -= 1) {
      if (S.adminSessions[i].user_id === p[0] && S.adminSessions[i].token_hash !== p[1]) S.adminSessions.splice(i, 1);
    }
    return rows([]);
  }
  if (/^insert into fair_admin_login_attempts/i.test(s)) {
    S.adminAttempts.push({ username: p[0], ip_hash: p[1], ok: p[2] === true, created_at: new Date() });
    return rows([]);
  }
  if (/^select count\(\*\)::int as n from fair_admin_login_attempts/i.test(s)) {
    const n = S.adminAttempts.filter((a) => !a.ok && a.username === p[0] && a.ip_hash === p[1] && a.created_at > p[2]).length;
    return rows([{ n }]);
  }
  if (/^select holder, bank_name/i.test(s)) {
    return rows(S.adminBank.filter((b) => b.user_id === p[0]));
  }
  if (/^insert into fair_admin_bank_changes/i.test(s)) {
    S.adminBankChanges.push({ user_id: p[0], before: p[1], after: p[2], ip_hash: p[3] });
    return rows([]);
  }
  if (/^insert into fair_admin_bank/i.test(s)) {
    const i = S.adminBank.findIndex((b) => b.user_id === p[0]);
    const row = { user_id: p[0], holder: p[1], bank_name: p[2], account_number: p[3], nib: p[4], wallet: p[5] };
    if (i >= 0) S.adminBank[i] = row;
    else S.adminBank.push(row);
    return rows([]);
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
  if (/^update fair_plans set name=\$2/i.test(s)) {
    const [code, name, description, price_minor, max_publications, showcase_priority, legacy] = p;
    const plan = S.plans.find((x) => x.code === code);
    if (plan && Array.isArray(legacy) && legacy.map(Number).includes(Number(plan.price_minor))) {
      plan.name = name;
      plan.description = description;
      plan.price_minor = price_minor;
      plan.max_publications = max_publications;
      plan.showcase_priority = showcase_priority;
    }
    return rows([]);
  }
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
  if (s.startsWith('select cover_url from fair_books where id = $1 and status = $2')) {
    return rows(S.books.filter((b) => b.id === p[0] && b.status === p[1]).map((b) => ({ cover_url: b.cover_url ?? null })));
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
  if (s.startsWith('update fair_books set stock = coalesce(stock, 0) + 1')) {
    const o = S.orders.find((x) => x.id === p[0]);
    const b = S.books.find((x) => x.id === o?.book_id);
    if (b && (o?.type === 'physical') && b.stock != null) b.stock++;
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
    if (o && (o.status === 'created' || o.status === 'pending')) { o.status = 'failed'; return rows([{}]); }
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
    if (o && (o.status === 'created' || o.status === 'pending')) { o.status = p[1]; return rows([{}]); }
    return rows([]);
  }
  if (s.startsWith("select id, provider_payment_id from fair_orders where status in ('created','pending')")) {
    return rows(
      S.orders
        .filter((o) => (o.status === 'created' || o.status === 'pending') && o.provider_payment_id && !String(o.provider_payment_id).startsWith('sim_'))
        .map((o) => ({ id: o.id, provider_payment_id: o.provider_payment_id })),
    );
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
      gateway: p[12],
      author: p[14],
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
  if (/^select s\.id as subscription_id, s\.starts_at, s\.ends_at/i.test(s)) {
    return rows([]);
  }
  if (/^select id, ends_at from fair_subscriptions/i.test(s)) {
    return rows(S.subscriptions.filter((x) => x.partner_id === p[0] && x.status === 'active'));
  }
  if (/^select p\.max_publications/i.test(s)) {
    return rows([]);
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
      partner_id: p[6],
      grace_ends_at: null,
      last_payment_failed_at: null,
    });
    return rows([{}]);
  }
  if (/^update fair_subscriptions set status = 'active', grace_ends_at = null/i.test(s)) {
    const sub = S.subscriptions.find((x) => x.id === p[0]);
    if (sub) {
      sub.status = 'active';
      sub.grace_ends_at = null;
      sub.last_payment_failed_at = null;
      sub.warning_72h_sent_at = null;
      sub.warning_24h_sent_at = null;
      sub.ends_at = new Date(Date.now() + Number(p[2] || 30) * 86400000).toISOString();
    }
    return rows(sub ? [{ id: sub.id, status: sub.status, ends_at: sub.ends_at, partner_id: sub.partner_id }] : []);
  }
  if (s.startsWith('insert into fair_partner_credits')) {
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
  if (s.startsWith('select count(*)::int as n from fair_recovery_attempts')) {
    const now = Date.now();
    return rows([
      {
        n: S.recoveryAttempts.filter(
          (a) => !a.ok && now - new Date(a.created_at).getTime() < 15 * 60 * 1000 && (a.phone_hash === p[1] || a.ip_hash === p[2]),
        ).length,
      },
    ]);
  }
  if (s.startsWith('insert into fair_recovery_attempts')) {
    S.recoveryAttempts.push({ phone_hash: p[0], ip_hash: p[1], ok: p[2] === true, created_at: new Date().toISOString() });
    return rows([{}]);
  }
  if (s.startsWith('select o.token, o.buyer_name, o.paid_at')) {
    return rows(
      S.orders
        .filter((o) => o.buyer_phone === p[0] && o.status === 'paid' && (!o.type || o.type === 'book'))
        .map((o) => {
          const bk = S.books.find((b) => b.id === o.book_id);
          return {
            token: o.token,
            buyer_name: o.buyer_name,
            paid_at: o.paid_at ?? null,
            created_at: o.created_at ?? null,
            sandbox: Boolean(o.sandbox),
            title: bk?.title || 'Livro',
          };
        }),
    );
  }
  if (s.startsWith('select id, status, type, sandbox, device_key_hash from fair_orders where token=$1')) {
    return rows(
      S.orders
        .filter((o) => o.token === p[0])
        .map((o) => ({
          id: o.id,
          status: o.status,
          type: o.type || 'book',
          sandbox: Boolean(o.sandbox),
          device_key_hash: o.device_key_hash ?? null,
        })),
    );
  }
  if (s.startsWith('select o.id as order_id, o.buyer_name, o.buyer_phone, o.type, o.sandbox, o.device_key_hash')) {
    return rows(
      S.orders
        .filter((o) => o.token === p[0] && o.status === 'paid' && o.type !== 'physical')
        .map((o) => {
          const bk = S.books.find((b) => b.id === o.book_id);
          return bk
            ? {
                order_id: o.id,
                buyer_name: o.buyer_name,
                buyer_phone: o.buyer_phone,
                type: o.type || 'book',
                sandbox: Boolean(o.sandbox),
                device_key_hash: o.device_key_hash ?? null,
                title: bk.title,
                content_html: bk.content_html,
                kind: bk.kind || 'ebook',
              }
            : null;
        })
        .filter(Boolean),
    );
  }
  if (s.startsWith('update fair_orders set device_key_hash')) {
    const o = S.orders.find((x) => x.id === p[0]);
    if (!o) return { rows: [], rowCount: 0 };
    const isEmpty = !o.device_key_hash;
    if (s.includes("coalesce(device_key_hash,'')=''") && !isEmpty) return { rows: [], rowCount: 0 };
    o.device_key_hash = p[1];
    o.device_fingerprint_hash = p[2] ?? null;
    o.device_bound_at = new Date().toISOString();
    return rows([{ id: o.id }]);
  }
  if (s.startsWith('select status from fair_device_requests')) {
    return rows(
      S.deviceRequests.filter((r) => r.order_id === p[0] && r.requested_key_hash === p[1] && r.status === 'pending'),
    );
  }
  if (s.startsWith('insert into fair_device_requests')) {
    const req = {
      id: '00000000-0000-4000-8000-000000000d' + String(S.deviceRequests.length + 1).padStart(2, '0'),
      order_id: p[0],
      requested_key_hash: p[1],
      requested_fingerprint_hash: p[2] ?? null,
      device_info: typeof p[3] === 'string' ? JSON.parse(p[3]) : p[3] ?? null,
      status: 'pending',
      created_at: new Date().toISOString(),
      resolved_at: null,
    };
    S.deviceRequests.push(req);
    return rows([{ id: req.id }]);
  }
  if (s.startsWith('select id, order_id, requested_key_hash, requested_fingerprint_hash, status from fair_device_requests')) {
    return rows(S.deviceRequests.filter((r) => r.id === p[0]));
  }
  if (s.startsWith("update fair_device_requests set status='approved'")) {
    const r = S.deviceRequests.find((x) => x.id === p[0] && x.status === 'pending');
    if (r) {
      r.status = 'approved';
      r.resolved_at = new Date().toISOString();
    }
    return { rows: r ? [{ id: r.id }] : [], rowCount: r ? 1 : 0 };
  }
  if (s.startsWith("update fair_device_requests set status='rejected'")) {
    if (s.includes('id<>$2')) {
      let n = 0;
      S.deviceRequests.forEach((r) => {
        if (r.order_id === p[0] && r.id !== p[1] && r.status === 'pending') {
          r.status = 'rejected';
          r.resolved_at = new Date().toISOString();
          n++;
        }
      });
      return { rows: [], rowCount: n };
    }
    const r = S.deviceRequests.find((x) => x.id === p[0] && x.status === 'pending');
    if (r) {
      r.status = 'rejected';
      r.resolved_at = new Date().toISOString();
    }
    return { rows: r ? [{ id: r.id }] : [], rowCount: r ? 1 : 0 };
  }
  if (s.startsWith('select r.id, r.order_id, r.status, r.created_at, r.resolved_at, r.device_info')) {
    return rows(
      S.deviceRequests.map((r) => {
        const o = S.orders.find((x) => x.id === r.order_id);
        const bk = S.books.find((b) => b.id === o?.book_id);
        return {
          ...r,
          buyer_name: o?.buyer_name,
          buyer_phone: o?.buyer_phone,
          buyer_email: o?.buyer_email,
          book: bk?.title || 'Livro',
        };
      }),
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
