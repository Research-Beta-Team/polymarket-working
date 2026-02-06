import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Map DB row to Position shape (camelCase) */
function rowToPosition(row: Record<string, unknown>) {
  const filledOrders = row.filled_orders as Array<{ orderId: string; price: number; size: number; timestamp: number }> | null;
  return {
    id: row.id,
    eventSlug: row.event_slug,
    tokenId: row.token_id,
    side: row.side,
    entryPrice: Number(row.entry_price),
    size: Number(row.size),
    currentPrice: row.current_price != null ? Number(row.current_price) : undefined,
    direction: (row.direction as 'UP' | 'DOWN') ?? undefined,
    filledOrders: filledOrders ?? undefined,
    sharesRemaining: row.shares_remaining != null ? Number(row.shares_remaining) : undefined,
    entryTimestamp: Number(row.entry_timestamp),
  };
}

/** Map Position to DB row (snake_case) */
function positionToRow(p: Record<string, unknown>, walletAddress: string) {
  return {
    id: p.id,
    wallet_address: walletAddress,
    event_slug: p.eventSlug,
    token_id: p.tokenId,
    side: p.side,
    entry_price: p.entryPrice,
    size: p.size,
    current_price: (p as any).currentPrice ?? null,
    direction: (p as any).direction ?? null,
    filled_orders: (p as any).filledOrders ?? null,
    shares_remaining: (p as any).sharesRemaining ?? null,
    entry_timestamp: (p as any).entryTimestamp,
  };
}

/**
 * GET /api/bot-positions?walletAddress=0x...
 *   Returns stored positions for the wallet. Restores bot state on load.
 * POST /api/bot-positions
 *   Body: { positions: Position[], walletAddress: string }. Replaces stored positions for that wallet.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    if (req.method === 'GET') return res.status(200).json([]);
    if (req.method === 'POST') return res.status(201).json({ ok: true });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const walletAddress = (req.method === 'GET'
    ? typeof req.query.walletAddress === 'string' ? req.query.walletAddress.trim() : ''
    : (req.body as { walletAddress?: string })?.walletAddress?.trim() ?? '');

  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: 'Missing or invalid walletAddress (0x + 40 hex)' });
  }

  const wallet = walletAddress.toLowerCase();

  try {
    if (req.method === 'GET') {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(200).json([]);
      }
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data, error } = await supabase
        .from('bot_positions')
        .select('*')
        .eq('wallet_address', wallet);

      if (error) {
        console.error('[BotPositions API]', error);
        return res.status(500).json({ error: error.message });
      }
      const positions = (data || []).map(rowToPosition);
      return res.status(200).json(positions);
    }

    if (req.method === 'POST') {
      const positions = (req.body as { positions?: unknown[] }).positions ?? [];
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(201).json({ ok: true });
      }
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await supabase.from('bot_positions').delete().eq('wallet_address', wallet);
      if (positions.length > 0) {
        const rows = positions.map((p) => positionToRow(p as Record<string, unknown>, wallet));
        const { error } = await supabase.from('bot_positions').insert(rows);
        if (error) {
          console.error('[BotPositions API] insert', error);
          return res.status(500).json({ error: error.message });
        }
      }
      return res.status(201).json({ ok: true });
    }
  } catch (err) {
    console.error('[BotPositions API]', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
  }
}
