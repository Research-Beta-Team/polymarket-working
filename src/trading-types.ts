export interface StrategyConfig {
  enabled: boolean;
  // Entry price for limit order (0-100 scale for Polymarket binary markets)
  entryPrice: number; // e.g., 96
  // Profit target price (0-100 scale)
  profitTargetPrice: number; // e.g., 100
  // Stop loss price (0-100 scale)
  stopLossPrice: number; // e.g., 91
  // Trade size: amount in USD or in shares depending on tradeSizeUnit
  tradeSize: number;
  // Unit for tradeSize: 'USD' (default) or 'shares'
  tradeSizeUnit?: 'USD' | 'shares';
  // Price Difference (in USD) - Strategy only activates when |Price to Beat - Current BTC Price| >= this value
  priceDifference?: number | null;
  // Flip Guard: cancel pending entry bids when price distance (USD) drops below this
  flipGuardPendingDistanceUsd?: number; // default 15
  // Flip Guard: emergency market sell when filled and price distance (USD) drops below this
  flipGuardFilledDistanceUsd?: number; // default 5
  // Entry only when time remaining until event end is less than this (seconds)
  entryTimeRemainingMaxSeconds?: number; // default 180 (3 min)
}

export interface Trade {
  id: string;
  eventSlug: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number; // Price in 0-100 scale
  timestamp: number;
  status: 'pending' | 'filled' | 'failed' | 'cancelled';
  transactionHash?: string;
  profit?: number;
  reason: string; // Why the trade was executed
  orderType: 'LIMIT' | 'MARKET';
  limitPrice?: number; // Limit price if orderType is LIMIT
  direction?: 'UP' | 'DOWN'; // Direction determined automatically (UP = YES token, DOWN = NO token)
}

export interface Position {
  id: string; // Unique position ID
  eventSlug: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  entryPrice: number; // Entry price in 0-100 scale
  size: number; // Position size in USD
  currentPrice?: number; // Price in 0-100 scale
  unrealizedProfit?: number;
  direction?: 'UP' | 'DOWN'; // Direction (UP = YES token, DOWN = NO token)
  filledOrders?: Array<{
    orderId: string;
    price: number; // Fill price in 0-100 scale
    size: number; // Size in USD
    timestamp: number;
  }>; // Track individual filled orders for large positions
  /** Remaining shares after a partial sell; when set, used for sell size instead of recalc from filledOrders */
  sharesRemaining?: number;
  entryTimestamp: number; // When position was entered
}

export interface TradingStatus {
  isActive: boolean;
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalProfit: number;
  pendingLimitOrders: number;
  positions: Position[]; // Array of positions (changed from single currentPosition)
  totalPositionSize?: number; // Total size across all positions
  walletBalance?: number; // Current wallet balance
  maxPositionSize?: number; // 50% of wallet balance
  // Keep currentPosition for backward compatibility during transition
  currentPosition?: {
    eventSlug: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    entryPrice: number;
    size: number;
    currentPrice?: number;
    unrealizedProfit?: number;
    direction?: 'UP' | 'DOWN';
    filledOrders?: Array<{
      orderId: string;
      price: number;
      size: number;
      timestamp: number;
    }>;
  };
}

export interface TradeExecutionResult {
  success: boolean;
  trade?: Trade;
  error?: string;
  transactionHash?: string;
}
