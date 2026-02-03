import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Wallet, providers } from 'ethers';
import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import type { UserOrder, UserMarketOrder } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { keccak256, getCreate2Address, encodePacked } from 'viem';

// Polymarket constants
const CLOB_API_URL = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

// Polymarket Polygon Proxy Contract Addresses
const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052' as const;
const PROXY_INIT_CODE_HASH = '0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b' as const;

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

function getSigningUrl(request: VercelRequest): string {
  const host = request.headers.host || 'localhost:3000';
  const protocol = host.startsWith('localhost') ? 'http' : 'https';
  return `${protocol}://${host}/api/polymarket/sign`;
}

function createClobClient(
  request: VercelRequest,
  wallet: Wallet,
  apiCredentials: { key: string; secret: string; passphrase: string },
  proxyAddress: string
): ClobClient {
  const builderConfig = new BuilderConfig({
    remoteBuilderConfig: { url: getSigningUrl(request) },
  });

  const clobClient = new ClobClient(
    CLOB_API_URL,
    POLYGON_CHAIN_ID,
    wallet,
    apiCredentials,
    1,
    proxyAddress,
    undefined,
    false,
    builderConfig
  );

  // Try to add browser-like headers via axios interceptor if possible
  // Note: This may not work as ClobClient uses axios internally and doesn't expose the instance
  // The real solution is client-side order placement (like the example) or contacting Polymarket to whitelist IPs
  
  return clobClient;
}

