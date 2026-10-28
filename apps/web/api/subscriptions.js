import { pool } from "../lib/db.js";
import { createOrder } from "../lib/book.js";

const uuid = (v)=>/^[0-9a-f-]{36}$/.test(String(v));

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  if(req.method==="GET"){
    const r = await pool.query("select id,code,name,description,price_minor,currency,interval from fair_plans where status='active' order by price_minor asc");
    return res.json({plans:r.rows.map(x=>({...x,price_minor:Number(x.price_minor)}))});
  }
  if(req.method==="POST"){
    const b=req.body??{};
    const planId=String(b.planId||"");
    if(!uuid(planId))return res.status(400).json({error:"invalid"});
    const p = await pool.query("select * from fair_plans where id=$1 and status='active'",[planId]);
    if(!p.rows[0])return res.status(404).json({error:"not_found"});
    const plan=p.rows[0];
    const name=String(b.name||"").trim().slice(0,120), phone=String(b.phone||"").replace(/\D/g,"");
    if(name.length<2||phone.length<9)return res.status(400).json({error:"invalid"});
    // criar order tipo subscription
    let amountMinor = Number(plan.price_minor);
    if (process.env.SANDBOX === 'true' || process.env.TEST_PRICE_MT === '1' || process.env.FORCE_TEST_PRICE === '1') {
      amountMinor = 100;
    }
    const order = await createOrder({ name, phone, email: String(b.email||"").trim()||null, amountMinor, currency:plan.currency, meta:{planId, type:"subscription"} });
    // link plan_id
    await pool.query("update fair_orders set plan_id=$2,type='subscription' where id=$1",[order.id,planId]);
    const respAmount = (process.env.SANDBOX === 'true' || process.env.TEST_PRICE_MT === '1' || process.env.FORCE_TEST_PRICE === '1') ? 100 : Number(plan.price_minor);
    return res.json({orderId:order.id,reference:order.reference,token:order.token,checkoutUrl:order.checkoutUrl,amountMinor:respAmount,currency:plan.currency});
  }
  return res.status(405).json({error:"method_not_allowed"});
}
