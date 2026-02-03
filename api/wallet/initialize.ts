import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Wallet, providers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';

// Polymarket constants
const CLOB_API_URL = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

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
    const privateKey = process.env.POLYMARKET_MAGIC_PK;

    if (!privateKey) {
      return res.status(500).json({
        error: 'Wallet not configured. Set POLYMARKET_MAGIC_PK in environment variables',
      });
    }

    try {
      const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
      const wallet = new Wallet(privateKey, provider);
      const clobClient = new ClobClient(CLOB_API_URL, POLYGON_CHAIN_ID, wallet);

      // Step 1: Try to derive existing API credentials
      let apiCredentials;
      try {
        const derivedCreds = await clobClient.deriveApiKey();
        if (derivedCreds?.key && derivedCreds?.secret && derivedCreds?.passphrase) {
          console.log('Successfully derived existing User API Credentials');
          apiCredentials = derivedCreds;
        }
      } catch (error) {
        console.log('Failed to derive existing User API Credentials, creating new ones...');
      }

      // Step 2: Create new credentials if derivation failed
      if (!apiCredentials) {
        console.log('Creating new User API Credentials...');
        apiCredentials = await clobClient.createApiKey();
        console.log('Successfully created new User API Credentials');
      }

      if (!apiCredentials?.key || !apiCredentials?.secret || !apiCredentials?.passphrase) {
        return res.status(500).json({
          error: 'Failed to create API credentials',
        });
      }

      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({
        success: true,
        credentials: {
          key: apiCredentials.key,
          secret: apiCredentials.secret,
          passphrase: apiCredentials.passphrase,
        },
        message: 'Trading session initialized successfully',
      });
    } catch (error) {
      console.error('Trading session initialization error:', error);
      return res.status(500).json({
        error: 'Failed to initialize trading session',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
