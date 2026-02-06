# Polymarket 15m Up/Down Trading Bot

Trading bot for Polymarket 15-minute BTC (and multi-asset) Up/Down markets. Connects to Polymarket RTDS for prices, places POST_ONLY limit orders for entry and profit target, with Flip Guard and auto-redemption for resolved markets.

## Push to a new GitHub repo

1. On GitHub: **New repository** (e.g. `polymarket-bot`). Do **not** add a README, .gitignore, or license.
2. Locally, add the remote and push:

```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

Use your repo URL in place of `YOUR_USERNAME/YOUR_REPO_NAME`. If you use SSH: `git@github.com:YOUR_USERNAME/YOUR_REPO_NAME.git`.

## Setup

```bash
npm install
```

## Run locally

```bash
npm run dev
```

## Deploy on Vercel

1. Push this repo to a new GitHub repository.
2. In [Vercel](https://vercel.com), import the GitHub repo.
3. Add environment variables in Vercel project settings (e.g. `POLYMARKET_MAGIC_PK`, `POLYGON_RPC_URL` if needed). Do not commit `.env`.
4. Deploy. Vercel will use `buildCommand: npm run build` and `outputDirectory: dist` from `vercel.json`.

## Env (optional)

- `POLYMARKET_MAGIC_PK` – Wallet private key (for server-side APIs; keep secret).
- `POLYGON_RPC_URL` – Polygon RPC (defaults to public endpoint if unset).
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` – Optional. When set, the bot stores **trades**, **positions**, and **strategy config** in Supabase so state stays consistent across refresh and devices: History tab persists, open positions are restored (stop loss / profit target work correctly), and strategy is the same per wallet. Run `supabase-schema.sql` in the Supabase SQL Editor to create the `trades`, `bot_positions`, and `strategy_config` tables.
