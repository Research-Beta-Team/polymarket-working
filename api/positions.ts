import type { VercelRequest, VercelResponse } from '@vercel/node';

const DATA_API_URL = 'https://data-api.polymarket.com';

/**
 * GET /api/positions?proxyAddress=0x...
 * Fetches active positions from Polymarket Data API for the given proxy wallet.
 * No auth required; Data API is public.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { proxyAddress } = req.query;

    if (!proxyAddress || typeof proxyAddress !== 'string') {
      return res.status(400).json({
        error: 'Missing proxyAddress query parameter',
      });
    }

    const user = proxyAddress.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(user)) {
      return res.status(400).json({
        error: 'Invalid proxyAddress (expected 0x-prefixed 40 hex chars)',
      });
    }

    const url = `${DATA_API_URL}/positions?user=${encodeURIComponent(user)}&limit=500`;
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      console.error('[Positions API] Data API error:', response.status, text);
      return res.status(response.status).json({
        error: `Polymarket Data API error: ${response.status}`,
      });
    }

    const positions = await response.json();

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      success: true,
      positions: Array.isArray(positions) ? positions : [],
      count: Array.isArray(positions) ? positions.length : 0,
    });
  } catch (error) {
    console.error('[Positions API] Error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch positions',
    });
  }
}
