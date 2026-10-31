import { pool } from '../lib/db.js';
// Catálogo público (sem cache para reflectir alterações de capa/preço imediatamente)
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  try {
    let rows = [];
    try {
      const r = await pool.query(
        `select b.id, b.title, b.author, b.description, b.language, b.price_minor, b.currency, b.cover_url, b.updated_at,
                coalesce(b.kind,'ebook') as kind, b.requires_shipping, b.stock, coalesce(b.has_digital,true) as has_digital,
                coalesce(b.has_physical,false) as has_physical, b.content_html is not null as has_content,
                (to_jsonb(b)->>'price_physical_minor')::bigint as price_physical_minor,
                coalesce(max(p.showcase_priority), case when b.partner_id is null then 99 else 1 end) as priority
           from fair_books b
           left join fair_subscriptions s on s.partner_id = b.partner_id and s.status = 'active' and s.ends_at > now()
           left join fair_plans p on p.id = s.plan_id
          where b.status = 'published'
            and (coalesce(b.kind,'ebook') = 'physical' or coalesce(b.has_physical,false) = true or b.content_html is not null)
            and (b.partner_id is null
                 or s.id is not null
                 or b.active_until > now()
                 or not exists (select 1 from fair_subscriptions sx where sx.partner_id = b.partner_id))
          group by b.id
          order by priority desc, b.created_at desc limit 200`);
      rows = r.rows;
    } catch {
      const r = await pool.query(
        `select id, title, author, description, language, price_minor, currency, cover_url
           from fair_books where status = 'published' order by created_at desc limit 200`);
      rows = r.rows.map((x) => ({
        ...x,
        kind: 'ebook',
        requires_shipping: false,
        stock: null,
        has_digital: true,
        has_physical: false,
        has_content: null,
      }));
    }
    res.json(
      rows.map((b) => {
        const out = {
          id: b.id,
          title: b.title,
          author: b.author,
          description: b.description,
          language: b.language,
          priceMinor: Number(b.price_minor),
          digitalPriceMinor: b.has_digital !== false ? Number(b.price_minor) : null,
          physicalPriceMinor:
            b.has_physical === true || b.kind === 'physical'
              ? Number(b.price_physical_minor ?? b.price_minor)
              : null,
          currency: b.currency,
          coverUrl: b.cover_url,
          updatedAt: b.updated_at ? new Date(b.updated_at).getTime() : null,
          kind: b.kind || 'ebook',
          requiresShipping: b.requires_shipping || b.kind === 'physical',
          stock: b.stock,
          hasDigital: b.has_digital !== false,
          hasPhysical: b.has_physical === true || b.kind === 'physical',
          hasContent: b.has_content,
        };
        return out;
      }),
    );
  } catch (e) {
    console.error('books.error', e?.message || String(e));
    res.status(500).json({ error: 'internal_error' });
  }
}
