import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * GET /api/strategy?walletAddress=0x...
 *   Returns stored strategy config for the wallet. Used to restore strategy on load.
 * POST /api/strategy
 *   Body: { config: StrategyConfig, walletAddress: string }. Saves strategy for that wallet.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    if (req.method === 'GET') return res.status(200).json(null);
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
        return res.status(200).json(null);
      }
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data, error } = await supabase
        .from('strategy_config')
        .select('config')
        .eq('wallet_address', wallet)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('[Strategy API]', error);
        return res.status(500).json({ error: error.message });
      }
      return res.status(200).json(data?.config ?? null);
    }

    if (req.method === 'POST') {
      const config = (req.body as { config?: Record<string, unknown> }).config;
      if (!config || typeof config !== 'object') {
        return res.status(400).json({ error: 'Body must include config object' });
      }
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(201).json({ ok: true });
      }
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { error } = await supabase
        .from('strategy_config')
        .upsert({ wallet_address: wallet, config, updated_at: new Date().toISOString() }, { onConflict: 'wallet_address' });

      if (error) {
        console.error('[Strategy API] upsert', error);
        return res.status(500).json({ error: error.message });
      }
      return res.status(201).json({ ok: true });
    }
  } catch (err) {
    console.error('[Strategy API]', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
  }
}
