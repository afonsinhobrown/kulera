import { pool } from '../lib/db.js';

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const b = req.body ?? {};
  if (b.website) return res.status(200).json({ ok: true }); // campo-armadilha para robôs
  const name = clip(b.name, 80), organisation = clip(b.organisation, 120), email = clip(b.email, 120);
  const message = clip(b.message, 600);
  const phone = clip(b.phone, 30).replace(/[\s()-]/g, '').replace(/^\+/, '');
  const kind = b.kind === 'publisher' ? 'publisher' : b.kind === 'author' ? 'author' : null;
  const titles = Number.isInteger(Number(b.titles)) && Number(b.titles) >= 0 ? Math.min(Number(b.titles), 100000) : null;

  if (name.length < 2) return res.status(400).json({ error: 'invalid_name' });
  if (!kind) return res.status(400).json({ error: 'invalid_kind' });
  if (!/^\d{9,15}$/.test(phone)) return res.status(400).json({ error: 'invalid_phone' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });

  // Não aceitar registos repetidos da mesma editora/escritor (telemóvel, email ou organização).
  try {
    const partner = await pool.query(
      `select 1 from fair_partners where lower(coalesce(email,'')) = $1 or phone = $2 limit 1`,
      [email.toLowerCase(), phone],
    );
    if (partner.rows.length) return res.status(409).json({ error: 'already_partner' });

    const dup = await pool.query(
      `select 1 from partner_leads
        where phone = $1
           or ($2 <> '' and lower(coalesce(email,'')) = $2)
           or ($3 <> '' and lower(coalesce(organisation,'')) = $3 and kind = $4)
        limit 1`,
      [phone, email.toLowerCase(), organisation.toLowerCase(), kind],
    );
    if (dup.rows.length) return res.status(409).json({ error: 'duplicate' });
  } catch {
    // Se a verificação falhar, não bloqueia o registo.
  }

  await pool.query(
    `insert into partner_leads (name, organisation, kind, phone, email, titles_count, message)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [name, organisation || null, kind, phone, email || null, titles, message || null],
  );
  res.status(200).json({ ok: true });
}