/**
 * Create and submit orders with builder attribution
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  const privateKey = process.env.POLYMARKET_MAGIC_PK;

  if (!privateKey) {
    return res.status(500).json({
      error: 'Wallet not configured. Set POLYMARKET_MAGIC_PK in environment variables',
    });
  }

  // GET - Fetch active orders
  if (req.method === 'GET') {
    try {
      const { apiCredentials, proxyAddress } = req.query;

      if (!apiCredentials || typeof apiCredentials !== 'string') {
        return res.status(400).json({
          error: 'Missing API credentials',
        });
      }

      let credentials: { key: string; secret: string; passphrase: string };
      try {
        credentials = JSON.parse(apiCredentials);
      } catch {
        return res.status(400).json({
          error: 'Invalid API credentials format',
        });
      }

      if (!credentials.key || !credentials.secret || !credentials.passphrase) {
        return res.status(400).json({
          error: 'Invalid API credentials',
        });
      }

      const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
      const wallet = new Wallet(privateKey, provider);
      const derivedProxyAddress = proxyAddress && typeof proxyAddress === 'string' 
        ? proxyAddress 
        : deriveProxyAddress(wallet.address.toLowerCase());

      console.log('[Orders API] Fetching active orders for proxy:', derivedProxyAddress);

      const clobClient = createClobClient(req, wallet, credentials, derivedProxyAddress);

      // Fetch all open orders
      const allOrders = await clobClient.getOpenOrders();
      console.log('[Orders API] Total open orders:', allOrders.length);

      // Filter orders by proxy address (maker_address)
      const userOrders = allOrders.filter((order: any) => {
        const orderMaker = (order.maker_address || '').toLowerCase();
        const proxyAddr = derivedProxyAddress.toLowerCase();
        return orderMaker === proxyAddr;
      });

      // Log order statuses for debugging
      const statusCounts: Record<string, number> = {};
      userOrders.forEach((order: any) => {
        const status = order.status || 'UNKNOWN';
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      });
      console.log('[Orders API] Order status breakdown:', statusCounts);

      // Show all orders (not just LIVE) so filled orders are visible
      // This includes LIVE, FILLED, PARTIALLY_FILLED, etc.
      const allUserOrders = userOrders;

      console.log('[Orders API] All user orders:', allUserOrders.length);

      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({
        success: true,
        orders: allUserOrders,
        count: allUserOrders.length,
      });
    } catch (error) {
      console.error('[Orders API] Error fetching orders:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to fetch orders',
      });
    }
  }

  // POST - Create order
  if (req.method === 'POST') {
    try {
      const body = req.body;
      const { order, apiCredentials, negRisk, isMarketOrder, tokenId, size, price, side } = body;

      if (!apiCredentials?.key || !apiCredentials?.secret || !apiCredentials?.passphrase) {
        return res.status(400).json({
          error: 'Missing API credentials',
        });
      }

      const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
      const wallet = new Wallet(privateKey, provider);
      const proxyAddress = deriveProxyAddress(wallet.address.toLowerCase());

      const clobClient = createClobClient(req, wallet, apiCredentials, proxyAddress);

      console.log('[Orders API] Creating order:', {
        tokenId,
        side,
        isMarketOrder,
        size,
        price: price || 'N/A (market)',
      });

      let response;

      if (order) {
        // Use provided order object (Fee Guard: pass postOnly when provided to avoid taker fee)
        const options: { negRisk: boolean; postOnly?: boolean } = { negRisk: negRisk ?? false };
        if (body.postOnly === true) options.postOnly = true;
        response = await clobClient.createAndPostOrder(
          order,
          options,
          OrderType.GTC
        );
      } else if (tokenId && size !== undefined && side) {
        const orderSide = side === 'BUY' ? Side.BUY : Side.SELL;

        // Fetch fee rate for the token
        let feeRateBps: number;
        try {
          feeRateBps = await clobClient.getFeeRateBps(tokenId);
          // Ensure fee rate is valid (default to 1000 if 0 or invalid)
          if (!feeRateBps || feeRateBps === 0) {
            console.warn(`Fee rate for token ${tokenId} is 0, using default 1000`);
            feeRateBps = 1000; // Default fee rate
          }
          console.log(`Using fee rate ${feeRateBps} for token ${tokenId}`);
        } catch (error) {
          console.warn('Failed to fetch fee rate, using default 1000:', error);
          feeRateBps = 1000; // Default fee rate
        }

        if (isMarketOrder) {
          // Market order (Fill or Kill) with builder attribution
          let marketAmount: number;

          if (orderSide === Side.BUY) {
            // For BUY market orders, size parameter is number of shares
            // Calculate dollar amount: shares * askPrice
            const priceResponse = await clobClient.getPrice(tokenId, Side.SELL);
            const askPrice = parseFloat(priceResponse.price);
            
            if (isNaN(askPrice) || askPrice <= 0 || askPrice >= 1) {
              return res.status(400).json({
                error: 'Unable to get valid market price',
              });
            }
            
            marketAmount = size * askPrice; // Convert shares to dollar amount
          } else {
            // For SELL market orders, amount is in shares
            marketAmount = size;
          }

          // Validate order parameters
          if (!tokenId || tokenId.trim() === '') {
            return res.status(400).json({
              error: 'Invalid token ID',
            });
          }
          
          if (!marketAmount || marketAmount <= 0 || isNaN(marketAmount)) {
            return res.status(400).json({
              error: `Invalid order amount: ${marketAmount}. Must be a positive number.`,
            });
          }
          
          if (marketAmount < 0.01) {
            return res.status(400).json({
              error: `Order amount too small: ${marketAmount}. Minimum order size is $0.01.`,
            });
          }

          const marketOrder: UserMarketOrder = {
            tokenID: tokenId,
            amount: marketAmount,
            side: orderSide,
            feeRateBps: feeRateBps,
          };

          console.log('[Orders API] Market order details:', {
            tokenID: marketOrder.tokenID,
            amount: marketOrder.amount,
            side: marketOrder.side,
            feeRateBps: marketOrder.feeRateBps,
            negRisk: negRisk ?? false,
            originalSize: size,
            orderSide: orderSide === Side.BUY ? 'BUY' : 'SELL',
          });

          // Retry logic for Cloudflare protection
          const maxRetries = 3;
          let lastError: any = null;
          
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              console.log(`[Orders API] Market order attempt ${attempt}/${maxRetries}`);
              
              response = await clobClient.createAndPostMarketOrder(
                marketOrder,
                { negRisk: negRisk ?? false },
                OrderType.FAK
              );
              
              console.log('[Orders API] Market order response:', {
                response: response,
                hasOrderID: !!response?.orderID,
                responseKeys: response ? Object.keys(response) : 'null',
                responseType: typeof response,
                responseStringified: JSON.stringify(response, null, 2),
              });
              
              // Check if response indicates an error
              if (response && (response.error || response.status === 'error' || (response.status && response.status !== 'success'))) {
                const errorMsg = response.error || response.message || 'Order submission returned error';
                console.error('[Orders API] Order submission returned error response:', {
                  error: errorMsg,
                  response: response,
                });
                
                // If it's not a Cloudflare block, throw the error
                if (attempt < maxRetries) {
                  // Treat as Cloudflare-like error and retry
                  console.warn(`[Orders API] Retrying due to error response (attempt ${attempt}/${maxRetries})`);
                  const delay = Math.pow(2, attempt) * 1000;
                  await new Promise(resolve => setTimeout(resolve, delay));
                  continue;
                } else {
                  throw new Error(errorMsg);
                }
              }
              
              // Success - break out of retry loop
              break;
            } catch (marketOrderError: any) {
              lastError = marketOrderError;
              
              // Check if it's a Cloudflare block
              const isCloudflareBlock = 
                marketOrderError?.response?.status === 403 ||
                marketOrderError?.status === 403 ||
                (typeof marketOrderError?.message === 'string' && 
                 marketOrderError.message.includes('Cloudflare')) ||
                (typeof marketOrderError?.data === 'string' && 
                 marketOrderError.data.includes('Cloudflare'));
              
              if (isCloudflareBlock) {
                console.warn(`[Orders API] Cloudflare block detected (attempt ${attempt}/${maxRetries})`);
                
                if (attempt < maxRetries) {
                  // Exponential backoff: 2s, 4s, 8s
                  const delay = Math.pow(2, attempt) * 1000;
                  console.log(`[Orders API] Retrying after ${delay}ms...`);
                  await new Promise(resolve => setTimeout(resolve, delay));
                  continue;
                } else {
                  // Last attempt failed
                  console.error('[Orders API] All retry attempts failed due to Cloudflare block');
                  throw new Error('Order submission blocked by Cloudflare protection. Please try again later or contact support.');
                }
              } else {
                // Non-Cloudflare error - throw immediately
                console.error('[Orders API] Market order creation error:', {
                  error: marketOrderError,
                  message: marketOrderError instanceof Error ? marketOrderError.message : 'Unknown error',
                  status: marketOrderError?.response?.status || marketOrderError?.status,
                  data: marketOrderError?.response?.data || marketOrderError?.data,
                });
                throw marketOrderError;
              }
            }
          }
          
          // If we exhausted retries and still no response
          if (!response && lastError) {
            throw lastError;
          }
        } else {
          // Limit order (Good Till Cancelled)
          if (!price) {
            return res.status(400).json({
              error: 'Price required for limit orders',
            });
          }

          const limitOrder: UserOrder = {
            tokenID: tokenId,
            price: price,
            size: size,
            side: orderSide,
            feeRateBps: feeRateBps,
            expiration: 0,
            taker: '0x0000000000000000000000000000000000000000',
          };

          // Fee Guard: use POST_ONLY for limit orders to avoid 3.15% taker fee (unless explicitly not postOnly)
          const limitOptions: { negRisk: boolean; postOnly?: boolean } = { negRisk: negRisk ?? false };
          if (body.postOnly !== false) limitOptions.postOnly = true;
          response = await clobClient.createAndPostOrder(
            limitOrder,
            limitOptions,
            OrderType.GTC
          );
        }
      } else {
        return res.status(400).json({
          error: 'Missing order parameters',
        });
      }

      // Check if response indicates an error before checking for order ID
      if (response && (response.error || response.status === 'error' || (response.status && response.status !== 'success' && response.status !== 200))) {
        const errorMsg = response.error || response.message || 'Order submission failed';
        console.error('[Orders API] Order submission returned error:', {
          error: errorMsg,
          response: response,
          tokenId,
          side,
          isMarketOrder,
        });
        
        return res.status(500).json({
          error: errorMsg,
          details: response.details || `Order submission failed. Response: ${JSON.stringify(response)}`,
          status: response.status,
        });
      }
      
      // Check for order ID in various possible fields
      const orderId = response?.orderID || response?.order_id || response?.id || response?.orderId;
      
      if (orderId) {
        console.log('[Orders API] Order created successfully:', {
          orderId: orderId,
          tokenId,
          side,
          orderType: isMarketOrder ? 'MARKET (FOK)' : 'LIMIT (GTC)',
          responseStructure: Object.keys(response || {}),
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).json({
          success: true,
          orderId: orderId,
        });
      } else {
        // Log the full response for debugging
        console.error('[Orders API] Order submission failed - no order ID returned:', {
          response: response,
          responseType: typeof response,
          responseKeys: response ? Object.keys(response) : 'null',
          responseStringified: JSON.stringify(response, null, 2),
          tokenId,
          side,
          isMarketOrder,
        });
        
        // Extract error message from response if available
        const errorMsg = response?.error || response?.message || 'Order submission failed - no order ID returned';
        const errorDetails = response?.details || (response ? `Response received but no order ID found. Response keys: ${Object.keys(response).join(', ')}` : 'No response received');
        
        return res.status(500).json({
          error: errorMsg,
          details: errorDetails,
          status: response?.status,
        });
      }
    } catch (error: any) {
      console.error('[Orders API] Order creation error:', {
        error: error,
        message: error instanceof Error ? error.message : 'Unknown error',
        status: error?.response?.status || error?.status,
        statusText: error?.response?.statusText || error?.statusText,
        isCloudflareBlock: error?.response?.status === 403 || error?.status === 403,
        errorData: error?.response?.data || error?.data,
        errorStack: error instanceof Error ? error.stack : undefined,
      });
      
      // Check for Cloudflare block
      if (error?.response?.status === 403 || error?.status === 403) {
        return res.status(503).json({
          error: 'Service temporarily unavailable',
          details: 'Request blocked by Cloudflare protection. This may be due to rate limiting or bot detection. Please try again in a few moments.',
          retryAfter: 60, // Suggest retry after 60 seconds
        });
      }
      
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to create order',
        details: error?.response?.data ? (typeof error.response.data === 'string' ? error.response.data.substring(0, 200) : JSON.stringify(error.response.data).substring(0, 200)) : undefined,
      });
    }
  }

  // DELETE - Cancel order
  if (req.method === 'DELETE') {
    try {
      const { orderId, apiCredentials } = req.body;

      if (!orderId) {
        return res.status(400).json({
          error: 'Missing order ID',
        });
      }

      if (!apiCredentials?.key || !apiCredentials?.secret || !apiCredentials?.passphrase) {
        return res.status(400).json({
          error: 'Missing API credentials',
        });
      }

      const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
      const wallet = new Wallet(privateKey, provider);
      const proxyAddress = deriveProxyAddress(wallet.address.toLowerCase());

      const clobClient = createClobClient(req, wallet, apiCredentials, proxyAddress);

      console.log('[Orders API] Cancelling order:', orderId);

      await clobClient.cancelOrder({ orderID: orderId });

      console.log('[Orders API] Order cancelled successfully:', orderId);

      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Order cancellation error:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to cancel order',
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
