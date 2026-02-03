import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  BuilderApiKeyCreds,
  buildHmacSignature,
} from '@polymarket/builder-signing-sdk';

const BUILDER_CREDENTIALS: BuilderApiKeyCreds = {
  key: process.env.POLYMARKET_BUILDER_API_KEY || '',
  secret: process.env.POLYMARKET_BUILDER_SECRET || '',
  passphrase: process.env.POLYMARKET_BUILDER_PASSPHRASE || '',
};

/**
 * Builder authentication endpoint for remote signing
 * Used for builder attribution in orders and relay transactions
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    try {
      const { method, path, body: requestBody } = req.body;

      if (
        !BUILDER_CREDENTIALS.key ||
        !BUILDER_CREDENTIALS.secret ||
        !BUILDER_CREDENTIALS.passphrase
      ) {
        return res.status(500).json({
          error: 'Builder credentials not configured. Set POLYMARKET_BUILDER_API_KEY, POLYMARKET_BUILDER_SECRET, and POLYMARKET_BUILDER_PASSPHRASE in environment variables',
        });
      }

      if (!method || !path || !requestBody) {
        return res.status(400).json({
          error: 'Missing required parameters: method, path, body',
        });
      }

      const sigTimestamp = Date.now().toString();

      const signature = buildHmacSignature(
        BUILDER_CREDENTIALS.secret,
        parseInt(sigTimestamp),
        method,
        path,
        requestBody
      );

      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({
        POLY_BUILDER_SIGNATURE: signature,
        POLY_BUILDER_TIMESTAMP: sigTimestamp,
        POLY_BUILDER_API_KEY: BUILDER_CREDENTIALS.key,
        POLY_BUILDER_PASSPHRASE: BUILDER_CREDENTIALS.passphrase,
      });
    } catch (error) {
      console.error('Signing error:', error);
      return res.status(500).json({
        error: 'Failed to sign message',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
