import { timingSafeEqual } from 'node:crypto';
import { pool } from '../lib/db.js';
import { ensurePaymentSchema, isSandbox, setSandbox, resolveSiteUrl, settleOrderPaid, restoreReservedStock } from '../lib/payments.js';
import { createPayment, getPaymentStatus, resolvePaysuiteToken } from '../lib/paysuite.js';
import { ensurePlanSchema } from '../lib/plans.js';
import { getPublicationFeeMinor, setSetting } from '../lib/settings.js';
import { grantCredit } from '../lib/reader.js';
import { approveDeviceRequest, rejectDeviceRequest } from '../lib/device.js';
import { announceBook, subscriberCount } from '../lib/marketing.js';
import { emailConfig, emailConfigured, sendEmail } from '../lib/email.js';
import { markSubscriptionPaymentFailed, markSubscriptionPaymentRecovered, runDailyMaintenance } from '../lib/lifecycle.js';
import { CSRF_HEADER, CSRF_VALUE, ensureAdminSchema, requireAdmin } from '../lib/admin-auth.js';
import { ensureFinanceSchema, resolveSaleScenario, setBookAuthor, upsertAuthor } from '../lib/finance.js';
import { splitSale } from '../lib/split.js';

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

async function saveBook(b) {
  const title = clip(b.title, 200), author = clip(b.author, 200);
  const okPrice = (p) => Number.isInteger(p) && p > 0 && p <= 100_000_000;
  const status = ['draft', 'published', 'suspended'].includes(b.status) ? b.status : 'draft';
  const content = typeof b.contentHtml === 'string' && b.contentHtml.trim() ? b.contentHtml.replace(/\u0000/g, '') : null;
  if (content && content.length > 3_500_000) return [413, { error: 'content_too_large' }];
  const hasDigital = b.hasDigital === true || b.hasDigital === 'true' || (b.hasDigital == null && b.kind !== 'physical');
  const hasPhysical = b.hasPhysical === true || b.hasPhysical === 'true' || (b.hasPhysical == null && b.kind === 'physical');
  if (title.length < 1 || author.length < 1) return [400, { error: 'invalid' }];
  if (!hasDigital && !hasPhysical) return [400, { error: 'invalid_format' }];
  const digitalPrice = Number(b.priceMinor), physicalPrice = Number(b.pricePhysicalMinor);
  if (hasDigital && !okPrice(digitalPrice)) return [400, { error: 'invalid_price_digital' }];
  if (hasPhysical && !okPrice(physicalPrice)) return [400, { error: 'invalid_price_physical' }];
  if (hasPhysical && (b.stock === '' || b.stock == null || !Number.isInteger(Number(b.stock)) || Number(b.stock) < 0)) {
    return [400, { error: 'invalid_stock' }];
  }
  // price_minor é NOT NULL: guarda o preço digital, ou o físico se o livro for só físico.
  const price = hasDigital ? digitalPrice : physicalPrice;
  const pricePhysical = hasPhysical ? physicalPrice : null;
  const kind = hasPhysical && !hasDigital ? 'physical' : 'ebook';
  const stock = hasPhysical ? Number(b.stock) : null;
  const requiresShipping = hasPhysical;
  const cover = clip(b.coverUrl, 2_500_000) || null;
  try {
    await pool.query('alter table fair_books add column if not exists kind text not null default \'ebook\'');
    await pool.query('alter table fair_books add column if not exists stock integer');
    await pool.query('alter table fair_books add column if not exists requires_shipping boolean not null default false');
    await pool.query('alter table fair_books add column if not exists has_digital boolean not null default true');
    await pool.query('alter table fair_books add column if not exists has_physical boolean not null default false');
    await pool.query('alter table fair_books add column if not exists price_physical_minor bigint');
    await pool.query('alter table fair_books add column if not exists publication_fee_minor bigint not null default 0');
    await pool.query('alter table fair_books add column if not exists publication_fee_paid_at timestamptz');
  } catch {}
  const args = [title, author, clip(b.description, 2000) || null, clip(b.language, 10) || 'pt', price, uuid(b.partnerId) ? b.partnerId : null, status, cover, content, kind, stock, requiresShipping, hasDigital, hasPhysical];
  let id = uuid(b.id) ? b.id : null;
  if (id) {
    try {
      await pool.query('update fair_books set title=$2,author=$3,description=$4,language=$5,price_minor=$6,partner_id=$7,status=$8,cover_url=$9,content_html=coalesce($10,content_html),kind=$11,stock=$12,requires_shipping=$13,has_digital=$14,has_physical=$15,updated_at=now() where id=$1', [id, ...args]);
    } catch {
      await pool.query('update fair_books set title=$2,author=$3,description=$4,language=$5,price_minor=$6,partner_id=$7,status=$8,cover_url=$9,content_html=coalesce($10,content_html),updated_at=now() where id=$1', [id, title, author, clip(b.description, 2000) || null, clip(b.language, 10) || 'pt', price, uuid(b.partnerId) ? b.partnerId : null, status, cover, content]);
    }
  } else {
    try {
      id = (await pool.query('insert into fair_books (title,author,description,language,price_minor,partner_id,status,cover_url,content_html,kind,stock,requires_shipping,has_digital,has_physical) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id', args)).rows[0].id;
    } catch {
      id = (await pool.query('insert into fair_books (title,author,description,language,price_minor,partner_id,status,cover_url,content_html) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id', [title, author, clip(b.description, 2000) || null, clip(b.language, 10) || 'pt', price, uuid(b.partnerId) ? b.partnerId : null, status, cover, content])).rows[0].id;
    }
  }
  try {
    await pool.query('update fair_books set price_physical_minor=$2 where id=$1', [id, pricePhysical]);
    // Quando o Admin publica directamente no painel, marca a taxa como regularizada para não reverter para rascunho.
    await pool.query(
      `update fair_books set publication_fee_minor = case when partner_id is null then 0 else greatest(coalesce(publication_fee_minor,0), $2) end,
         publication_fee_paid_at = case when $3 = 'published' and partner_id is not null then coalesce(publication_fee_paid_at, now()) else publication_fee_paid_at end
       where id=$1`,
      [id, await getPublicationFeeMinor(pool), status],
    );
  } catch {}
  // Nunca fica publicado um livro que oferece apenas digital sem conteúdo.
  let warning;
  try {
    const revContent = await pool.query("update fair_books set status='draft' where id=$1 and status='published' and coalesce(has_digital,true) and not coalesce(has_physical,false) and content_html is null", [id]);
    if (revContent.rowCount) warning = 'sem_conteudo_ficou_rascunho';
  } catch {}

  // Livro à venda só com autor registado. A conta do autor é opcional; o registo não é.
  try {
    const autor = await pool.query('select 1 from fair_book_authors where book_id = $1 limit 1', [id]);
    if (autor.rows.length === 0) {
      const voltou = await pool.query("update fair_books set status='draft' where id=$1 and status='published'", [id]);
      if (voltou.rowCount) warning = 'sem_autor_ficou_rascunho';
    }
  } catch {}
  return [200, { ok: true, id, warning }];
}

