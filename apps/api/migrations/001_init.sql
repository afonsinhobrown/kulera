-- Kulera+ — esquema inicial (PostgreSQL). Ver Guia Técnico, secção 7, e ERS, secção 6.
-- Regras: UUID, timestamps em UTC, dinheiro em inteiros (menor unidade) + moeda ISO 4217.
-- Transacções, vendas, repasses e auditoria nunca se apagam nem se editam à mão.

create extension if not exists pgcrypto;

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ---------- Utilizadores e parceiros ----------
create table users (
  id uuid primary key default gen_random_uuid(),
  email text,
  phone text,
  password_hash text not null,
  display_name text not null,
  role text not null default 'reader' check (role in ('reader', 'partner', 'admin', 'support')),
  locale text not null default 'pt',
  preferred_currency char(3) not null default 'MZN' check (preferred_currency in ('MZN', 'USD', 'EUR', 'BRL')),
  status text not null default 'active' check (status in ('active', 'blocked', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email is not null or phone is not null)
);
create unique index users_email_uq on users (lower(email)) where email is not null;
create unique index users_phone_uq on users (phone) where phone is not null;

create table partners (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  kind text not null check (kind in ('publisher', 'independent_author')),
  public_name text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'suspended')),
  commission_bps integer check (commission_bps between 0 and 10000), -- null = comissão global
  payout_details jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index partners_user_uq on partners (user_id);

-- ---------- Catálogo ----------
create table plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  price_minor bigint not null check (price_minor >= 0),
  currency char(3) not null default 'MZN',
  benefits jsonb not null default '[]',
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table works (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references partners (id),
  kind text not null check (kind in ('ebook', 'article', 'physical')),
  title text not null,
  author text not null,
  language text not null,                       -- BCP 47: pt, pt-MZ, en...
  translation_group_id uuid,                    -- liga traduções de uma mesma obra
  category text,
  price_minor bigint not null default 0 check (price_minor >= 0),
  currency char(3) not null default 'MZN',
  access text not null default 'paid' check (access in ('free', 'paid')),
  status text not null default 'draft' check (status in ('draft', 'in_review', 'published', 'suspended')),
  stock integer check (stock is null or stock >= 0), -- só livros físicos
  original_file_key text,                       -- Word/PDF original (armazenamento privado)
  epub_file_key text,                           -- EPUB 3 gerado (armazenamento privado)
  cover_key text,
  metadata jsonb not null default '{}',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index works_partner_idx on works (partner_id);
create index works_status_lang_idx on works (status, language);

create table work_plans (
  work_id uuid not null references works (id) on delete cascade,
  plan_id uuid not null references plans (id),
  primary key (work_id, plan_id)
);

-- ---------- Pagamentos ----------
create table transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  provider text not null default 'paysuite',
  provider_payment_id text unique,
  reference text not null unique,
  status text not null default 'created'
    check (status in ('created', 'pending', 'paid', 'failed', 'cancelled', 'refunded')),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  items jsonb not null,
  checkout_url text,
  idempotency_key text not null,
  request_hash text not null,
  failure_reason text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index transactions_status_idx on transactions (status, created_at);

-- Eventos de webhook recebidos: event_key UNIQUE garante idempotência.
create table payment_events (
  id bigserial primary key,
  event_key text not null unique,                -- SHA-256 do corpo bruto
  provider text not null default 'paysuite',
  event_type text not null,
  payload jsonb not null,
  outcome text,
  received_at timestamptz not null default now()
);

-- ---------- Acessos ----------
create table purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  work_id uuid not null references works (id),
  transaction_id uuid not null references transactions (id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index purchases_active_uq on purchases (user_id, work_id) where revoked_at is null;

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  plan_id uuid not null references plans (id),
  status text not null check (status in ('pending', 'active', 'cancelled', 'expired')),
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  last_transaction_id uuid references transactions (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, plan_id)
);

-- ---------- Split e repasses ----------
create table payouts (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references partners (id),
  period_start date not null,
  period_end date not null,
  gross_minor bigint not null,
  commission_minor bigint not null,
  net_minor bigint not null,
  currency char(3) not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'paid')),
  created_at timestamptz not null default now()
);

create table sales (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions (id),
  work_id uuid not null references works (id),
  partner_id uuid not null references partners (id),
  gross_minor bigint not null,
  commission_bps integer not null check (commission_bps between 0 and 10000), -- percentagem aplicada na altura
  commission_minor bigint not null,
  partner_minor bigint not null,
  currency char(3) not null,
  reversed_at timestamptz,
  payout_id uuid references payouts (id),
  created_at timestamptz not null default now(),
  check (commission_minor + partner_minor = gross_minor)
);
create index sales_partner_idx on sales (partner_id, created_at);

-- ---------- Pedidos físicos e delivery ----------
create table orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  transaction_id uuid references transactions (id),
  status text not null default 'received'
    check (status in ('received', 'paid', 'preparing', 'shipped', 'delivered', 'cancelled')),
  recipient_name text not null,
  recipient_phone text not null,
  country text not null default 'MZ',
  province text,
  city text,
  district text,
  address_line text,
  reference_point text,
  delivery_fee_minor bigint not null default 0,
  currency char(3) not null default 'MZN',
  assigned_to text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  work_id uuid not null references works (id),
  quantity integer not null check (quantity > 0),
  unit_price_minor bigint not null
);

-- ---------- Leitura ----------
create table reading_progress (
  user_id uuid not null references users (id),
  work_id uuid not null references works (id),
  position text not null,            -- localização no EPUB (CFI)
  bookmarks jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (user_id, work_id)
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  label text,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- ---------- Bot ----------
create table bot_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users (id),
  channel text not null check (channel in ('whatsapp', 'telegram', 'in_app')),
  status text not null default 'open' check (status in ('open', 'escalated', 'closed')),
  assigned_agent_id uuid references users (id),
  messages jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Auditoria (só se acrescenta) ----------
create table audit_log (
  id bigserial primary key,
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- ---------- Protecções ----------
create or replace function forbid_delete() returns trigger as $$
begin
  raise exception 'Apagar registos de % não é permitido', tg_table_name;
end;
$$ language plpgsql;

create trigger transactions_no_delete before delete on transactions for each row execute function forbid_delete();
create trigger sales_no_delete before delete on sales for each row execute function forbid_delete();
create trigger payouts_no_delete before delete on payouts for each row execute function forbid_delete();
create trigger audit_no_delete before delete on audit_log for each row execute function forbid_delete();

create or replace function forbid_update() returns trigger as $$
begin
  raise exception 'Editar registos de % não é permitido', tg_table_name;
end;
$$ language plpgsql;

create trigger audit_no_update before update on audit_log for each row execute function forbid_update();

-- updated_at automático
create trigger users_updated before update on users for each row execute function set_updated_at();
create trigger partners_updated before update on partners for each row execute function set_updated_at();
create trigger plans_updated before update on plans for each row execute function set_updated_at();
create trigger works_updated before update on works for each row execute function set_updated_at();
create trigger transactions_updated before update on transactions for each row execute function set_updated_at();
create trigger subscriptions_updated before update on subscriptions for each row execute function set_updated_at();
create trigger orders_updated before update on orders for each row execute function set_updated_at();
create trigger bot_conversations_updated before update on bot_conversations for each row execute function set_updated_at();
