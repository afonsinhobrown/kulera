import { pool } from "../lib/db.js";
export default async function handler(req,res){
  if(process.env.NODE_ENV==="production" && req.headers["x-seed-key"]!==process.env.SEED_KEY) return res.status(401).json({error:"unauthorized"});
  await pool.query(`insert into fair_plans (code,name,description,price_minor,currency,interval,status)
    values ('mzn-month','Mensal','Acesso \u00e0 biblioteca','149900','MZN','month','active'),
           ('mzn-year','Anual','Melhor valor - 12 meses','1499000','MZN','year','active')
    on conflict (code) do nothing`);
  return res.json({ok:true});
}
