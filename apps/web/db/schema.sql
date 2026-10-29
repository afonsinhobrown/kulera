create table if not exists fair_orders (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  reference text not null unique,
  provider_payment_id text unique,
  buyer_name text not null,
  buyer_phone text not null,
  buyer_email text,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  status text not null default 'created' check (status in ('created','pending','paid','failed','cancelled')),
  checkout_url text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists fair_events (
  event_key text primary key,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

create table if not exists partner_leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  organisation text,
  kind text not null check (kind in ('publisher','author')),
  phone text not null,
  email text,
  titles_count int,
  message text,
  source text not null default 'feira',
  status text not null default 'new' check (status in ('new','contacted','signed','declined')),
  created_at timestamptz not null default now()
);

-- ===== Catálogo, parceiros e comissões (plataforma) =====
create table if not exists fair_partners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'publisher' check (kind in ('publisher','author')),
  phone text,
  email text,
  commission_bps int not null default 2000 check (commission_bps between 0 and 10000), -- a Kulera define por parceiro
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now()
);
create table if not exists fair_books (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid references fair_partners (id),   -- null = livro da própria Kulera
  title text not null,
  author text not null,
  description text,
  language text not null default 'pt',
  price_minor bigint not null check (price_minor > 0), -- preço SEMPRE vem daqui
  currency char(3) not null default 'MZN',
  cover_url text,
  content_html text,                               -- livro convertido; nunca sai sem pagamento
  kind text not null default 'ebook' check (kind in ('ebook','physical')),
  stock integer check (stock is null or stock >= 0),
  requires_shipping boolean not null default false,
  shipping_info text,
  status text not null default 'draft' check (status in ('draft', 'published', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table fair_books add column if not exists publication_fee_minor bigint not null default 0;
alter table fair_books add column if not exists publication_fee_paid_at timestamptz;
alter table fair_books add column if not exists kind text not null default 'ebook';
alter table fair_books add column if not exists stock integer;
alter table fair_books add column if not exists requires_shipping boolean not null default false;
alter table fair_books add column if not exists shipping_info text;
alter table fair_books add column if not exists has_digital boolean not null default true;
alter table fair_books add column if not exists has_physical boolean not null default false;
update fair_books set has_physical = true where coalesce(kind,'ebook')='physical' or coalesce(requires_shipping,false);
update fair_books set has_digital = false where coalesce(kind,'ebook')='physical' and content_html is null;
alter table fair_orders add column if not exists book_id uuid references fair_books (id);
alter table fair_orders add column if not exists plan_id uuid;
alter table fair_orders add column if not exists type text not null default 'book' check (type in ('book','subscription','physical'));
alter table fair_orders drop constraint if exists fair_orders_type_check;
alter table fair_orders add constraint fair_orders_type_check check (type in ('book','subscription','physical','publication'));
alter table fair_orders add column if not exists shipping_name text;
alter table fair_orders add column if not exists shipping_phone text;
alter table fair_orders add column if not exists shipping_address text;
alter table fair_orders add column if not exists shipping_city text;
alter table fair_orders add column if not exists shipped_at timestamptz;
create table if not exists fair_sales (
  order_id uuid primary key references fair_orders (id),
  book_id uuid references fair_books (id),
  partner_id uuid references fair_partners (id),
  gross_minor bigint not null,
  commission_bps int not null check (commission_bps between 0 and 10000), -- percentagem aplicada na altura
  commission_minor bigint not null,
  partner_minor bigint not null,
  app_bps int not null default 2000 check (app_bps between 0 and 10000),
  editors_bps int not null default 1000 check (editors_bps between 0 and 10000),
  app_minor bigint,
  editors_minor bigint,
  created_at timestamptz not null default now(),
  check (commission_minor + partner_minor = gross_minor)
);
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

-- Taxas de publicação (500 MT por livro de parceiro externo), 100% para a Kulera App
create table if not exists fair_publication_fees (
  order_id uuid primary key references fair_orders (id),
  book_id uuid not null references fair_books (id) on delete cascade,
  partner_id uuid references fair_partners (id),
  amount_minor bigint not null check (amount_minor > 0),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

-- Parceiros com acesso self-service
create table if not exists fair_partner_users (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references fair_partners (id) on delete cascade,
  email text not null unique,
  password_hash text not null,
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now()
);

-- Saques / pagamentos aos parceiros
create table if not exists fair_partner_withdrawals (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references fair_partners (id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  method text,
  details text,
  status text not null default 'requested' check (status in ('requested','processing','paid','rejected')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

-- Submissões de manuscritos por parceiros
create table if not exists fair_submissions (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references fair_partners (id),
  partner_user_id uuid references fair_partner_users (id),
  title text not null,
  author text not null,
  description text,
  language text not null default 'pt',
  cover_url text,
  content_html text,
  status text not null default 'submitted' check (status in ('submitted','in_review','changes_requested','approved','rejected')),
  admin_notes text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Planos de subscrição
create table if not exists fair_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  price_minor bigint not null check (price_minor >= 0),
  currency char(3) not null default 'MZN',
  interval text not null check (interval in ('month','year')),
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now()
);

-- Subscrições activas
create table if not exists fair_subscriptions (
  id uuid primary key default gen_random_uuid(),
  buyer_name text not null,
  buyer_phone text not null,
  buyer_email text,
  plan_id uuid not null references fair_plans (id),
  order_id uuid references fair_orders (id),
  status text not null default 'active' check (status in ('active','cancelled','expired')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  created_at timestamptz not null default now()
);
