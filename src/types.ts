export type DataSource = 'chainlink';

export type AssetType = 'btc' | 'eth' | 'sol' | 'xrp';

export const ASSET_CONFIG: Record<AssetType, { name: string; symbol: string; displayName: string }> = {
  btc: { name: 'Bitcoin', symbol: 'btc/usd', displayName: 'BTC' },
  eth: { name: 'Ethereum', symbol: 'eth/usd', displayName: 'ETH' },
  sol: { name: 'Solana', symbol: 'sol/usd', displayName: 'SOL' },
  xrp: { name: 'Ripple', symbol: 'xrp/usd', displayName: 'XRP' },
};

export interface SubscriptionMessage {
  action: 'subscribe' | 'unsubscribe';
  subscriptions: Array<{
    topic: string;
    type: string;
    filters?: string;
  }>;
}

export interface PriceUpdate {
  topic: string;
  type: string;
  timestamp: number;
  payload: {
    symbol: string;
    timestamp: number;
    value: number;
  };
}

export interface ConnectionStatus {
  connected: boolean;
  source: DataSource | null;
  lastUpdate: number | null;
  error: string | null;
}
