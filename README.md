# Polymarket 15m Up/Down Trading Bot

Trading bot for Polymarket 15-minute BTC (and multi-asset) Up/Down markets. Connects to Polymarket RTDS for prices, places POST_ONLY limit orders for entry and profit target, with Flip Guard and auto-redemption for resolved markets.

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