async function action(b, req) {
  switch (b.action) {
    case 'lead_status': {
      if (!['new', 'contacted', 'signed', 'declined'].includes(b.status) || !uuid(b.id)) return [400, { error: 'invalid' }];
      await pool.query('update partner_leads set status = $2 where id = $1', [b.id, b.status]);
      return [200, { ok: true }];
    }
    case 'save_partner': {
      const name = clip(b.name, 120), kind = b.kind === 'author' ? 'author' : 'publisher';
      if (name.length < 2) return [400, { error: 'invalid' }];
      const commission = Number(b.commissionBps);
      const bps = b.commissionBps != null && b.commissionBps !== '' && Number.isInteger(commission) && commission >= 0 && commission <= 10000 ? commission : null;
      const args = [name, kind, clip(b.phone, 30) || null, clip(b.email, 120) || null, b.status === 'suspended' ? 'suspended' : 'active'];
      if (uuid(b.id)) {
        if (bps == null) await pool.query('update fair_partners set name=$2,kind=$3,phone=$4,email=$5,status=$6 where id=$1', [b.id, ...args]);
        else await pool.query('update fair_partners set name=$2,kind=$3,phone=$4,email=$5,status=$6,commission_bps=$7 where id=$1', [b.id, ...args, bps]);
        return [200, { ok: true, id: b.id }];
      }
      const r = bps == null
        ? await pool.query('insert into fair_partners (name,kind,phone,email,status) values ($1,$2,$3,$4,$5) returning id', args)
        : await pool.query('insert into fair_partners (name,kind,phone,email,status,commission_bps) values ($1,$2,$3,$4,$5,$6) returning id', [...args, bps]);
      return [200, { ok: true, id: r.rows[0].id }];
    }
    case 'save_book': {
      try {
        return await saveBook(b);
      } catch (e) {
        console.error('admin.save_book.error', e?.message || String(e));
        return [500, { error: 'save_failed' }];
      }
    }
    case 'save_author': {
      try {
        await ensureFinanceSchema(pool);
        const out = await upsertAuthor(pool, {
          fullName: clip(b.name, 120),
          nuit: b.nuit ? clip(b.nuit, 24) : null,
          biNumber: b.bi ? clip(b.bi, 30) : null,
          class: b.klass === 'foreign' ? 'foreign' : 'national',
          privateToPartner: b.klass === 'foreign',
          allowMissingNuit: b.allowMissingNuit === true,
        });
        return [200, { ok: true, ...out }];
      } catch (e) {
        return [400, { error: 'invalid', detail: String(e?.message || e) }];
      }
    }
    case 'link_book_author': {
      if (!uuid(b.bookId) || !uuid(b.authorId)) return [400, { error: 'invalid' }];
      try {
        await ensureFinanceSchema(pool);
        const out = await setBookAuthor(pool, {
          bookId: b.bookId,
          authorId: b.authorId,
          role: b.role === 'coauthor' ? 'coauthor' : 'author',
          shareBps: b.shareBps,
          amountMinor: b.amountMinor === '' || b.amountMinor == null ? null : Number(b.amountMinor),
        });
        return [200, { ok: true, ...out }];
      } catch (e) {
        return [400, { error: 'invalid', detail: String(e?.message || e) }];
      }
    }
    case 'unlink_book_author': {
      if (!uuid(b.bookId) || !uuid(b.authorId)) return [400, { error: 'invalid' }];
      await pool.query('delete from fair_book_authors where book_id = $1 and author_id = $2', [b.bookId, b.authorId]);
      return [200, { ok: true }];
    }
    // Quanto fica para cada um, antes de gravar o livro (o painel mostra isto à editora).
    case 'book_earnings': {
      const gross = Math.round(Number(b.priceMinor) || 0);
      if (!(gross > 0)) return [200, { ok: false }];
      const publisherId = uuid(b.partnerId) ? b.partnerId : null;
      const resolved = uuid(b.bookId)
        ? await resolveSaleScenario(pool, { bookId: b.bookId, publisherId })
        : { scenario: publisherId ? 'C' : 'A', authorShareBps: 0, authorAmountMinor: null };
      const split = splitSale({
        grossMinor: gross,
        scenario: resolved.scenario,
        authorShareBps: resolved.authorShareBps,
        authorAmountMinor: resolved.authorAmountMinor,
      });
      return [200, {
        ok: true,
        scenario: split.scenario,
        publisher: split.publisher,
        author: split.author,
        tech: split.techNet,
        kulera: split.kulera,
        gateway: split.gateway,
        golden: split.golden,
      }];
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
      const fee = pid ? await getPublicationFeeMinor(pool) : 0;
      const r = await pool.query('insert into fair_books (title,author,description,language,price_minor,partner_id,status,cover_url,content_html,publication_fee_minor) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id',
        [title, author, clip(sub.description,2000)||null, clip(sub.language,10)||'pt', price, pid, status, clip(sub.cover_url, 2_500_000)||null, sub.content_html||null, fee]);
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
      const maxPub = b.maxPublications !== '' && b.maxPublications != null && !isNaN(Number(b.maxPublications)) ? Number(b.maxPublications) : null;
      const prio = !isNaN(Number(b.showcasePriority)) ? Number(b.showcasePriority) : 0;
      await ensurePlanSchema();
      if (uuid(b.id)) {
        await pool.query('update fair_plans set code=$2,name=$3,description=$4,price_minor=$5,currency=$6,interval=$7,status=$8,max_publications=$9,showcase_priority=$10 where id=$1',
          [b.id,code,name,clip(b.description,200)||null,clip(b.currency,3)||'MZN',price,iv,st,maxPub,prio]);
        return [200,{ok:true,id:b.id}];
      }
      const r = await pool.query('insert into fair_plans (code,name,description,price_minor,currency,interval,status,max_publications,showcase_priority) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
        [code,name,clip(b.description,200)||null,clip(b.currency,3)||'MZN',price,iv,st,maxPub,prio]);
      return [200,{ok:true,id:r.rows[0].id}];
    }
    case 'set_sandbox': {
      await setSandbox(b.enabled === true || b.enabled === 'true');
      return [200, { ok: true, sandbox: await isSandbox() }];
    }
    case 'approve_device_request': {
      if (!uuid(b.id)) return [400, { error: 'invalid' }];
      const result = await approveDeviceRequest(pool, b.id);
      return result.ok ? [200, { ok: true }] : [409, { error: result.error }];
    }
    case 'reject_device_request': {
      if (!uuid(b.id)) return [400, { error: 'invalid' }];
      const result = await rejectDeviceRequest(pool, b.id);
      return result.ok ? [200, { ok: true }] : [409, { error: 'not_pending' }];
    }
    case 'reconcile_payments': {
      // A PaySuite só aceita um webhook por conta (partilhado com outros sistemas), por isso
      // confirmamos os pedidos pendentes perguntando directamente à PaySuite.
      const pend = await pool.query(
        `select id, provider_payment_id from fair_orders
          where status in ('created','pending')
            and provider_payment_id is not null
            and provider_payment_id not like 'sim_%'
            and created_at > now() - interval '14 days'
          order by created_at desc limit 200`,
      );
      const apiToken = resolvePaysuiteToken();
      let checked = 0, paid = 0, closed = 0;
      for (const o of pend.rows) {
        const remoteStatus = await getPaymentStatus(o.provider_payment_id, apiToken);
        if (!remoteStatus) continue;
        checked++;
        if (remoteStatus === 'paid') {
          if (await settleOrderPaid(pool, o.id, o.provider_payment_id)) paid++;
        } else if (remoteStatus === 'failed' || remoteStatus === 'cancelled') {
          const upd = await pool.query("update fair_orders set status = $2 where id = $1 and status in ('created','pending')", [o.id, remoteStatus]).catch(() => null);
          // Devolve ao stock o exemplar que tinha sido reservado por um pagamento que não se concluiu.
          if (upd?.rowCount) await restoreReservedStock(pool, o.id);
          closed++;
        }
      }
      return [200, { ok: true, open: pend.rows.length, checked, paid, closed }];
    }
    case 'test_email': {
      const to = String(b.to || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return [400, { error: 'invalid_email' }];
      if (!emailConfigured()) return [200, { ok: false, error: 'email_not_configured' }];
      const res = await sendEmail({
        to,
        subject: 'Teste de email · Kulera+',
        html: '<p style="font:16px system-ui">Este é um email de teste da Kulera+. Se o recebeu, o envio está configurado.</p>',
        text: 'Este é um email de teste da Kulera+.',
      });
      return [200, { ok: res.ok, detail: res.error || null }];
    }
    case 'announce_book': {
      if (!uuid(b.bookId)) return [400, { error: 'invalid_book' }];
      if (!emailConfigured()) return [200, { ok: false, error: 'email_not_configured' }];
      return [200, await announceBook(pool, b.bookId)];
    }
    case 'save_settings': {
      const fee = Number(b.publication_fee_minor);
      if (!Number.isInteger(fee) || fee < 0 || fee > 100_000_00) return [400, { error: 'invalid_fee' }];
      await setSetting(pool, 'publication_fee_minor', fee);
      return [200, { ok: true, settings: { publication_fee_minor: await getPublicationFeeMinor(pool) } }];
    }
    case 'merge_partners': {
      if (!uuid(b.keepId) || !uuid(b.mergeId) || b.keepId === b.mergeId) return [400, { error: 'invalid' }];
      await ensurePaymentSchema();
      const keep = (await pool.query('select id from fair_partners where id=$1', [b.keepId])).rows[0];
      const merge = (await pool.query('select id from fair_partners where id=$1', [b.mergeId])).rows[0];
      if (!keep || !merge) return [404, { error: 'not_found' }];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const moves = [
          'update fair_books set partner_id=$2 where partner_id=$1',
          'update fair_sales set partner_id=$2 where partner_id=$1',
          'update fair_partner_users set partner_id=$2 where partner_id=$1',
          'update fair_partner_withdrawals set partner_id=$2 where partner_id=$1',
          'update fair_submissions set partner_id=$2 where partner_id=$1',
          'update fair_subscriptions set partner_id=$2 where partner_id=$1',
          'update fair_orders set partner_id=$2 where partner_id=$1',
          'update fair_publication_fees set partner_id=$2 where partner_id=$1',
        ];
        for (const sql of moves) {
          try { await client.query(sql, [b.mergeId, b.keepId]); } catch {}
        }
        await client.query('delete from fair_partners where id=$1', [b.mergeId]);
        await client.query('COMMIT');
        return [200, { ok: true }];
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('merge_partners.error', e?.message || String(e));
        return [500, { error: 'merge_failed' }];
      } finally {
        client.release();
      }
    }
    case 'grant_reader_credit': {
      if (!uuid(b.readerId)) return [400, { error: 'invalid_reader' }];
      const result = await grantCredit(pool, { readerId: b.readerId, amountMinor: b.amountMinor, note: b.note });
      return result.ok ? [200, { ok: true, balance: result.balance }] : [400, { error: result.error }];
    }
    case 'withdrawal_status': {
      if (!uuid(b.id) || !['requested', 'processing', 'paid', 'rejected'].includes(b.status)) return [400, { error: 'invalid' }];
      await pool.query("update fair_partner_withdrawals set status=$2, paid_at=case when $2='paid' then coalesce(paid_at, now()) else paid_at end where id=$1", [b.id, b.status]);
      return [200, { ok: true }];
    }
    case 'subscription_status': {
      if (!uuid(b.id)) return [400, { error: 'invalid' }];
      const actionType = String(b.actionType || '');
      if (actionType === 'block') {
        await pool.query("update fair_subscriptions set status='cancelled' where id=$1", [b.id]);
        return [200, { ok: true }];
      }
      if (actionType === 'unblock') {
        await pool.query("update fair_subscriptions set status='active' where id=$1", [b.id]);
        return [200, { ok: true }];
      }
      if (actionType === 'renew') {
        const days = Number(b.days) || 30;
        await pool.query(
          `update fair_subscriptions
              set status='active',
                  grace_ends_at = null,
                  last_payment_failed_at = null,
                  warning_72h_sent_at = null,
                  warning_24h_sent_at = null,
                  ends_at = greatest(coalesce(ends_at, now()), now()) + ($2 || ' days')::interval
            where id=$1`, [b.id, days]);
        return [200, { ok: true }];
      }
      if (actionType === 'payment_failed') {
        const r = await markSubscriptionPaymentFailed(pool, b.id);
        if (!r) return [404, { error: 'not_found' }];
        return [200, { ok: true, subscription: r }];
      }
      if (actionType === 'payment_recovered') {
        const days = Number(b.days) || 30;
        const r = await markSubscriptionPaymentRecovered(pool, b.id, new Date(), days);
        if (!r) return [404, { error: 'not_found' }];
        return [200, { ok: true, subscription: r }];
      }
      return [400, { error: 'invalid_subscription_action' }];
    }
    case 'run_maintenance': {
      const result = await runDailyMaintenance(pool, new Date());
      return [200, { ok: true, ...result }];
    }
    case 'grant_subscription': {
      if (!uuid(b.partnerId) || !uuid(b.planId)) return [400, { error: 'invalid' }];
      const days = Number(b.days) || 30;
      const pr = (await pool.query("select name,phone,email from fair_partners where id=$1", [b.partnerId])).rows[0];
      if (!pr) return [404, { error: 'partner_not_found' }];
      await pool.query('alter table fair_subscriptions add column if not exists partner_id uuid');
      const cur = await pool.query("select max(ends_at) e from fair_subscriptions where partner_id=$1 and status='active' and ends_at>now()", [b.partnerId]);
      const start = cur.rows[0]?.e || null;
      await pool.query(
        `insert into fair_subscriptions (buyer_name,buyer_phone,buyer_email,plan_id,status,starts_at,ends_at,partner_id)
         values ($1,$2,$3,$4,'active',coalesce($5::timestamptz,now()),coalesce($5::timestamptz,now())+($6||' days')::interval,$7)`,
        [pr.name, pr.phone || '000000000', pr.email, b.planId, start, days, b.partnerId]);
      return [200, { ok: true }];
    }
    case 'test_paysuite': {
      // A chave da PaySuite só existe no ambiente do servidor. O painel nunca
      // recebe, guarda nem aceita tokens vindos do browser.
      const tok = resolvePaysuiteToken();
      if (!tok) return [200, { ok: false, detail: 'Token da PaySuite não configurado no servidor (PAYSUITE_TOKEN).' }];
      try {
        const res = await createPayment({
          reference: 'KFTEST' + Date.now(),
          amountMinor: 100,
          description: 'Teste Ligacao Kulera+',
          returnUrl: `${resolveSiteUrl(req)}/pagamento.html`,
          callbackUrl: `${resolveSiteUrl(req)}/api/webhook`,
          apiToken: tok,
        });
        return [200, { ok: true, checkoutUrl: res.checkoutUrl, providerPaymentId: res.providerPaymentId }];
      } catch (e) {
        return [200, { ok: false, detail: String(e?.message || e) }];
      }
    }
    default: return [400, { error: 'invalid_action' }];
  }
}

