import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Get private key for browser ClobClient initialization
 * WARNING: This exposes the private key to the client. In production, consider:
 * 1. Using a browser wallet extension (MetaMask, WalletConnect, etc.)
 * 2. Using Magic Link or similar service
 * 3. Implementing proper authentication before returning the key
 * 
 * For now, this is a simple endpoint that returns the private key.
 * In production, you should:
 * - Add authentication/authorization
 * - Use HTTPS only
 * - Consider using a different wallet management approach
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    const privateKey = process.env.POLYMARKET_MAGIC_PK;

    if (!privateKey) {
      return res.status(500).json({
        error: 'Private key not configured',
      });
    }

    // WARNING: Exposing private key to client
    // In production, use a browser wallet extension instead
    return res.status(200).json({
      privateKey,
      warning: 'This endpoint exposes the private key. Consider using a browser wallet extension in production.',
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
