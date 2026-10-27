import { pool } from "../lib/db.js";

const clip = (v,n)=>String(v??"").trim().slice(0,n);
const uuid = (v)=>/^[0-9a-f-]{36}$/.test(String(v));

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  const token = String(req.headers["x-partner-token"]??"");
  if(!/^[0-9a-f-]{36}$/.test(token))return res.status(401).json({error:"unauthorized"});
  const pu = await pool.query("select partner_id,status from fair_partner_users where id=$1 and status='active'",[token]);
  if(!pu.rows[0])return res.status(401).json({error:"unauthorized"});
  const pid = pu.rows[0].partner_id;

  if(req.method==="GET"){
    const r = await pool.query("select id,title,author,status,admin_notes,created_at,updated_at from fair_submissions where partner_id=$1 order by created_at desc limit 200",[pid]);
    return res.json({ok:true,submissions:r.rows});
  }
  if(req.method==="POST"){
    const b = req.body??{};
    const title = clip(b.title,200), author = clip(b.author,200);
    if(title.length<1||author.length<1)return [res.status(400).json({error:"invalid"}),null][0];
    const content = typeof b.contentHtml==="string"&&b.contentHtml.trim()?b.contentHtml:null;
    if(content && content.length>3_500_000)return res.status(413).json({error:"content_too_large"});
    const r = await pool.query("insert into fair_submissions (partner_id,partner_user_id,title,author,description,language,cover_url,content_html) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",[pid,token,title,author,clip(b.description,2000)||null,clip(b.language,10)||"pt",clip(b.coverUrl,500)||null,content]);
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
