import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Wallet, providers } from 'ethers';
import { keccak256, getCreate2Address, encodePacked } from 'viem';

// Polymarket Polygon Proxy Contract Addresses
const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052' as const;
const PROXY_INIT_CODE_HASH = '0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b' as const;

// Polygon RPC URL
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

/**
 * Derive Polymarket Non-Safe Proxy Wallet address from EOA address
 * Uses CREATE2 deterministic address generation
 */
function deriveProxyAddress(eoaAddress: string): string {
  try {
    return getCreate2Address({
      bytecodeHash: PROXY_INIT_CODE_HASH,
      from: PROXY_FACTORY,
      salt: keccak256(encodePacked(['address'], [eoaAddress.toLowerCase() as `0x${string}`])),
    });
  } catch (error) {
    console.error('[deriveProxyAddress] Error:', error);
    throw new Error(`Failed to derive proxy address: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Set CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'GET') {
      // Get wallet info (EOA and proxy addresses)
      const privateKey = process.env.POLYMARKET_MAGIC_PK;

      if (!privateKey) {
        console.error('[Wallet API] POLYMARKET_MAGIC_PK not set');
        return res.status(500).json({
          error: 'Wallet not configured. Set POLYMARKET_MAGIC_PK in environment variables',
        });
      }

      try {
        console.log('[Wallet API] Starting wallet derivation...');
        console.log('[Wallet API] POLYGON_RPC_URL:', POLYGON_RPC_URL);
        
        const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
        const wallet = new Wallet(privateKey, provider);
        const eoaAddress = wallet.address;
        
        console.log('[Wallet API] EOA Address derived:', eoaAddress);
        
        // Derive proxy address
        const proxyAddress = deriveProxyAddress(eoaAddress.toLowerCase());
        console.log('[Wallet API] Proxy Address derived:', proxyAddress);

        return res.status(200).json({ 
          eoaAddress, 
          proxyAddress,
          success: true 
        });
      } catch (error) {
        console.error('[Wallet API] Error during wallet derivation:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorStack = error instanceof Error ? error.stack : undefined;
        console.error('[Wallet API] Error details:', { message: errorMessage, stack: errorStack });
        
        // Provide more specific error messages
        let userFriendlyError = 'Failed to derive wallet info';
        if (errorMessage.includes('Cannot find module') || errorMessage.includes('Module not found')) {
          userFriendlyError = 'Missing dependency. Ensure viem package is installed.';
        } else if (errorMessage.includes('invalid private key') || errorMessage.includes('invalid hex')) {
          userFriendlyError = 'Invalid private key format. Check POLYMARKET_MAGIC_PK environment variable.';
        } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('network')) {
          userFriendlyError = 'Network error. Check POLYGON_RPC_URL configuration.';
        }
        
        return res.status(500).json({
          error: userFriendlyError,
          message: errorMessage,
          details: process.env.NODE_ENV === 'development' ? errorStack : undefined,
        });
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    // Catch any unexpected errors (e.g., import errors)
    console.error('[Wallet API] Unexpected error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({
      error: 'Server error',
      message: errorMessage,
    });
  }
}
