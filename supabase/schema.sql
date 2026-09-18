-- Uçuş fiyat takip botu için Supabase tabloları
-- Bunu Supabase Dashboard > SQL Editor içine yapıştırıp çalıştır.
--
-- NOT: Daha önce eski şemayı (tek "lowest_price" kolonlu) çalıştırdıysan, önce şunu çalıştır:
--   alter table routes drop column if exists lowest_price;
--   alter table routes add column if not exists lowest_price_direct numeric;
--   alter table routes add column if not exists lowest_price_connecting numeric;
--   alter table price_history add column if not exists is_direct boolean not null default true;

create table if not exists routes (
  id bigint generated always as identity primary key,
  chat_id bigint not null,              -- Telegram sohbet ID'si (bildirim kime gidecek)
  origin text not null,                  -- Kalkış havalimanı kodu, örn: IST
  destination text not null,             -- Varış havalimanı kodu, örn: BEG
  depart_date date not null,             -- Gidiş tarihi
  return_date date,                      -- Dönüş tarihi (tek yön ise boş bırakılır)
  currency text default 'USD',
  lowest_price_direct numeric,           -- Şu ana kadar görülen en düşük DİREKT uçuş fiyatı
  lowest_price_connecting numeric,       -- Şu ana kadar görülen en düşük AKTARMALI uçuş fiyatı
  active boolean default true,           -- false yapılınca takip durur (silme yerine)
  created_at timestamptz default now(),
  last_checked_at timestamptz,
  last_error text                        -- son kontrolde hata olduysa burada tutulur
);

create table if not exists price_history (
  id bigint generated always as identity primary key,
  route_id bigint references routes(id) on delete cascade,
  price numeric not null,
  currency text,
  is_direct boolean not null,            -- true: direkt uçuş fiyatı, false: aktarmalı
  checked_at timestamptz default now()
);

-- Sık sorgulanan kolonlar için index
create index if not exists idx_routes_active on routes(active);
create index if not exists idx_price_history_route on price_history(route_id);
