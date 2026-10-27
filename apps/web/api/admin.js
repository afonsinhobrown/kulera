import { timingSafeEqual } from 'node:crypto';
import { pool } from '../lib/db.js';

const sameKey = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const csvCell = (v) => { const s = v == null ? '' : String(v instanceof Date ? v.toISOString() : v); return /^[=+\-@]/.test(s) ? `"'${s.replace(/"/g, '""')}"` : `"${s.replace(/"/g, '""')}"`; };
const toCsv = (rows) => rows.length ? [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(csvCell).join(','))].join('\n') : '';
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const uuid = (v) => /^[0-9a-f-]{36}$/.test(String(v));

async function action(b) {
  switch (b.action) {
    case 'lead_status': {
      if (!['new', 'contacted', 'signed', 'declined'].includes(b.status) || !uuid(b.id)) return [400, { error: 'invalid' }];
      await pool.query('update partner_leads set status = $2 where id = $1', [b.id, b.status]);
      return [200, { ok: true }];
    }
    case 'save_partner': {
      const name = clip(b.name, 120), kind = b.kind === 'author' ? 'author' : 'publisher';
      const bps = Number(b.commissionBps);
      if (name.length < 2 || !Number.isInteger(bps) || bps < 0 || bps > 10000) return [400, { error: 'invalid' }];
      const args = [name, kind, clip(b.phone, 30) || null, clip(b.email, 120) || null, bps, b.status === 'suspended' ? 'suspended' : 'active'];
      if (uuid(b.id)) { await pool.query('update fair_partners set name=$2,kind=$3,phone=$4,email=$5,commission_bps=$6,status=$7 where id=$1', [b.id, ...args]); return [200, { ok: true, id: b.id }]; }
      const r = await pool.query('insert into fair_partners (name,kind,phone,email,commission_bps,status) values ($1,$2,$3,$4,$5,$6) returning id', args);
      return [200, { ok: true, id: r.rows[0].id }];
    }
    case 'save_book': {
      const title = clip(b.title, 200), author = clip(b.author, 200), price = Number(b.priceMinor);
      if (title.length < 1 || author.length < 1 || !Number.isInteger(price) || price <= 0 || price > 100_000_000) return [400, { error: 'invalid' }];
      const status = ['draft', 'published', 'suspended'].includes(b.status) ? b.status : 'draft';
      const content = typeof b.contentHtml === 'string' && b.contentHtml.trim() ? b.contentHtml : null;
      if (content && content.length > 3_500_000) return [413, { error: 'content_too_large' }];
      const args = [title, author, clip(b.description, 2000) || null, clip(b.language, 10) || 'pt', price, uuid(b.partnerId) ? b.partnerId : null, status, clip(b.coverUrl, 500) || null, content];
      let id = b.id;
      if (uuid(id)) await pool.query('update fair_books set title=$2,author=$3,description=$4,language=$5,price_minor=$6,partner_id=$7,status=$8,cover_url=$9,content_html=coalesce($10,content_html),updated_at=now() where id=$1', [id, ...args]);
      else id = (await pool.query('insert into fair_books (title,author,description,language,price_minor,partner_id,status,cover_url,content_html) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id', args)).rows[0].id;
      // Nunca fica publicado um livro sem conteúdo.
      const rev = await pool.query("update fair_books set status='draft' where id=$1 and status='published' and content_html is null", [id]);
      return [200, { ok: true, id, warning: rev.rowCount ? 'sem_conteudo_ficou_rascunho' : undefined }];
    }
    default: return [400, { error: 'invalid_action' }];
  }
}

// Painel da Kulera. Protegido por ADMIN_KEY.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || !key || !sameKey(key, process.env.ADMIN_KEY)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method === 'POST') { const [status, body] = await action(req.body ?? {}); return res.status(status).json(body); }

  const totals = (await pool.query(
    `select count(*) filter (where status='paid')::int as paid, coalesce(sum(amount_minor) filter (where status='paid'),0)::bigint as paid_minor,
            count(*) filter (where status in ('created','pending'))::int as open_orders from fair_orders`)).rows[0];
  const split = (await pool.query('select coalesce(sum(commission_minor),0)::bigint c, coalesce(sum(partner_minor),0)::bigint p from fair_sales')).rows[0];
  const leads = (await pool.query('select id, created_at, name, organisation, kind, phone, email, titles_count, message, status from partner_leads order by created_at desc limit 500')).rows;
  const orders = (await pool.query(`select o.created_at, o.paid_at, o.buyer_name, o.buyer_phone, o.buyer_email, b.title as book, o.amount_minor, o.currency, o.status
      from fair_orders o left join fair_books b on b.id = o.book_id order by o.created_at desc limit 500`)).rows;
  const books = (await pool.query(`select id, title, author, description, language, price_minor, currency, partner_id, status, cover_url, content_html is not null as has_content from fair_books order by created_at desc`)).rows;
  const partners = (await pool.query('select id, name, kind, phone, email, commission_bps, status from fair_partners order by created_at desc')).rows;
  const payouts = (await pool.query(`select p.name, count(*)::int as sales, sum(s.gross_minor)::bigint as gross, sum(s.partner_minor)::bigint as owed
      from fair_sales s join fair_partners p on p.id = s.partner_id group by p.name order by owed desc`)).rows;

  if (req.query?.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send(toCsv(req.query.type === 'orders' ? orders : req.query.type === 'payouts' ? payouts : leads));
  }
  res.json({ totals: { ...totals, paid_minor: Number(totals.paid_minor), kulera_minor: Number(split.c), partners_minor: Number(split.p) },
    leads, orders, books: books.map((x) => ({ ...x, price_minor: Number(x.price_minor) })), partners, payouts: payouts.map((x) => ({ ...x, gross: Number(x.gross), owed: Number(x.owed) })) });
}
