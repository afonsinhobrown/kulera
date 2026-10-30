import { pool } from "../lib/db.js";
import { startPayment } from "../lib/payments.js";
import { ensurePlanSchema, activePlan, publicationsUsed } from "../lib/plans.js";

const uuid = (v)=>/^[0-9a-f-]{36}$/.test(String(v));

// Subscrições mensais de editoras/autores. Pagamento SEMPRE via PaySuite (startPayment).
export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  try {
    await ensurePlanSchema();
    if(req.method==="GET"){
      const r = await pool.query("select id,code,name,description,price_minor,currency,interval,max_publications,showcase_priority from fair_plans where status='active' order by price_minor asc");
      const out = { plans: r.rows.map(x=>({...x,price_minor:Number(x.price_minor)})) };
      const token = String(req.headers["x-partner-token"]??"");
      if(uuid(token)){
        const pu = await pool.query("select partner_id from fair_partner_users where id=$1 and status='active'",[token]);
        if(pu.rows[0]){ out.current = await activePlan(pu.rows[0].partner_id); out.used = await publicationsUsed(pu.rows[0].partner_id); }
      }
      return res.json(out);
    }
    if(req.method==="POST"){
      const token = String(req.headers["x-partner-token"]??"");
      if(!uuid(token)) return res.status(401).json({error:"login_required"});
      const pu = await pool.query(
        "select u.partner_id, p.name, p.phone, p.email from fair_partner_users u join fair_partners p on p.id=u.partner_id where u.id=$1 and u.status='active'",[token]);
      const partner = pu.rows[0];
      if(!partner) return res.status(401).json({error:"login_required"});
      const b=req.body??{};
      const planId=String(b.planId||"");
      if(!uuid(planId))return res.status(400).json({error:"invalid"});
      const p = await pool.query("select * from fair_plans where id=$1 and status='active'",[planId]);
      const plan=p.rows[0];
      if(!plan)return res.status(404).json({error:"not_found"});
      const phone=String(b.phone||partner.phone||"").replace(/\D/g,"");
      if(phone.length<9)return res.status(400).json({error:"invalid_phone"});
      const pay = await startPayment({
        type:"subscription", listAmountMinor:Number(plan.price_minor), currency:plan.currency,
        name:partner.name, phone, email:partner.email,
        description:`Kulera+: Plano ${plan.name} (mensal)`,
        extra:{ plan_id:plan.id, partner_id:partner.partner_id },
      });
      if(!pay.ok) return res.status(502).json({error:"payment_unavailable"});
      return res.json({orderId:pay.id,token:pay.token,checkoutUrl:pay.checkoutUrl,amountMinor:pay.amountMinor,sandbox:pay.sandbox,currency:plan.currency});
    }
    return res.status(405).json({error:"method_not_allowed"});
  } catch(e){
    console.error("subscriptions.error", e?.message||String(e));
    return res.status(500).json({error:"internal_error"});
  }
}
