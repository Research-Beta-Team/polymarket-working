import type { DataSource, SubscriptionMessage, PriceUpdate, ConnectionStatus } from './types';
import { ASSET_CONFIG } from './types';

const WS_ENDPOINT = 'wss://ws-live-data.polymarket.com';
const PING_INTERVAL = 5000; // 5 seconds

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private pingInterval: number | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private currentSource: DataSource | null = null;
  private onPriceUpdate: ((update: PriceUpdate) => void) | null = null;
  private onStatusChange: ((status: ConnectionStatus) => void) | null = null;

  constructor() {
    this.connect = this.connect.bind(this);
    this.disconnect = this.disconnect.bind(this);
  }

  setCallbacks(
    onPriceUpdate: (update: PriceUpdate) => void,
    onStatusChange: (status: ConnectionStatus) => void
  ) {
    this.onPriceUpdate = onPriceUpdate;
    this.onStatusChange = onStatusChange;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.disconnect();
    this.currentSource = 'chainlink';

    try {
      this.ws = new WebSocket(WS_ENDPOINT);
      this.setupWebSocketHandlers();
    } catch (error) {
      this.handleError(`Failed to connect: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private setupWebSocketHandlers(): void {
    if (!this.ws) return;

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.startPingInterval();
      this.subscribe();
      this.updateStatus({
        connected: true,
        source: this.currentSource,
        lastUpdate: null,
        error: null
      });
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // Handle ping/pong
        if (data.type === 'pong') {
          return;
        }

        // Handle price updates
        if (data.topic === 'crypto_prices_chainlink') {
          if (this.onPriceUpdate) {
            this.onPriceUpdate(data as PriceUpdate);
          }
          this.updateStatus({
            connected: true,
            source: this.currentSource,
            lastUpdate: Date.now(),
            error: null
          });
        }
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    };

    this.ws.onerror = () => {
      this.handleError('WebSocket error occurred');
    };

    this.ws.onclose = () => {
      this.stopPingInterval();
      this.updateStatus({
        connected: false,
        source: this.currentSource,
        lastUpdate: null,
        error: null
      });
      this.attemptReconnect();
    };
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Subscribe to all asset price feeds
    const subscriptions = Object.values(ASSET_CONFIG).map(asset => ({
      topic: 'crypto_prices_chainlink',
      type: '*',
      filters: `{"symbol":"${asset.symbol}"}`
    }));

    const subscription: SubscriptionMessage = {
      action: 'subscribe',
      subscriptions
    };

    this.ws.send(JSON.stringify(subscription));
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL);
  }

  private stopPingInterval(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.handleError('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    setTimeout(() => {
      this.connect();
    }, this.reconnectDelay * this.reconnectAttempts);
  }

  private handleError(message: string): void {
    this.updateStatus({
      connected: false,
      source: this.currentSource,
      lastUpdate: null,
      error: message
    });
  }

  private updateStatus(status: ConnectionStatus): void {
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }

  disconnect(): void {
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.currentSource = null;
    this.reconnectAttempts = 0;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

