import { timingSafeEqual } from 'node:crypto';
import { pool } from '../lib/db.js';
import { PUBLICATION_FEE_MINOR } from '../lib/pricing.js';

const sameKey = (a, b) => {
  const ax = String(a ?? '').trim();
  const bx = String(b ?? '').trim();
  const x = Buffer.from(ax);
  const y = Buffer.from(bx);
  if (x.length !== y.length) return false;
  try {
    return timingSafeEqual(x, y);
  } catch {
    return false;
  }
};
const csvCell = (v) => { const s = v == null ? '' : String(v instanceof Date ? v.toISOString() : v); return /^[=+\-@]/.test(s) ? `"'${s.replace(/"/g, '""')}"` : `"${s.replace(/"/g, '""')}"`; };
const toCsv = (rows) => rows.length ? [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(csvCell).join(','))].join('\n') : '';
const clip = (v, n) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, n);
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
      if (name.length < 2) return [400, { error: 'invalid' }];
      const args = [name, kind, clip(b.phone, 30) || null, clip(b.email, 120) || null, b.status === 'suspended' ? 'suspended' : 'active'];
      if (uuid(b.id)) { await pool.query('update fair_partners set name=$2,kind=$3,phone=$4,email=$5,status=$6 where id=$1', [b.id, ...args]); return [200, { ok: true, id: b.id }]; }
      const r = await pool.query('insert into fair_partners (name,kind,phone,email,status) values ($1,$2,$3,$4,$5) returning id', args);
      return [200, { ok: true, id: r.rows[0].id }];
    }
    case 'save_book': {
      const title = clip(b.title, 200), author = clip(b.author, 200), price = Number(b.priceMinor);
      if (title.length < 1 || author.length < 1 || !Number.isInteger(price) || price <= 0 || price > 100_000_000) return [400, { error: 'invalid' }];
      const status = ['draft', 'published', 'suspended'].includes(b.status) ? b.status : 'draft';
      const content = typeof b.contentHtml === 'string' && b.contentHtml.trim() ? b.contentHtml.replace(/\u0000/g, '') : null;
      if (content && content.length > 3_500_000) return [413, { error: 'content_too_large' }];
      const kind = b.kind === 'physical' ? 'physical' : 'ebook';
      const stock = kind === 'physical' && b.stock !== '' && b.stock != null && !isNaN(Number(b.stock)) ? Number(b.stock) : (kind === 'physical' ? 0 : null);
      const requiresShipping = kind === 'physical';
      const args = [title, author, clip(b.description, 2000) || null, clip(b.language, 10) || 'pt', price, uuid(b.partnerId) ? b.partnerId : null, status, clip(b.coverUrl, 800000) || null, content, kind, stock, requiresShipping];
      let id = b.id;
      if (uuid(id)) {
        try {
          await pool.query('update fair_books set title=$2,author=$3,description=$4,language=$5,price_minor=$6,partner_id=$7,status=$8,cover_url=$9,content_html=coalesce($10,content_html),kind=$11,stock=$12,requires_shipping=$13,updated_at=now() where id=$1', [id, ...args]);
        } catch {
          await pool.query('update fair_books set title=$2,author=$3,description=$4,language=$5,price_minor=$6,partner_id=$7,status=$8,cover_url=$9,content_html=coalesce($10,content_html),updated_at=now() where id=$1', [id, title, author, clip(b.description, 2000) || null, clip(b.language, 10) || 'pt', price, uuid(b.partnerId) ? b.partnerId : null, status, clip(b.coverUrl, 800000) || null, content]);
        }
      }
      else {
        try {
          id = (await pool.query('insert into fair_books (title,author,description,language,price_minor,partner_id,status,cover_url,content_html,kind,stock,requires_shipping) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id', args)).rows[0].id;
        } catch {
          id = (await pool.query('insert into fair_books (title,author,description,language,price_minor,partner_id,status,cover_url,content_html) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id', [title, author, clip(b.description, 2000) || null, clip(b.language, 10) || 'pt', price, uuid(b.partnerId) ? b.partnerId : null, status, clip(b.coverUrl, 800000) || null, content])).rows[0].id;
        }
      }
      // Livros de parceiros externos pagam a taxa de publicação (500 MT); livros da Kulera não.
      await pool.query('update fair_books set publication_fee_minor = case when partner_id is null then 0 else greatest(publication_fee_minor, $2) end where id=$1', [id, PUBLICATION_FEE_MINOR]);
      // Nunca fica publicado um livro sem conteúdo.
      const revContent = await pool.query("update fair_books set status='draft' where id=$1 and status='published' and (kind is distinct from 'physical') and content_html is null", [id]);
      // Nem um livro de parceiro sem a taxa de publicação paga.
      const revFee = await pool.query("update fair_books set status='draft' where id=$1 and status='published' and partner_id is not null and publication_fee_paid_at is null", [id]);
      const warning = revContent.rowCount ? 'sem_conteudo_ficou_rascunho' : (revFee.rowCount ? 'taxa_publicacao_pendente' : undefined);
      return [200, { ok: true, id, warning }];
    }
    case 'delete_book': {
      if (!uuid(b.id)) return [400, { error: 'invalid' }];
      try {
        await pool.query('delete from fair_sales where book_id = $1', [b.id]);
      } catch {}
      try {
        await pool.query('update fair_orders set book_id = null where book_id = $1', [b.id]);
      } catch {}
      const r = await pool.query('delete from fair_books where id = $1 returning id', [b.id]);
      if (r.rowCount === 0) return [404, { error: 'not_found' }];
      return [200, { ok: true }];
    }
    case 'approve_submission': {
      if (!uuid(b.submissionId)) return [400, { error: 'invalid' }];
      const s = await pool.query('select * from fair_submissions where id=$1', [b.submissionId]);
      const sub = s.rows[0];
      if (!sub) return [404, { error: 'not_found' }];
      const title = clip(sub.title, 200), author = clip(sub.author, 200);
      const price = Number(b.priceMinor);
      if (title.length < 1 || author.length < 1 || !Number.isInteger(price) || price <= 0 || price > 100_000_000) return [400, { error: 'invalid' }];
      const pid = uuid(sub.partner_id) ? sub.partner_id : null;
      // Livro de parceiro externo só publica depois de pagar a taxa de publicação no portal.
      const status = pid ? 'draft' : (b.status === 'published' ? 'published' : 'draft');
      const fee = pid ? PUBLICATION_FEE_MINOR : 0;
      const r = await pool.query('insert into fair_books (title,author,description,language,price_minor,partner_id,status,cover_url,content_html,publication_fee_minor) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id',
        [title, author, clip(sub.description,2000)||null, clip(sub.language,10)||'pt', price, pid, status, clip(sub.cover_url,500)||null, sub.content_html||null, fee]);
      await pool.query("update fair_submissions set status='approved', reviewed_at=now(), admin_notes=$2 where id=$1", [b.submissionId, clip(b.adminNotes,500)||null]);
      return [200, { ok: true, bookId: r.rows[0].id, warning: pid ? 'taxa_publicacao_pendente' : undefined }];
    }
    case 'reject_submission': {
      if (!uuid(b.submissionId)) return [400, { error: 'invalid' }];
      await pool.query("update fair_submissions set status=$2, reviewed_at=now(), admin_notes=$3 where id=$1", [b.submissionId, b.status==='changes_requested'?'changes_requested':(b.status==='rejected'?'rejected':'rejected'), clip(b.adminNotes,500)||null]);
      return [200, { ok: true }];
    }
    case 'save_plan': {
      const code = clip(b.code,40), name = clip(b.name,80), price = Number(b.priceMinor);
      if (code.length<2||name.length<2||!Number.isInteger(price)||price<0) return [400,{error:'invalid'}];
      const iv = b.interval==='year'?'year':'month';
      const st = b.status==='archived'?'archived':'active';
      if (uuid(b.id)) { await pool.query('update fair_plans set code=$2,name=$3,description=$4,price_minor=$5,currency=$6,interval=$7,status=$8 where id=$1',[b.id,code,name,clip(b.description,200)||null,clip(b.currency,3)||'MZN',price,iv,st]); return [200,{ok:true,id:b.id}]; }
      const r = await pool.query('insert into fair_plans (code,name,description,price_minor,currency,interval,status) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id',[code,name,clip(b.description,200)||null,clip(b.currency,3)||'MZN',price,iv,st]);
      return [200,{ok:true,id:r.rows[0].id}];
    }
    default: return [400, { error: 'invalid_action' }];
  }
}

