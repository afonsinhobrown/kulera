import { timingSafeEqual } from 'node:crypto';
import { pool } from '../lib/db.js';

const same = (a, b) => {
  const x = Buffer.from(String(a ?? '').trim());
  const y = Buffer.from(String(b ?? '').trim());
  return x.length === y.length && (() => { try { return timingSafeEqual(x, y); } catch { return false; } })();
};

const DDL = `
alter table fair_books add column if not exists publication_fee_minor bigint not null default 0;
alter table fair_books add column if not exists publication_fee_paid_at timestamptz;
alter table fair_orders drop constraint if exists fair_orders_type_check;
alter table fair_orders add constraint fair_orders_type_check check (type in ('book','subscription','physical','publication'));
alter table fair_sales add column if not exists app_bps int not null default 2000;
alter table fair_sales add column if not exists editors_bps int not null default 1000;
alter table fair_sales add column if not exists app_minor bigint;
alter table fair_sales add column if not exists editors_minor bigint;
update fair_sales set app_minor = coalesce(app_minor, commission_minor), editors_minor = coalesce(editors_minor, 0);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fair_sales_three_way_check') then
    alter table fair_sales add constraint fair_sales_three_way_check
      check (coalesce(app_minor, 0) + coalesce(editors_minor, 0) + partner_minor = gross_minor);
  end if;
end $$;
create table if not exists fair_publication_fees (
  order_id uuid primary key references fair_orders (id),
  book_id uuid not null references fair_books (id) on delete cascade,
  partner_id uuid references fair_partners (id),
  amount_minor bigint not null check (amount_minor > 0),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.ADMIN_KEY || !same(req.headers['x-admin-key'], process.env.ADMIN_KEY)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await pool.query(DDL);
    return res.json({ ok: true });
  } catch (e) {
    console.error('migrate.error', e?.message || String(e));
    return res.status(500).json({ error: 'internal_error', detail: e?.message || String(e) });
  }
}
