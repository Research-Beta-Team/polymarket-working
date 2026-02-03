import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Wallet, providers, Contract } from 'ethers';
import { keccak256, getCreate2Address, encodePacked } from 'viem';

// Polymarket Polygon Proxy Contract Addresses
const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052' as const;
const PROXY_INIT_CODE_HASH = '0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b' as const;

// Polygon RPC URL and USDC.e address
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/**
 * Derive Polymarket Non-Safe Proxy Wallet address from EOA address
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

// Minimal ERC20 ABI for balanceOf
const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: '_owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    type: 'function',
  },
];

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

  if (req.method === 'GET') {
    const privateKey = process.env.POLYMARKET_MAGIC_PK;

    if (!privateKey) {
      return res.status(500).json({
        error: 'Wallet not configured. Set POLYMARKET_MAGIC_PK in environment variables',
      });
    }

    try {
      const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
      const wallet = new Wallet(privateKey, provider);
      
      // Get proxy address using proper derivation
      const eoaAddress = wallet.address;
      const proxyAddress = deriveProxyAddress(eoaAddress.toLowerCase());

      // Get USDC.e balance
      const usdcContract = new Contract(USDC_E_ADDRESS, ERC20_ABI, provider);
      const balance = await usdcContract.balanceOf(proxyAddress);
      
      // USDC.e has 6 decimals
      const balanceFormatted = parseFloat(balance.toString()) / 1e6;

      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({
        balance: balanceFormatted,
        balanceRaw: balance.toString(),
        address: proxyAddress,
        currency: 'USDC.e',
      });
    } catch (error) {
      console.error('Balance fetch error:', error);
      return res.status(500).json({
        error: 'Failed to fetch balance',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