// Painel da Kulera. Protegido por ADMIN_KEY.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.ADMIN_KEY || !sameKey(req.headers['x-admin-key'], process.env.ADMIN_KEY)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (req.method === 'POST') { const [status, body] = await action(req.body ?? {}); return res.status(status).json(body); }

  const totals = (await pool.query(
    `select count(*) filter (where status='paid')::int as paid, coalesce(sum(amount_minor) filter (where status='paid'),0)::bigint as paid_minor,
            count(*) filter (where status in ('created','pending'))::int as open_orders from fair_orders`)).rows[0];
  const split = (await pool.query(`select
      coalesce(sum(coalesce(app_minor, commission_minor)),0)::bigint a,
      coalesce(sum(coalesce(editors_minor,0)),0)::bigint e,
      coalesce(sum(partner_minor),0)::bigint p from fair_sales`)).rows[0];
  let publicationFees = { f: 0 };
  try { publicationFees = (await pool.query('select coalesce(sum(amount_minor),0)::bigint f from fair_publication_fees where paid_at is not null')).rows[0]; } catch {}
  const leads = (await pool.query('select id, created_at, name, organisation, kind, phone, email, titles_count, message, status from partner_leads order by created_at desc limit 500')).rows;
  let orders;
  try {
    orders = (await pool.query(`select o.created_at, o.paid_at, o.buyer_name, o.buyer_phone, o.buyer_email, b.title as book, o.amount_minor, o.currency, o.status, coalesce(o.type,'book') as type
        from fair_orders o left join fair_books b on b.id = o.book_id order by o.created_at desc limit 500`)).rows;
  } catch {
    orders = (await pool.query(`select o.created_at, o.paid_at, o.buyer_name, o.buyer_phone, o.buyer_email, b.title as book, o.amount_minor, o.currency, o.status
        from fair_orders o left join fair_books b on b.id = o.book_id order by o.created_at desc limit 500`)).rows.map(x=>({...x,type:'book'}));
  }
  let books;
  try {
    books = (await pool.query(`select id, title, author, description, language, price_minor, currency, partner_id, status, cover_url, content_html is not null as has_content, kind, stock, publication_fee_minor, publication_fee_paid_at from fair_books order by created_at desc`)).rows;
  } catch {
    books = (await pool.query(`select id, title, author, description, language, price_minor, currency, partner_id, status, cover_url, content_html is not null as has_content from fair_books order by created_at desc`)).rows.map(x=>({...x,kind:'ebook',publication_fee_minor:0,publication_fee_paid_at:null}));
  }
  const partners = (await pool.query('select id, name, kind, phone, email, commission_bps, status from fair_partners order by created_at desc')).rows;
  const payouts = (await pool.query(`select p.name, count(*)::int as sales, sum(s.gross_minor)::bigint as gross, sum(s.partner_minor)::bigint as owed
      from fair_sales s join fair_partners p on p.id = s.partner_id group by p.name order by owed desc`)).rows;
  let submissions = [];
  try { submissions = (await pool.query(`select s.id, s.title, s.author, s.status, s.admin_notes, s.created_at, p.name as partner from fair_submissions s left join fair_partners p on p.id=s.partner_id order by s.created_at desc limit 500`)).rows; } catch {}
  let plans = [];
  try { plans = (await pool.query('select id,code,name,description,price_minor,currency,interval,status from fair_plans order by created_at asc')).rows; } catch {}
  let subs = [];
  try { subs = (await pool.query(`select s.id,s.buyer_name,s.buyer_phone,s.status,s.starts_at,s.ends_at,pl.name as plan from fair_subscriptions s left join fair_plans pl on pl.id=s.plan_id order by s.created_at desc limit 500`)).rows; } catch {}

  if (req.query?.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send(toCsv(req.query.type === 'orders' ? orders : req.query.type === 'payouts' ? payouts : leads));
  }
  res.json({ totals: { ...totals, paid_minor: Number(totals.paid_minor), app_minor: Number(split.a), editors_minor: Number(split.e),
      kulera_minor: Number(split.a) + Number(split.e), partners_minor: Number(split.p), fees_minor: Number(publicationFees.f) },
    leads, orders, books: books.map((x) => ({ ...x, price_minor: Number(x.price_minor), publication_fee_minor: Number(x.publication_fee_minor || 0) })), partners, payouts: payouts.map((x) => ({ ...x, gross: Number(x.gross), owed: Number(x.owed) })),
    submissions, plans: plans.map((x)=>({...x,price_minor:Number(x.price_minor)})), subscriptions: subs });
  } catch (e) {
    console.error('admin.error', e?.message || String(e));
    return res.status(500).json({ error: 'internal_error' });
  }
}
