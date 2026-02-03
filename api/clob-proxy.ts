import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  // Get query parameters
  const { side, token_id } = req.query;

  if (!side || !token_id) {
    return res.status(400).json({
      error: 'Missing required parameters: side and token_id',
    });
  }

  // Construct the CLOB API URL
  const url = `https://clob.polymarket.com/price?side=${side}&token_id=${token_id}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `CLOB API returned ${response.status}`,
        status: response.status,
      });
    }

    const data = await response.json();
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    return res.status(200).json(data);
  } catch (error) {
    console.error('CLOB proxy error:', error);
    return res.status(500).json({
      error: 'Failed to fetch from CLOB API',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
