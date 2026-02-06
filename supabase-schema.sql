-- Run this in Supabase SQL Editor to create all tables for the Polymarket bot.
-- Ensures state (trades, positions, strategy) remains consistent across refresh and devices.

-- 1) Trade history per wallet
create table if not exists public.trades (
  id text primary key,
  event_slug text not null,
  token_id text not null,
  side text not null check (side in ('BUY', 'SELL')),
  size numeric not null,
  price numeric not null,
  "timestamp" bigint not null,
  status text not null default 'filled',
  transaction_hash text,
  profit numeric,
  reason text not null,
  order_type text not null check (order_type in ('LIMIT', 'MARKET')),
  limit_price numeric,
  direction text check (direction in ('UP', 'DOWN')),
  wallet_address text not null,
  created_at timestamptz default now()
);
create index if not exists idx_trades_wallet_timestamp on public.trades (wallet_address, "timestamp" desc);
comment on table public.trades is 'Trade history per wallet (proxy address).';

-- 2) Bot positions per wallet (so after refresh the bot still knows what it holds)
create table if not exists public.bot_positions (
  id text not null,
  wallet_address text not null,
  event_slug text not null,
  token_id text not null,
  side text not null check (side in ('BUY', 'SELL')),
  entry_price numeric not null,
  size numeric not null,
  current_price numeric,
  direction text check (direction in ('UP', 'DOWN')),
  filled_orders jsonb,
  shares_remaining numeric,
  entry_timestamp bigint not null,
  created_at timestamptz default now(),
  primary key (wallet_address, id)
);
create index if not exists idx_bot_positions_wallet on public.bot_positions (wallet_address);
comment on table public.bot_positions is 'Open positions per wallet; restored on load so exit logic (stop loss, profit target) is correct.';

-- 3) Strategy config per wallet (same strategy across devices)
create table if not exists public.strategy_config (
  wallet_address text primary key,
  config jsonb not null default '{}',
  updated_at timestamptz default now()
);
comment on table public.strategy_config is 'Strategy settings per wallet (entry price, stop loss, trade size, etc.).';
