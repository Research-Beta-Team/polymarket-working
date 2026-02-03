import { ClobClient } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { Wallet, providers } from 'ethers';

// Polymarket constants
const CLOB_API_URL = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

/**
 * Create a browser-based ClobClient for order placement
 * This bypasses Cloudflare by making requests from the user's browser IP
 * 
 * @param privateKey - Private key for wallet (from environment or user's wallet)
 * @param apiCredentials - User API credentials (key, secret, passphrase)
 * @param proxyAddress - Proxy wallet address (funder)
 * @param signingUrl - URL for remote builder signing endpoint
 * @returns Initialized ClobClient instance
 */
export function createBrowserClobClient(
  privateKey: string,
  apiCredentials: { key: string; secret: string; passphrase: string },
  proxyAddress: string,
  signingUrl: string
): ClobClient {
  // Create ethers provider and wallet in browser
  const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
  const wallet = new Wallet(privateKey, provider);

  // Create builder config for remote signing
  const builderConfig = new BuilderConfig({
    remoteBuilderConfig: {
      url: signingUrl,
    },
  });

  // Create ClobClient in browser - requests come from user's IP, not serverless function IP
  const clobClient = new ClobClient(
    CLOB_API_URL,
    POLYGON_CHAIN_ID,
    wallet,
    apiCredentials,
    1, // signatureType = 1 for EOA
    proxyAddress,
    undefined,
    false,
    builderConfig // Builder attribution via remote signing
  );

  console.log('[Browser ClobClient] Initialized in browser:', {
    walletAddress: wallet.address,
    proxyAddress,
    signingUrl,
  });

  return clobClient;
}
