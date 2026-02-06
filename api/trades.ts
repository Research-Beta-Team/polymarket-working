import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Map DB row to Trade shape (camelCase) for frontend */
function rowToTrade(row: Record<string, unknown>) {
  return {
    id: row.id,
    eventSlug: row.event_slug,
    tokenId: row.token_id,
    side: row.side,
    size: Number(row.size),
    price: Number(row.price),
    timestamp: Number(row.timestamp),
    status: row.status,
    transactionHash: row.transaction_hash ?? undefined,
    profit: row.profit != null ? Number(row.profit) : undefined,
    reason: row.reason,
    orderType: row.order_type,
    limitPrice: row.limit_price != null ? Number(row.limit_price) : undefined,
    direction: row.direction ?? undefined,
  };
}

/** Map frontend Trade to DB row (snake_case) */
function tradeToRow(trade: Record<string, unknown>, walletAddress: string) {
  return {
    id: trade.id,
    event_slug: trade.eventSlug,
    token_id: trade.tokenId,
    side: trade.side,
    size: trade.size,
    price: trade.price,
    timestamp: trade.timestamp,
    status: trade.status,
    transaction_hash: trade.transactionHash ?? null,
    profit: trade.profit ?? null,
    reason: trade.reason,
    order_type: trade.orderType,
    limit_price: trade.limitPrice ?? null,
    direction: trade.direction ?? null,
    wallet_address: walletAddress,
  };
}

/**
 * GET /api/trades?walletAddress=0x...
 *   Returns stored trades for the given wallet (proxy address). Restores trade history on load.
 * POST /api/trades
 *   Body: { trade: Trade, walletAddress: string }. Stores a single trade (Supabase).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[Trades API] Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    if (req.method === 'GET') return res.status(200).json([]);
    if (req.method === 'POST') return res.status(201).json({ ok: true });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (req.method === 'GET') {
      const walletAddress = typeof req.query.walletAddress === 'string' ? req.query.walletAddress.trim() : '';
      if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
        return res.status(400).json({ error: 'Missing or invalid walletAddress (0x + 40 hex chars)' });
      }

      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(200).json([]);
      }

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .eq('wallet_address', walletAddress.toLowerCase())
        .order('timestamp', { ascending: true });

      if (error) {
        console.error('[Trades API] Supabase error:', error);
        return res.status(500).json({ error: error.message });
      }

      const trades = (data || []).map(rowToTrade);
      return res.status(200).json(trades);
    }

    if (req.method === 'POST') {
      const body = req.body as { trade?: Record<string, unknown>; walletAddress?: string };
      const trade = body?.trade;
      const walletAddress = typeof body?.walletAddress === 'string' ? body.walletAddress.trim() : '';

      if (!trade || !walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
        return res.status(400).json({ error: 'Body must include trade and walletAddress (0x + 40 hex)' });
      }

      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(201).json({ ok: true });
      }

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const row = tradeToRow(trade, walletAddress.toLowerCase());

      const { error } = await supabase.from('trades').upsert(row, {
        onConflict: 'id',
      });

      if (error) {
        console.error('[Trades API] Supabase insert error:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.status(201).json({ ok: true });
    }
  } catch (err) {
    console.error('[Trades API] Error:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
}
