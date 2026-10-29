import { timingSafeEqual, pbkdf2Sync, randomBytes } from "node:crypto";
import { pool } from "../lib/db.js";

const sameKey = (a,b)=>{
  const x = Buffer.from(String(a??""));
  const y = Buffer.from(String(b??""));
  return x.length === y.length && timingSafeEqual(x,y);
};
const hash = (pw,salt)=>pbkdf2Sync(pw,salt,100000,32,"sha256").toString("hex");
const makeHash = (pw)=>{
  const s = randomBytes(16).toString("hex");
  return `pbkdf2$100000$${s}$${hash(pw,s)}`;
};
const verify = (pw,stored)=>{
  const p = String(stored).split("$");
  if(p[0]!=="pbkdf2") return false;
  const salt = p[2], exp = p[3];
  return sameKey(hash(pw,salt), exp);
};

async function action(b){
  switch(b.action){
    case "register":{
      const name = String(b.name||"").trim().slice(0,120);
      const kind = b.kind==="author"?"author":"publisher";
      const phone = String(b.phone||"").trim().slice(0,30);
      const mail = String(b.email||"").trim().toLowerCase().slice(0,120);
      const pass = String(b.password||"");
      if(name.length<2||!mail.includes("@")||pass.length<6)return [400,{error:"invalid"}];
      let pr = await pool.query("select id,status from fair_partners where lower(email)=$1 or lower(name)=$2 order by created_at desc limit 1",[mail,name.toLowerCase()]);
      let pid;
      if(pr.rows[0]){ pid = pr.rows[0].id; } else {
        const r = await pool.query("insert into fair_partners (name,kind,phone,email,status) values ($1,$2,$3,$4,'active') returning id",[name,kind,phone,mail]);
        pid = r.rows[0].id;
      }
      const h = makeHash(pass);
      try{
        const r = await pool.query("insert into fair_partner_users (partner_id,email,password_hash) values ($1,$2,$3) returning id",[pid,mail,h]);
        return [200,{ok:true,id:r.rows[0].id,partnerId:pid}];
      }catch(e){ return [409,{error:"exists"}]; }
    }
    case "login":{
      const mail = String(b.email||"").trim().toLowerCase();
      const pass = String(b.password||"");
      const r = await pool.query("select u.id,u.partner_id,u.password_hash,u.status,p.status as pstatus from fair_partner_users u join fair_partners p on p.id=u.partner_id where lower(u.email)=$1",[mail]);
      if(!r.rows[0]||r.rows[0].status!=="active"||r.rows[0].pstatus==="suspended")return [401,{error:"unauthorized"}];
      if(!verify(pass,r.rows[0].password_hash))return [401,{error:"unauthorized"}];
      return [200,{ok:true,token:r.rows[0].id,partnerId:r.rows[0].partner_id}];
    }
    default:return [400,{error:"invalid_action"}];
  }
}

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  if(req.method==="POST"){
    const [status,body]=await action(req.body??{});
    return res.status(status).json(body);
  }
  const token = String(req.headers["x-partner-token"]??"");
  if(!/^[0-9a-f-]{36}$/.test(token))return res.status(401).json({error:"unauthorized"});
  const r = await pool.query("select u.partner_id,u.email,p.name,p.kind,p.status from fair_partner_users u join fair_partners p on p.id=u.partner_id where u.id=$1 and u.status='active'",[token]);
  if(!r.rows[0])return res.status(401).json({error:"unauthorized"});
  return res.json({ok:true,...r.rows[0]});
}