// Painel da Kulera. A chave de acesso vive APENAS na base de dados
// (fair_settings.admin_key), gerida directamente no SQL. Não há ADMIN_KEY de
// ambiente, nem valor por omissão no código.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // Cron diário da Vercel (chega como GET com Authorization: Bearer <CRON_SECRET>).
  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  const auth = String(req.headers?.authorization || '');
  if (req.method === 'GET' && cronSecret && auth === `Bearer ${cronSecret}`) {
    try {
      return res.json({ ok: true, ...(await runDailyMaintenance(pool, new Date())) });
    } catch (e) {
      console.error('cron.error', e?.message || String(e));
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  }
  // Autenticação por sessão. Deixou de existir a chave única: o painel pertence a
  // dois administradores — tecnoincubadora e kulera — cada um com a sua conta.
  await ensureAdminSchema(pool).catch((e) => console.error('admin.schema.error', e?.message || String(e)));
  const current = await requireAdmin(pool, req);
  if (!current) return res.status(401).json({ error: 'unauthorized' });
  if (req.method === 'POST' && req.headers?.[CSRF_HEADER] !== CSRF_VALUE) {
    return res.status(403).json({ error: 'csrf' });
  }
  try {
    await ensurePaymentSchema();
    if (req.method === 'POST') { const [status, body] = await action(req.body ?? {}, req); return res.status(status).json(body); }

    const totals = (await pool.query(
      `select count(*) filter (where status='paid')::int as paid, coalesce(sum(amount_minor) filter (where status='paid'),0)::bigint as paid_minor,
              count(*) filter (where status in ('created','pending'))::int as open_orders from fair_orders`)).rows[0];
    const split = (await pool.query(`select
        coalesce(sum(coalesce(app_minor, commission_minor)),0)::bigint a,
        coalesce(sum(coalesce(editors_minor,0)),0)::bigint e,
        coalesce(sum(partner_minor),0)::bigint p,
        coalesce(sum(coalesce(gateway_minor,0)),0)::bigint g,
        coalesce(sum(coalesce(app_net_minor, coalesce(app_minor, commission_minor))),0)::bigint an from fair_sales`)).rows[0];
    let publicationFees = { f: 0 };
    try { publicationFees = (await pool.query('select coalesce(sum(amount_minor),0)::bigint f from fair_publication_fees where paid_at is not null')).rows[0]; } catch {}
    let creditTotals = { g: 0, n: 0 };
    try { creditTotals = (await pool.query('select coalesce(sum(gateway_minor),0)::bigint g, coalesce(sum(net_minor),0)::bigint n from fair_partner_credits')).rows[0]; } catch {}
    const leads = (await pool.query('select id, created_at, name, organisation, kind, phone, email, titles_count, message, status from partner_leads order by created_at desc limit 500')).rows;
    let orders;
    try {
      orders = (await pool.query(`select o.created_at, o.paid_at, o.buyer_name, o.buyer_phone, o.buyer_email, b.title as book, o.amount_minor, o.currency, o.status, coalesce(o.type,'book') as type, o.shipping_name, o.shipping_phone, o.shipping_address, o.shipping_city
          from fair_orders o left join fair_books b on b.id = o.book_id order by o.created_at desc limit 500`)).rows;
    } catch {
      orders = (await pool.query(`select o.created_at, o.paid_at, o.buyer_name, o.buyer_phone, o.buyer_email, b.title as book, o.amount_minor, o.currency, o.status
          from fair_orders o left join fair_books b on b.id = o.book_id order by o.created_at desc limit 500`)).rows.map(x=>({...x,type:'book',shipping_name:null,shipping_phone:null,shipping_address:null,shipping_city:null}));
    }
    let deviceRequests = [];
    try {
      deviceRequests = (await pool.query(
        `select r.id, r.order_id, r.status, r.created_at, r.resolved_at, r.device_info,
                o.buyer_name, o.buyer_phone, o.buyer_email, coalesce(b.title,'Livro') as book
           from fair_device_requests r
           join fair_orders o on o.id = r.order_id
           left join fair_books b on b.id = o.book_id
          order by r.created_at desc limit 200`,
      )).rows;
    } catch {}
    let books;
    try {
      books = (await pool.query(`select id, title, author, description, language, price_minor, currency, partner_id, status, cover_url, content_html is not null as has_content, kind, stock, requires_shipping, has_digital, has_physical, (to_jsonb(fair_books)->>'price_physical_minor')::bigint as price_physical_minor, publication_fee_minor, publication_fee_paid_at, updated_at from fair_books order by created_at desc`)).rows;
    } catch {
      books = (await pool.query(`select id, title, author, description, language, price_minor, currency, partner_id, status, cover_url, content_html is not null as has_content from fair_books order by created_at desc`)).rows.map(x=>({...x,kind:'ebook',stock:null,requires_shipping:false,has_digital:true,has_physical:false,publication_fee_minor:0,publication_fee_paid_at:null,updated_at:null}));
    }
    const partners = (await pool.query('select id, name, kind, phone, email, commission_bps, status, created_at from fair_partners order by created_at desc')).rows;
    // Detectar parceiros duplicados (nome, email ou telemóvel iguais).
    const normKey = (s) =>
      String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const buckets = new Map();
    for (const p of partners) {
      const ks = new Set([normKey(p.name)]);
      if (p.email) ks.add('e:' + normKey(p.email));
      if (p.phone) ks.add('p:' + String(p.phone).replace(/\D/g, ''));
      for (const k of ks) {
        if (!k || k === 'e:' || k === 'p:') continue;
        if (!buckets.has(k)) buckets.set(k, new Set());
        buckets.get(k).add(p.id);
      }
    }
    const dupSeen = new Set();
    const duplicates = [];
    for (const [, ids] of buckets) {
      if (ids.size < 2) continue;
      const sig = [...ids].sort().join(',');
      if (dupSeen.has(sig)) continue;
      dupSeen.add(sig);
      duplicates.push({
        partners: partners
          .filter((p) => ids.has(p.id))
          .map((p) => ({ id: p.id, name: p.name, kind: p.kind, email: p.email, phone: p.phone, created_at: p.created_at }))
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
      });
    }
    const payouts = (await pool.query(`select p.name, count(*)::int as sales, sum(s.gross_minor)::bigint as gross, sum(s.partner_minor)::bigint as owed
        from fair_sales s join fair_partners p on p.id = s.partner_id group by p.name order by owed desc`)).rows;
    let submissions = [];
    try { submissions = (await pool.query(`select s.id, s.title, s.author, s.status, s.admin_notes, s.created_at, p.name as partner from fair_submissions s left join fair_partners p on p.id=s.partner_id order by s.created_at desc limit 500`)).rows; } catch {}
    let plans = [];
    try {
      await ensurePlanSchema();
      plans = (await pool.query('select id,code,name,description,price_minor,currency,interval,status,max_publications,showcase_priority from fair_plans order by showcase_priority desc, price_minor asc')).rows;
    } catch {}
    const sandbox = await isSandbox();
    let subs = [];
    try {
      subs = (await pool.query(`select s.id,s.buyer_name,s.buyer_phone,s.status,s.starts_at,s.ends_at,s.partner_id,s.grace_ends_at,s.last_payment_failed_at,pl.name as plan, p.name as partner_name,
          case when s.ends_at < now() then true else false end as is_expired
          from fair_subscriptions s
          left join fair_plans pl on pl.id=s.plan_id
          left join fair_partners p on p.id=s.partner_id
          order by s.created_at desc limit 500`)).rows;
    } catch {}
    let withdrawals = [];
    try { withdrawals = (await pool.query(`select w.id, w.amount_minor, w.method, w.details, w.status, w.created_at, w.paid_at, p.name as partner from fair_partner_withdrawals w left join fair_partners p on p.id=w.partner_id order by w.created_at desc limit 500`)).rows; } catch {}
    const subscribers = await subscriberCount(pool);
    let readers = [];
    try {
      readers = (await pool.query(
        `select r.id, r.name, r.email, r.phone, r.status, r.created_at,
                coalesce((select sum(l.amount_minor) from fair_reader_ledger l where l.reader_id = r.id), 0)::bigint as balance
           from fair_readers r order by r.created_at desc limit 200`,
      )).rows.map((x) => ({ ...x, balance: Number(x.balance) }));
    } catch {}
    let promotions = [];
    try {
      promotions = (await pool.query(
        `select p.id, p.sent_at, p.recipients, coalesce(b.title,'Livro') as book
           from fair_promotions p left join fair_books b on b.id = p.book_id
          order by p.sent_at desc limit 50`,
      )).rows;
    } catch {}

    // Autores e a ligação livro↔autor (podem não existir em bases antigas).
    let authors = [];
    let bookAuthors = [];
    try {
      authors = (await pool.query(
        'select id, full_name, pen_name, nuit, bi_number, class, status, is_related, default_share_bps, payout_method, payout_account, data_completed_at from fair_authors order by full_name',
      )).rows.map((a) => ({ ...a, default_share_bps: Number(a.default_share_bps || 0) }));
      bookAuthors = (await pool.query(
        'select book_id, author_id, role, share_bps, amount_minor from fair_book_authors',
      )).rows.map((r) => ({ ...r, share_bps: Number(r.share_bps), amount_minor: r.amount_minor == null ? null : Number(r.amount_minor) }));
    } catch {}

    if (req.query?.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send(toCsv(req.query.type === 'orders' ? orders : req.query.type === 'payouts' ? payouts : leads));
    }
    res.json({ totals: { ...totals, paid_minor: Number(totals.paid_minor), app_minor: Number(split.a), editors_minor: Number(split.e),
        kulera_minor: Number(split.a) + Number(split.e), partners_minor: Number(split.p), fees_minor: Number(publicationFees.f),
        gateway_minor: Number(split.g) + Number(creditTotals.g), app_net_minor: Number(split.an) + Number(creditTotals.n) },
      leads, orders, deviceRequests, duplicates, books: books.map((x) => ({ ...x, price_minor: Number(x.price_minor), publication_fee_minor: Number(x.publication_fee_minor || 0) })), partners, payouts: payouts.map((x) => ({ ...x, gross: Number(x.gross), owed: Number(x.owed) })),
      submissions, plans: plans.map((x)=>({...x,price_minor:Number(x.price_minor)})), subscriptions: subs,
      withdrawals: withdrawals.map((x)=>({...x,amount_minor:Number(x.amount_minor)})),
      subscribers, emailReady: emailConfigured(), emailFrom: emailConfig()?.from || null, emailSupport: emailConfig()?.replyTo || null, promotions, readers,
      settings: { publication_fee_minor: await getPublicationFeeMinor(pool) },
      authors, bookAuthors,
      sandbox });
  } catch (e) {
    console.error('admin.error', e?.message || String(e));
    console.error('admin.error.stack', e?.stack);
    return res.status(500).json({ error: 'internal_error' });
  }
}
