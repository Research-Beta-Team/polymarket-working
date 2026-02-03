/**
 * Initialize browser ClobClient for client-side order placement
 * This bypasses Cloudflare by making requests from the user's browser IP
 */

import { createBrowserClobClient } from './clob-client-browser';

/**
 * Initialize browser ClobClient after wallet connection and API credentials are obtained
 */
export async function initializeBrowserClobClient(
  privateKey: string,
  apiCredentials: { key: string; secret: string; passphrase: string },
  proxyAddress: string
): Promise<any> {
  try {
    // Get signing URL (remote builder signing endpoint)
    const protocol = window.location.protocol;
    const host = window.location.host;
    const signingUrl = `${protocol}//${host}/api/polymarket/sign`;

    console.log('[Browser ClobClient] Initializing...', {
      proxyAddress,
      signingUrl,
      hasCredentials: !!apiCredentials.key,
    });

    // Create ClobClient in browser - requests come from user's IP, not serverless function IP
    const clobClient = createBrowserClobClient(
      privateKey,
      apiCredentials,
      proxyAddress,
      signingUrl
    );

    console.log('[Browser ClobClient] ✅ Initialized successfully');
    return clobClient;
  } catch (error) {
    console.error('[Browser ClobClient] ❌ Initialization failed:', error);
    throw error;
  }
}
