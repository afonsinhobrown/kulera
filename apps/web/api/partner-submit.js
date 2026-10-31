import { pool } from "../lib/db.js";
import { startPayment } from "../lib/payments.js";
import { activePlan, publicationsUsed } from "../lib/plans.js";
import { activateBook, availableCredit, packByCode, CREDIT_PACKS } from "../lib/credits.js";

const clip = (v,n)=>String(v??"").replace(/\u0000/g,"").trim().slice(0,n);
const uuid = (v)=>/^[0-9a-f-]{36}$/.test(String(v));
const num = (v)=>Number(v??0);

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  const token = String(req.headers?.["x-partner-token"]??"");
  if(!/^[0-9a-f-]{36}$/.test(token))return res.status(401).json({error:"unauthorized"});
  const pu = await pool.query("select partner_id,status from fair_partner_users where id=$1 and status='active'",[token]);
  if(!pu.rows[0])return res.status(401).json({error:"unauthorized"});
  const pid = pu.rows[0].partner_id;

  if(req.method==="GET"){
    if(req.query?.reports){
      const p = await pool.query("select name,kind,email,phone from fair_partners where id=$1",[pid]);
      const sales = (await pool.query(
        `select s.created_at, b.title, s.gross_minor, coalesce(s.app_minor,s.commission_minor) as app_minor,
                coalesce(s.editors_minor,0) as editors_minor, s.partner_minor, o.paid_at, o.status
           from fair_sales s left join fair_books b on b.id=s.book_id left join fair_orders o on o.id=s.order_id
          where s.partner_id=$1 order by s.created_at desc limit 500`,[pid])).rows;
      const fees = (await pool.query(
        `select amount_minor, paid_at, created_at from fair_publication_fees where partner_id=$1 order by created_at desc limit 500`,[pid])).rows;
      const withdrawals = (await pool.query(
        `select amount_minor, method, details, status, created_at, paid_at from fair_partner_withdrawals where partner_id=$1 order by created_at desc limit 500`,[pid])).rows;
      const earned = sales.reduce((a,s)=>a+num(s.partner_minor),0);
      const gross = sales.reduce((a,s)=>a+num(s.gross_minor),0);
      const appTotal = sales.reduce((a,s)=>a+num(s.app_minor),0);
      const editorsTotal = sales.reduce((a,s)=>a+num(s.editors_minor),0);
      const feesPaid = fees.filter(f=>f.paid_at).reduce((a,f)=>a+num(f.amount_minor),0);
      const feesPending = fees.filter(f=>!f.paid_at).reduce((a,f)=>a+num(f.amount_minor),0);
      const wPaid = withdrawals.filter(w=>w.status==="paid").reduce((a,w)=>a+num(w.amount_minor),0);
      const wOpen = withdrawals.filter(w=>w.status==="requested"||w.status==="processing").reduce((a,w)=>a+num(w.amount_minor),0);
      let pendingFees = [];
      try { pendingFees = (await pool.query("select id, title, publication_fee_minor from fair_books where partner_id=$1 and publication_fee_paid_at is null and coalesce(publication_fee_minor,0)>0 order by created_at desc",[pid])).rows.map(x=>({...x,publication_fee_minor:Number(x.publication_fee_minor)})); } catch {}
      const plan = await activePlan(pid).catch(()=>null);
      const used = await publicationsUsed(pid).catch(()=>0);
      let credits = [];
      try {
        credits = (await pool.query(
          `select id, pack, price_minor, slots_total, slots_used, days, purchased_at,
                  (slots_total - slots_used) as remaining
             from fair_partner_credits where partner_id=$1 order by purchased_at desc limit 50`, [pid])).rows
          .map(x=>({...x, price_minor:Number(x.price_minor), slots_total:Number(x.slots_total), slots_used:Number(x.slots_used), remaining:Number(x.remaining)}));
      } catch {}
      let books = [];
      try {
        books = (await pool.query(
          `select id, title, status, active_until, publication_fee_paid_at, coalesce(publication_fee_minor,0)::bigint as publication_fee_minor
             from fair_books where partner_id=$1 order by created_at desc limit 200`, [pid])).rows
          .map(x=>({...x, publication_fee_minor:Number(x.publication_fee_minor)}));
      } catch {}
      return res.json({ ok:true, partner:p.rows[0]||null, plan, used, pendingFees, credits, books, packs: CREDIT_PACKS,
        summary:{ salesCount:sales.length, gross, appTotal, editorsTotal, earned, feesPaid, feesPending, withdrawalsPaid:wPaid, withdrawalsOpen:wOpen, available: earned-wPaid-wOpen },
        sales, fees, withdrawals });
    }
    const r = await pool.query("select id,title,author,status,admin_notes,created_at,updated_at from fair_submissions where partner_id=$1 order by created_at desc limit 200",[pid]);
    return res.json({ok:true,submissions:r.rows});
  }
  if(req.method==="POST"){
    const b = req.body??{};
    if(b.action==="buy_credits"){
      const pack = packByCode(b.pack);
      if(!pack) return res.status(400).json({error:"invalid_pack"});
      const pr = (await pool.query("select name,phone,email from fair_partners where id=$1",[pid])).rows[0]||{};
      const phone = String(b.phone||pr.phone||"").replace(/\D/g,"");
      if(phone.length<9) return res.status(400).json({error:"invalid_phone"});
      const pay = await startPayment({ type:"credits", listAmountMinor: pack.priceMinor, name: pr.name||"Parceiro", phone, email: pr.email,
        description:`Kulera+: Créditos de publicação (${pack.label})`, extra:{ partner_id: pid }, req });
      if(!pay.ok) return res.status(502).json({error:"payment_unavailable", detail: pay.errorDetail});
      return res.json({ok:true, checkoutUrl:pay.checkoutUrl, amountMinor:pay.amountMinor, sandbox:pay.sandbox, simulated:Boolean(pay.simulated)});
    }
    if(b.action==="activate_book"){
      if(!uuid(b.bookId)) return res.status(400).json({error:"invalid"});
      const result = await activateBook(pool, pid, b.bookId);
      if(!result.ok) return res.status(400).json({error: result.error});
      return res.json({ok:true, days: result.days});
    }
    if(b.action==="withdraw"){
      const amount = Number(b.amountMinor);
      if(!Number.isInteger(amount)||amount<=0)return res.status(400).json({error:"invalid_amount"});
      const e = await pool.query("select coalesce(sum(partner_minor),0) as earned from fair_sales where partner_id=$1",[pid]);
      const w = await pool.query("select coalesce(sum(amount_minor),0) as used from fair_partner_withdrawals where partner_id=$1 and status in ('requested','processing','paid')",[pid]);
      const available = num(e.rows[0].earned)-num(w.rows[0].used);
      if(amount>available)return res.status(400).json({error:"insufficient_funds",available});
      const ins = await pool.query("insert into fair_partner_withdrawals (partner_id,amount_minor,method,details) values ($1,$2,$3,$4) returning id",[pid,amount,clip(b.method,40)||null,clip(b.details,300)||null]);
      return res.json({ok:true,id:ins.rows[0].id});
    }
    if(b.action==="pay_fee"){
      if(!uuid(b.bookId))return res.status(400).json({error:"invalid"});
      const bk = (await pool.query("select id,title,publication_fee_minor from fair_books where id=$1 and partner_id=$2 and publication_fee_paid_at is null and coalesce(publication_fee_minor,0)>0",[b.bookId,pid])).rows[0];
      if(!bk)return res.status(404).json({error:"not_found"});
      const pr = (await pool.query("select name,phone,email from fair_partners where id=$1",[pid])).rows[0]||{};
      const phone = String(b.phone||pr.phone||"").replace(/\D/g,"");
      if(phone.length<9)return res.status(400).json({error:"invalid_phone"});
      const pay = await startPayment({ type:"publication", listAmountMinor:Number(bk.publication_fee_minor), name:pr.name||"Parceiro", phone, email:pr.email,
        description:`Kulera+: Taxa de publicação - ${bk.title}`, extra:{ book_id:bk.id, partner_id:pid }, req });
      if(!pay.ok)return res.status(502).json({error:"payment_unavailable", detail: pay.errorDetail});
      return res.json({ok:true,checkoutUrl:pay.checkoutUrl,amountMinor:pay.amountMinor,sandbox:pay.sandbox,simulated:Boolean(pay.simulated)});
    }
    // Publicar exige plano activo OU créditos de publicação; o plano tem limite mensal.
    const plan = await activePlan(pid);
    const credit = await availableCredit(pool, pid).catch(()=>null);
    if(!plan && !credit)return res.status(402).json({error:"no_plan"});
    if(plan && plan.max_publications!=null && await publicationsUsed(pid) >= plan.max_publications && !credit)return res.status(403).json({error:"plan_limit",limit:plan.max_publications});
    const title = clip(b.title,200), author = clip(b.author,200);
    if(title.length<1||author.length<1)return res.status(400).json({error:"invalid"});
    const content = typeof b.contentHtml==="string"&&b.contentHtml.trim()?b.contentHtml.replace(/\u0000/g,""):null;
    if(content && content.length>3_500_000)return res.status(413).json({error:"content_too_large"});
    const r = await pool.query("insert into fair_submissions (partner_id,partner_user_id,title,author,description,language,cover_url,content_html) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",[pid,token,title,author,clip(b.description,2000)||null,clip(b.language,10)||"pt",clip(b.coverUrl,2_500_000)||null,content]);
    return res.json({ok:true,id:r.rows[0].id});
  }
  if(req.method==="DELETE"){
    const id = String(req.query?.id??"");
    if(!uuid(id))return res.status(400).json({error:"invalid"});
    await pool.query("delete from fair_submissions where id=$1 and partner_id=$2 and status in ('submitted','changes_requested')",[id,pid]);
    return res.json({ok:true});
  }
  return res.status(405).json({error:"method_not_allowed"});
}
