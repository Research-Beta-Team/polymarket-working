import { WebSocketClient } from './websocket-client';
import { MultiAssetEventManager } from './multi-asset-event-manager';
import { MultiAssetTradingManager } from './multi-asset-trading-manager';
import type { PriceUpdate, ConnectionStatus, AssetType } from './types';
import { ASSET_CONFIG } from './types';

/**
 * Multi-Asset Streaming Platform
 * Manages BTC, ETH, SOL, and XRP trading bots in one unified interface
 * Uses tabbed UI to switch between assets
 */
export class MultiAssetStreamingPlatform {
  private wsClient: WebSocketClient;
  private eventManager: MultiAssetEventManager;
  private tradingManager: MultiAssetTradingManager;
  private currentAsset: AssetType = 'btc'; // Currently selected asset tab
  private assetPrices: Map<AssetType, number | null> = new Map();
  private assetPriceHistory: Map<AssetType, Array<{ timestamp: number; value: number }>> = new Map();
  private maxHistorySize = 100;
  private currentStatus: ConnectionStatus = {
    connected: false,
    source: null,
    lastUpdate: null,
    error: null
  };
  private eventPriceToBeat: Map<string, number> = new Map(); // Map of event slug to price to beat
  private eventLastPrice: Map<string, number> = new Map(); // Map of event slug to last price
  private assetUpPrices: Map<AssetType, number | null> = new Map(); // Current UP token prices per asset
  private assetDownPrices: Map<AssetType, number | null> = new Map(); // Current DOWN token prices per asset
  private priceUpdateInterval: number | null = null;
  private countdownInterval: number | null = null;
  
  // Wallet connection state (shared across all assets)
  private walletState: {
    eoaAddress: string | null;
    proxyAddress: string | null;
    isConnected: boolean;
    isLoading: boolean;
    error: string | null;
    balance: number | null;
    balanceLoading: boolean;
    apiCredentials: { key: string; secret: string; passphrase: string } | null;
  } = {
    eoaAddress: null,
    proxyAddress: null,
    isConnected: false,
    isLoading: false,
    error: null,
    balance: null,
    balanceLoading: false,
    apiCredentials: null,
  };

  // Session initialization state (per asset)
  private assetSessions: Map<AssetType, { isInitialized: boolean; isLoading: boolean; error: string | null }> = new Map();

  constructor() {
    this.wsClient = new WebSocketClient();
    this.eventManager = new MultiAssetEventManager();
    this.tradingManager = new MultiAssetTradingManager();
    
    // Initialize price maps and session state for all assets
    const assets: AssetType[] = ['btc', 'eth', 'sol', 'xrp'];
    for (const asset of assets) {
      this.assetPrices.set(asset, null);
      this.assetPriceHistory.set(asset, []);
      this.assetUpPrices.set(asset, null);
      this.assetDownPrices.set(asset, null);
      this.assetSessions.set(asset, {
        isInitialized: false,
        isLoading: false,
        error: null
      });
    }

    this.eventManager.setOnEventsUpdated(() => {
      this.renderEventsTable();
    });

    this.wsClient.setCallbacks(
      this.handlePriceUpdate.bind(this),
      this.handleStatusChange.bind(this)
    );

    this.tradingManager.setOnStatusUpdate((asset, status) => {
      if (asset === this.currentAsset) {
        this.renderTradingSection();
      }
    });

    this.tradingManager.setOnTradeUpdate((asset, trade) => {
      if (asset === this.currentAsset) {
        this.renderTradingSection();
        if (trade.side === 'BUY' && trade.status === 'filled') {
          console.log(`[Orders] ${asset.toUpperCase()} Buy order filled, fetching order details...`);
          this.fetchAndDisplayOrders();
        }
      }
    });

    // Load strategy configs for all assets
    for (const asset of assets) {
      this.tradingManager.getManager(asset)?.loadStrategyConfig();
    }
  }

  async initialize(): Promise<void> {
    try {
      console.log('Initializing MultiAssetStreamingPlatform...');
      this.render();
      this.setupEventListeners();
      this.renderWalletSection();
      console.log('Loading events for all assets...');
      await this.eventManager.loadAllEvents(10);
      this.eventManager.startAutoRefreshAll(60000);
      this.renderTradingSection();
      this.startPriceUpdates();
      console.log('MultiAssetStreamingPlatform initialized successfully');
    } catch (error) {
      console.error('Error initializing MultiAssetStreamingPlatform:', error);
      throw error;
    }
  }

  private handlePriceUpdate(update: PriceUpdate): void {
    const symbol = update.payload.symbol.toLowerCase();
    
    // Determine which asset this price update is for
    let asset: AssetType | null = null;
    for (const [assetType, config] of Object.entries(ASSET_CONFIG)) {
      if (config.symbol.toLowerCase() === symbol) {
        asset = assetType as AssetType;
        break;
      }
    }

    if (!asset) {
      console.warn(`Unknown price symbol: ${symbol}`);
      return;
    }

    // Update price for this asset
    const price = update.payload.value;
    this.assetPrices.set(asset, price);
    
    const history = this.assetPriceHistory.get(asset) || [];
    history.push({
      timestamp: update.payload.timestamp,
      value: price
    });

    if (history.length > this.maxHistorySize) {
      history.shift();
    }
    this.assetPriceHistory.set(asset, history);

    // Update price display if this is the current asset
    if (asset === this.currentAsset) {
      this.updatePriceDisplay();
      this.capturePriceForActiveEvent(asset);
      this.capturePriceForExpiredEvent(asset);
      this.updateTradingManager(asset);
    }
  }

  private handleStatusChange(status: ConnectionStatus): void {
    this.currentStatus = status;
    this.updateConnectionStatus();
  }

  private capturePriceForActiveEvent(asset: AssetType): void {
    const price = this.assetPrices.get(asset);
    if (price === null) return;

    const events = this.eventManager.getEvents(asset);
    const activeEvent = events.find(e => e.status === 'active');

    // Price to Beat = first value of the asset for the active event (set once when we have no value yet)
    if (activeEvent && !this.eventPriceToBeat.has(activeEvent.slug)) {
      this.eventPriceToBeat.set(activeEvent.slug, price);
      this.renderActiveEvent();
    }
  }

  private capturePriceForExpiredEvent(asset: AssetType): void {
    const price = this.assetPrices.get(asset);
    if (price === null) return;

    const events = this.eventManager.getEvents(asset);
    
    events.forEach((event, index) => {
      if (index > 0) {
        const previousEvent = events[index - 1];
        
        if (previousEvent.status === 'expired' && !this.eventLastPrice.has(event.slug)) {
          this.eventLastPrice.set(event.slug, price);
          
          if (event.status === 'active' && !this.eventPriceToBeat.has(event.slug)) {
            this.eventPriceToBeat.set(event.slug, price);
          }
          
          if (asset === this.currentAsset) {
            this.renderEventsTable();
            this.renderActiveEvent();
          }
        }
      }
    });
  }

  private updateTradingManager(asset: AssetType): void {
    const events = this.eventManager.getEvents(asset);
    const activeEvent = events.find(e => e.status === 'active');
    const priceToBeat = activeEvent ? this.eventPriceToBeat.get(activeEvent.slug) : null;
    const currentPrice = this.assetPrices.get(asset) || null;

    // Update market data - updateMarketData takes (currentPrice, priceToBeat, activeEvent)
    this.tradingManager.updateMarketData(asset, currentPrice, priceToBeat || null, activeEvent || null);
  }

  private setupEventListeners(): void {
    const connectBtn = document.getElementById('connect');
    const disconnectBtn = document.getElementById('disconnect');

    connectBtn?.addEventListener('click', () => {
      this.wsClient.connect();
    });

    disconnectBtn?.addEventListener('click', () => {
      this.wsClient.disconnect();
    });

    // Asset tab switching
    const assets: AssetType[] = ['btc', 'eth', 'sol', 'xrp'];
    for (const asset of assets) {
      const tabBtn = document.getElementById(`asset-tab-${asset}`);
      tabBtn?.addEventListener('click', () => {
        this.switchAsset(asset);
      });
    }

    // Events section collapsible
    const eventsHeader = document.getElementById('events-section-header');
    const eventsContent = document.getElementById('events-section-content');
    const eventsChevron = document.getElementById('events-chevron');
    
    if (eventsHeader && eventsContent && eventsChevron) {
      eventsHeader.addEventListener('click', () => {
        const isCollapsed = eventsContent.classList.contains('collapsed');
        if (isCollapsed) {
          eventsContent.classList.remove('collapsed');
          eventsChevron.textContent = '▼';
        } else {
          eventsContent.classList.add('collapsed');
          eventsChevron.textContent = '▶';
        }
      });
    }

    // Trading controls
    const startBtn = document.getElementById('start-trading');
    const stopBtn = document.getElementById('stop-trading');
    const saveConfigBtn = document.getElementById('save-strategy-config');

    startBtn?.addEventListener('click', async () => {
      await this.startTrading();
    });

    stopBtn?.addEventListener('click', () => {
      this.stopTrading();
    });

    saveConfigBtn?.addEventListener('click', () => {
      this.saveStrategyConfig();
    });

    // Wallet controls
    const connectWalletBtn = document.getElementById('connect-wallet');
    const disconnectWalletBtn = document.getElementById('disconnect-wallet');
    const initializeSessionBtn = document.getElementById('initialize-session');

    connectWalletBtn?.addEventListener('click', () => {
      this.connectWallet();
    });

    disconnectWalletBtn?.addEventListener('click', () => {
      this.disconnectWallet();
    });

    initializeSessionBtn?.addEventListener('click', () => {
      this.initializeTradingSession();
    });
  }

  private switchAsset(asset: AssetType): void {
    // Stop countdown for previous asset
    this.stopCountdown();
    
    this.currentAsset = asset;
    
    // Update active tab styling
    const assets: AssetType[] = ['btc', 'eth', 'sol', 'xrp'];
    for (const a of assets) {
      const tab = document.getElementById(`asset-tab-${a}`);
      if (tab) {
        if (a === asset) {
          tab.classList.add('active');
        } else {
          tab.classList.remove('active');
        }
      }
    }

    // Update section headers to reflect current asset
    this.updateSectionHeaders();

    // Re-render all sections for the new asset
    this.updatePriceDisplay();
    this.renderEventsTable();
    this.renderActiveEvent();
    this.renderTradingSection();
    this.renderWalletSection();
    this.fetchAndDisplayOrders();
    
    // Restart price updates for new asset
    this.startPriceUpdates();
  }

  private updateSectionHeaders(): void {
    // Update all section headers to show current asset
    const eventsHeader = document.querySelector('.events-section-header h2');
    if (eventsHeader) {
      eventsHeader.textContent = `${ASSET_CONFIG[this.currentAsset].displayName} Up/Down 15m Events`;
    }

    const tradingHeader = document.querySelector('.trading-section h2');
    if (tradingHeader) {
      tradingHeader.textContent = `Trading Configuration - ${ASSET_CONFIG[this.currentAsset].displayName}`;
    }

    const ordersHeader = document.querySelector('.orders-section h2');
    if (ordersHeader) {
      ordersHeader.textContent = `Orders & Positions - ${ASSET_CONFIG[this.currentAsset].displayName}`;
    }

    const tradesHeader = document.querySelector('.trades-section h2');
    if (tradesHeader) {
      tradesHeader.textContent = `Trade History - ${ASSET_CONFIG[this.currentAsset].displayName}`;
    }

    const sessionHeader = document.querySelector('.wallet-section h3');
    if (sessionHeader) {
      sessionHeader.textContent = `Trading Session Initialization - ${ASSET_CONFIG[this.currentAsset].displayName}`;
    }
  }

  private render(): void {
    const app = document.getElementById('app');
    if (!app) {
      console.error('App element not found!');
      return;
    }

    app.innerHTML = `
      <div class="container">
        <header>
          <h1>Multi-Asset Trading Platform</h1>
          <p class="subtitle">BTC, ETH, SOL, XRP - Real-time cryptocurrency trading</p>
        </header>

        <!-- Asset Tabs -->
        <div class="asset-tabs">
          ${['btc', 'eth', 'sol', 'xrp'].map(asset => `
            <button id="asset-tab-${asset}" class="asset-tab ${asset === this.currentAsset ? 'active' : ''}">
              ${ASSET_CONFIG[asset as AssetType].displayName}
            </button>
          `).join('')}
        </div>

        <div class="controls">
          <div class="button-group">
            <button id="connect" class="btn btn-primary">Connect WebSocket</button>
            <button id="disconnect" class="btn btn-secondary">Disconnect</button>
          </div>
        </div>

        <div class="status-bar">
          <div class="status-item">
            <span class="status-label">Status:</span>
            <span id="connection-status" class="status-disconnected">Disconnected</span>
          </div>
          <div id="error-message" class="error-message"></div>
        </div>

        <div class="price-display">
          <div class="price-label">Current ${ASSET_CONFIG[this.currentAsset].displayName} Price</div>
          <div id="current-price" class="price-value">--</div>
          <div class="price-meta">
            <span>Last Update: <span id="price-timestamp">--</span></span>
            <span id="price-change" class="price-change">--</span>
          </div>
        </div>

        <div class="active-event-section" id="active-event-display">
          <div class="active-event-empty">
            <p>Loading events...</p>
          </div>
        </div>

        <div class="events-section">
          <div class="events-section-header" id="events-section-header" style="cursor: pointer;">
            <h2>${ASSET_CONFIG[this.currentAsset].displayName} Up/Down 15m Events</h2>
            <span class="events-chevron" id="events-chevron">▶</span>
          </div>
          <div class="events-section-content collapsed" id="events-section-content">
            <table class="events-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Status</th>
                  <th>Last Price</th>
                  <th>Condition ID</th>
                  <th>Question ID</th>
                  <th>Token IDs</th>
                  <th>Slug</th>
                </tr>
              </thead>
              <tbody id="events-table-body">
                <tr><td colspan="9" style="text-align: center;">Loading events...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="trading-section">
          <h2>Trading Configuration - ${ASSET_CONFIG[this.currentAsset].displayName}</h2>
          <div id="trading-config"></div>
          <div id="trading-status"></div>
          <div id="trading-controls"></div>
        </div>

        <div class="wallet-section">
          <h2>Wallet Connection (Shared Across All Assets)</h2>
          <div id="wallet-display"></div>
          <h3>Trading Session Initialization - ${ASSET_CONFIG[this.currentAsset].displayName}</h3>
          <p class="session-note">Each asset requires its own trading session initialization. Initialize sessions for each asset you want to trade.</p>
          <div id="session-display"></div>
        </div>

        <div class="orders-section">
          <h2>Orders & Positions - ${ASSET_CONFIG[this.currentAsset].displayName}</h2>
          <div id="orders-display"></div>
        </div>

        <div class="trades-section">
          <h2>Trade History - ${ASSET_CONFIG[this.currentAsset].displayName}</h2>
          <div id="trades-display"></div>
        </div>
      </div>
    `;
  }

  private updatePriceDisplay(): void {
    const priceElement = document.getElementById('current-price');
    const timestampElement = document.getElementById('price-timestamp');
    const changeElement = document.getElementById('price-change');

    const price = this.assetPrices.get(this.currentAsset);
    
    if (priceElement) {
      priceElement.textContent = price !== null ? `$${price.toFixed(2)}` : '--';
    }

    if (timestampElement) {
      const history = this.assetPriceHistory.get(this.currentAsset) || [];
      const lastUpdate = history.length > 0 ? history[history.length - 1].timestamp : null;
      if (lastUpdate) {
        timestampElement.textContent = new Date(lastUpdate * 1000).toLocaleTimeString();
      } else {
        timestampElement.textContent = '--';
      }
    }

    if (changeElement && price !== null) {
      const history = this.assetPriceHistory.get(this.currentAsset) || [];
      if (history.length >= 2) {
        const prevPrice = history[history.length - 2].value;
        const change = price - prevPrice;
        const changePercent = (change / prevPrice) * 100;
        changeElement.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%)`;
        changeElement.className = `price-change ${change >= 0 ? 'positive' : 'negative'}`;
      }
    }
  }

  private renderEventsTable(): void {
    const events = this.eventManager.getEvents(this.currentAsset);
    const tableBody = document.getElementById('events-table-body');
    
    if (!tableBody) return;

    if (events.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px;">No events found</td></tr>';
      return;
    }

    tableBody.innerHTML = events.map((event, index) => {
      const isCurrent = index === this.eventManager.getCurrentEventIndex(this.currentAsset);
      const rowClass = isCurrent ? 'event-row current-event' : 'event-row';
      
      const statusClass = event.status === 'active' ? 'status-active' : 
                          event.status === 'expired' ? 'status-expired' : 'status-upcoming';
      const statusText = event.status === 'active' ? 'Active' : 
                        event.status === 'expired' ? 'Expired' : 'Upcoming';

      const lastPrice = this.eventLastPrice.get(event.slug) || event.lastPrice;
      const lastPriceDisplay = lastPrice !== undefined ? `$${lastPrice.toFixed(2)}` : '--';

      return `
        <tr class="${rowClass}">
          <td>${event.title}</td>
          <td>${event.formattedStartDate}</td>
          <td>${event.formattedEndDate}</td>
          <td><span class="${statusClass}">${statusText}</span></td>
          <td>${lastPriceDisplay}</td>
          <td>${event.conditionId || '--'}</td>
          <td>${event.questionId || '--'}</td>
          <td>${event.clobTokenIds ? event.clobTokenIds.join(', ') : '--'}</td>
          <td>${event.slug}</td>
        </tr>
      `;
    }).join('');
  }

  private renderActiveEvent(): void {
    const activeEventContainer = document.getElementById('active-event-display');
    if (!activeEventContainer) return;

    const events = this.eventManager.getEvents(this.currentAsset);
    const activeEvent = events.find(e => e.status === 'active');

    if (!activeEvent) {
      activeEventContainer.innerHTML = `
        <div class="active-event-empty">
          <p>No active event for ${ASSET_CONFIG[this.currentAsset].displayName}</p>
        </div>
      `;
      return;
    }

    const priceToBeat = this.eventPriceToBeat.get(activeEvent.slug);
    const currentPrice = this.assetPrices.get(this.currentAsset);
    const priceToBeatDisplay = priceToBeat !== undefined 
      ? `$${priceToBeat.toFixed(2)}` 
      : (currentPrice !== null ? `$${currentPrice.toFixed(2)} (current)` : 'Loading...');

    const upPrice = this.assetUpPrices.get(this.currentAsset);
    const downPrice = this.assetDownPrices.get(this.currentAsset);

    activeEventContainer.innerHTML = `
      <div class="active-event">
        <h3>Active Event: ${activeEvent.title}</h3>
        <div class="active-event-info">
          <div class="info-row">
            <span class="info-label">Price to Beat:</span>
            <span class="info-value">${priceToBeatDisplay}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Current ${ASSET_CONFIG[this.currentAsset].displayName} Price:</span>
            <span class="info-value">${currentPrice !== null ? `$${currentPrice.toFixed(2)}` : 'Loading...'}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Time Remaining:</span>
            <span class="info-value" id="countdown">Calculating...</span>
          </div>
          ${upPrice !== null && downPrice !== null ? `
            <div class="info-row">
              <span class="info-label">UP Price:</span>
              <span class="info-value">${upPrice.toFixed(2)}%</span>
            </div>
            <div class="info-row">
              <span class="info-label">DOWN Price:</span>
              <span class="info-value">${downPrice.toFixed(2)}%</span>
            </div>
          ` : ''}
          <div class="info-row">
            <span class="info-label">Slug:</span>
            <span class="info-value slug-value">${activeEvent.slug}</span>
          </div>
        </div>
      </div>
    `;

    this.startCountdown(activeEvent);
  }

  private startCountdown(event: any): void {
    this.stopCountdown();
    this.countdownInterval = window.setInterval(() => {
      this.updateCountdown();
    }, 1000);
    this.updateCountdown();
  }

  private stopCountdown(): void {
    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  private updateCountdown(): void {
    const events = this.eventManager.getEvents(this.currentAsset);
    const activeEvent = events.find(e => e.status === 'active');
    const countdownElement = document.getElementById('countdown');
    
    if (!activeEvent || !countdownElement) {
      this.stopCountdown();
      return;
    }

    const endDate = new Date(activeEvent.endDate);
    const now = new Date();
    const timeLeft = Math.max(0, Math.floor((endDate.getTime() - now.getTime()) / 1000));
    
    countdownElement.textContent = this.formatCountdown(timeLeft);
    
    if (timeLeft === 0) {
      const price = this.assetPrices.get(this.currentAsset);
      if (price !== null) {
        const activeIndex = events.findIndex(e => e.status === 'active');
        const nextEvent = events[activeIndex + 1];
        if (nextEvent && !this.eventLastPrice.has(nextEvent.slug)) {
          this.eventLastPrice.set(nextEvent.slug, price);
        }
      }
      this.stopCountdown();
      this.eventManager.loadEvents(this.currentAsset, 10).catch(console.error);
    }
  }

  private formatCountdown(seconds: number): string {
    if (seconds <= 0) {
      return '00:00:00';
    }
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  private renderTradingSection(): void {
    const configDiv = document.getElementById('trading-config');
    const statusDiv = document.getElementById('trading-status');
    const controlsDiv = document.getElementById('trading-controls');
    const tradesDiv = document.getElementById('trades-display');

    if (!configDiv || !statusDiv || !controlsDiv) return;

    const config = this.tradingManager.getStrategyConfig(this.currentAsset);
    const status = this.tradingManager.getStatus(this.currentAsset);
    const trades = this.tradingManager.getTrades(this.currentAsset);
    const sessionState = this.assetSessions.get(this.currentAsset);

    // Render config form
    configDiv.innerHTML = `
      <div class="strategy-config">
        <div class="config-item">
          <label>
            <input type="checkbox" id="strategy-enabled" ${config.enabled ? 'checked' : ''}>
            Enable Trading
          </label>
        </div>
        <div class="config-item">
          <label>
            Entry Price (0-100):
            <input type="number" id="entry-price" value="${config.entryPrice}" min="0" max="100" step="0.01">
            <small>When active order's UP or DOWN value reaches this price, the order is placed</small>
          </label>
        </div>
        <div class="config-item">
          <label>
            Profit Target (0-100):
            <input type="number" id="profit-target" value="${config.profitTargetPrice}" min="0" max="100" step="0.01">
            <small>When active order's UP or DOWN value reaches this price, the order is sold</small>
          </label>
        </div>
        <div class="config-item">
          <label>
            Stop Loss (0-100):
            <input type="number" id="stop-loss" value="${config.stopLossPrice}" min="0" max="100" step="0.01">
            <small>When UP or DOWN value reaches this price, the order is sold</small>
          </label>
        </div>
        <div class="config-item">
          <label>
            Trade Size
            <span class="text-slate-500 text-xs">(amount in USD or shares)</span>
            <div class="flex gap-2 items-center mt-1">
              <input type="number" id="trade-size" value="${config.tradeSize}" min="0" step="0.01" class="flex-1">
              <select id="trade-size-unit" class="min-w-[80px]">
                <option value="USD" ${(config.tradeSizeUnit ?? 'USD') === 'USD' ? 'selected' : ''}>USD</option>
                <option value="shares" ${config.tradeSizeUnit === 'shares' ? 'selected' : ''}>Shares</option>
              </select>
            </div>
          </label>
        </div>
        <div class="config-item">
          <label>
            Price Difference (USD):
            <input type="number" id="price-difference" value="${config.priceDifference || ''}" placeholder="Optional">
            <small>Only trade when |Price to Beat - Current ${ASSET_CONFIG[this.currentAsset].displayName} Price| equals this value. Leave empty to disable.</small>
          </label>
        </div>
        <button id="save-strategy-config" class="btn btn-primary">Save Configuration</button>
      </div>
    `;

    // Render status
    statusDiv.innerHTML = `
      <div class="trading-status-display">
        <div class="status-item">
          <span class="status-label">Trading Active:</span>
          <span class="status-value">${status.isActive ? 'Yes' : 'No'}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Total Trades:</span>
          <span class="status-value">${status.totalTrades}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Successful:</span>
          <span class="status-value">${status.successfulTrades}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Failed:</span>
          <span class="status-value">${status.failedTrades}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Total Profit:</span>
          <span class="status-value ${status.totalProfit >= 0 ? 'profit' : 'loss'}">$${status.totalProfit.toFixed(2)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Open Positions:</span>
          <span class="status-value">${status.positions?.length || 0}</span>
        </div>
      </div>
    `;

    // Render controls
    const canStartTrading = sessionState?.isInitialized && !status.isActive;
    controlsDiv.innerHTML = `
      <div class="trading-controls">
        <button id="start-trading" class="btn btn-success" ${!canStartTrading ? 'disabled' : ''}>
          Start ${ASSET_CONFIG[this.currentAsset].displayName} Trading
        </button>
        <button id="stop-trading" class="btn btn-danger" ${!status.isActive ? 'disabled' : ''}>
          Stop ${ASSET_CONFIG[this.currentAsset].displayName} Trading
        </button>
        ${!sessionState?.isInitialized ? `
          <p class="trading-warning">⚠️ Trading session not initialized. Please initialize session first.</p>
        ` : ''}
      </div>
    `;

    // Render trades
    if (tradesDiv) {
      if (trades.length === 0) {
        tradesDiv.innerHTML = '<p class="no-trades">No trades yet for ' + ASSET_CONFIG[this.currentAsset].displayName + '</p>';
      } else {
        tradesDiv.innerHTML = `
          <table class="trades-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Side</th>
                <th>Size</th>
                <th>Price</th>
                <th>Status</th>
                <th>Profit</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              ${trades.slice().reverse().map(trade => `
                <tr class="trade-row trade-${trade.status}">
                  <td>${new Date(trade.timestamp).toLocaleTimeString()}</td>
                  <td class="event-slug">${trade.eventSlug}</td>
                  <td><span class="side-${trade.side.toLowerCase()}">${trade.side}</span> ${trade.direction ? `<span class="direction-badge direction-${trade.direction.toLowerCase()}">${trade.direction}</span>` : ''}</td>
                  <td>$${trade.size.toFixed(2)}</td>
                  <td>${trade.price.toFixed(2)}${trade.orderType === 'LIMIT' && trade.limitPrice ? ` (limit: ${trade.limitPrice.toFixed(2)})` : ''}</td>
                  <td><span class="status-badge status-${trade.status}">${trade.status}</span> ${trade.orderType === 'LIMIT' ? '<span class="order-type">LIMIT</span>' : ''}</td>
                  <td class="${trade.profit !== undefined ? (trade.profit >= 0 ? 'profit' : 'loss') : ''}">
                    ${trade.profit !== undefined ? `$${trade.profit.toFixed(2)}` : '--'}
                  </td>
                  <td class="reason">${trade.reason}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      }
    }
  }

  private renderWalletSection(): void {
    const walletDiv = document.getElementById('wallet-display');
    const sessionDiv = document.getElementById('session-display');
    
    if (walletDiv) {
      walletDiv.innerHTML = `
        <div class="wallet-info">
          <div class="wallet-status">
            <span class="status-label">Wallet:</span>
            <span class="status-value">${this.walletState.isConnected ? 'Connected' : 'Not Connected'}</span>
          </div>
          ${this.walletState.eoaAddress ? `
            <div class="wallet-address">
              <span class="label">EOA:</span>
              <span class="value">${this.walletState.eoaAddress.substring(0, 6)}...${this.walletState.eoaAddress.substring(38)}</span>
            </div>
          ` : ''}
          ${this.walletState.proxyAddress ? `
            <div class="wallet-address">
              <span class="label">Proxy:</span>
              <span class="value">${this.walletState.proxyAddress.substring(0, 6)}...${this.walletState.proxyAddress.substring(38)}</span>
            </div>
          ` : ''}
          ${this.walletState.balance !== null ? `
            <div class="wallet-balance">
              <span class="label">Balance:</span>
              <span class="value">$${this.walletState.balance.toFixed(2)}</span>
            </div>
          ` : ''}
          <div class="wallet-controls">
            ${!this.walletState.isConnected ? `
              <button id="connect-wallet" class="btn btn-primary" ${this.walletState.isLoading ? 'disabled' : ''}>Connect Wallet</button>
            ` : `
              <button id="disconnect-wallet" class="btn btn-secondary">Disconnect Wallet</button>
            `}
          </div>
          ${this.walletState.error ? `
            <div class="wallet-error">Error: ${this.walletState.error}</div>
          ` : ''}
        </div>
      `;
    }

    if (sessionDiv) {
      const sessionState = this.assetSessions.get(this.currentAsset) || { isInitialized: false, isLoading: false, error: null };
      sessionDiv.innerHTML = `
        <div class="session-info">
          <div class="session-status">
            <span class="status-label">${ASSET_CONFIG[this.currentAsset].displayName} Session:</span>
            <span class="status-value">${sessionState.isInitialized ? 'Initialized' : 'Not Initialized'}</span>
          </div>
          ${sessionState.error ? `
            <div class="session-error">Error: ${sessionState.error}</div>
          ` : ''}
          <div class="session-controls">
            <button id="initialize-session" class="btn btn-primary" 
              ${!this.walletState.isConnected || sessionState.isInitialized || sessionState.isLoading ? 'disabled' : ''}>
              ${sessionState.isLoading ? 'Initializing...' : `Initialize ${ASSET_CONFIG[this.currentAsset].displayName} Trading Session`}
            </button>
          </div>
        </div>
      `;
    }
  }

  private async startTrading(): Promise<void> {
    const sessionState = this.assetSessions.get(this.currentAsset);
    if (!sessionState?.isInitialized) {
      alert(`Please initialize ${ASSET_CONFIG[this.currentAsset].displayName} trading session first!`);
      return;
    }

    await this.tradingManager.startTrading(this.currentAsset);
    this.renderTradingSection();
  }

  private stopTrading(): void {
    this.tradingManager.stopTrading(this.currentAsset);
    this.renderTradingSection();
  }

  private saveStrategyConfig(): void {
    const enabled = (document.getElementById('strategy-enabled') as HTMLInputElement)?.checked || false;
    const entryPrice = parseFloat((document.getElementById('entry-price') as HTMLInputElement)?.value || '96');
    const profitTarget = parseFloat((document.getElementById('profit-target') as HTMLInputElement)?.value || '99');
    const stopLoss = parseFloat((document.getElementById('stop-loss') as HTMLInputElement)?.value || '91');
    const tradeSize = parseFloat((document.getElementById('trade-size') as HTMLInputElement)?.value || '50');
    const tradeSizeUnit = ((document.getElementById('trade-size-unit') as HTMLSelectElement)?.value || 'USD') as 'USD' | 'shares';
    const priceDifferenceInput = (document.getElementById('price-difference') as HTMLInputElement)?.value;
    const priceDifference = priceDifferenceInput && priceDifferenceInput.trim() !== '' 
      ? parseFloat(priceDifferenceInput) 
      : null;

    this.tradingManager.updateStrategyConfig(this.currentAsset, {
      enabled,
      entryPrice,
      profitTargetPrice: profitTarget,
      stopLossPrice: stopLoss,
      tradeSize,
      tradeSizeUnit,
      priceDifference,
    });

    alert(`Strategy configuration saved for ${ASSET_CONFIG[this.currentAsset].displayName}!`);
  }

  private updateConnectionStatus(): void {
    const statusElement = document.getElementById('connection-status');
    const errorElement = document.getElementById('error-message');

    if (statusElement) {
      if (this.currentStatus.connected) {
        statusElement.textContent = 'Connected';
        statusElement.className = 'status-connected';
      } else {
        statusElement.textContent = 'Disconnected';
        statusElement.className = 'status-disconnected';
      }
    }

    if (errorElement) {
      if (this.currentStatus.error) {
        errorElement.textContent = this.currentStatus.error;
        errorElement.style.display = 'block';
      } else {
        errorElement.style.display = 'none';
      }
    }
  }

  private startPriceUpdates(): void {
    // Start updating UP/DOWN prices for current asset
    this.stopPriceUpdates();
    this.priceUpdateInterval = window.setInterval(() => {
      this.updateUpDownPrices();
    }, 5000); // Update every 5 seconds
    this.updateUpDownPrices(); // Update immediately
  }

  private stopPriceUpdates(): void {
    if (this.priceUpdateInterval !== null) {
      clearInterval(this.priceUpdateInterval);
      this.priceUpdateInterval = null;
    }
  }

  private async updateUpDownPrices(): Promise<void> {
    const events = this.eventManager.getEvents(this.currentAsset);
    const activeEvent = events.find(e => e.status === 'active');

    if (!activeEvent || !activeEvent.clobTokenIds || activeEvent.clobTokenIds.length < 2) {
      this.assetUpPrices.set(this.currentAsset, null);
      this.assetDownPrices.set(this.currentAsset, null);
      return;
    }

    try {
      const manager = this.tradingManager.getManager(this.currentAsset);
      if (!manager) return;

      const clobClient = (manager as any).clobClient;
      if (!clobClient) return;

      const [yesPrice, noPrice] = await Promise.all([
        clobClient.getPrice(activeEvent.clobTokenIds[0], 'SELL'),
        clobClient.getPrice(activeEvent.clobTokenIds[1], 'SELL'),
      ]);

      if (yesPrice && noPrice) {
        this.assetUpPrices.set(this.currentAsset, yesPrice * 100);
        this.assetDownPrices.set(this.currentAsset, noPrice * 100);
      }
    } catch (error) {
      console.error(`[${this.currentAsset.toUpperCase()}] Error updating UP/DOWN prices:`, error);
    }
  }

  private async fetchAndDisplayOrders(): Promise<void> {
    const ordersDiv = document.getElementById('orders-display');
    if (!ordersDiv) return;

    const sessionState = this.assetSessions.get(this.currentAsset);
    if (!sessionState?.isInitialized || !this.walletState.apiCredentials || !this.walletState.proxyAddress) {
      ordersDiv.innerHTML = `
        <div class="orders-empty">
          <p>${ASSET_CONFIG[this.currentAsset].displayName} trading session not initialized. Please initialize session first.</p>
        </div>
      `;
      return;
    }

    ordersDiv.innerHTML = '<div class="orders-loading">Loading orders...</div>';

    try {
      const response = await fetch(
        `/api/orders?apiCredentials=${encodeURIComponent(JSON.stringify(this.walletState.apiCredentials))}&proxyAddress=${encodeURIComponent(this.walletState.proxyAddress)}`
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch orders');
      }

      const orders = data.orders || [];
      const positions = this.tradingManager.getPositions(this.currentAsset);
      const trades = this.tradingManager.getTrades(this.currentAsset);

      // Render positions
      const positionRows = positions.map((position, index) => {
        const filledOrdersForPosition = position.filledOrders || [];
        const totalFilled = filledOrdersForPosition.reduce((sum, fo) => sum + fo.size, 0);
        const fillPercentage = position.size > 0 ? (totalFilled / position.size * 100).toFixed(1) : '0.0';
        const firstOrder = filledOrdersForPosition[0];
        const orderId = firstOrder?.orderId ? firstOrder.orderId.substring(0, 8) + '...' : `POS-${index + 1}`;
        const hash = firstOrder?.orderId ? firstOrder.orderId.substring(0, 16) + '...' : '--';
        const created = firstOrder?.timestamp ? new Date(firstOrder.timestamp).toLocaleString() : new Date(position.entryTimestamp).toLocaleString();

        return `
          <tr class="order-row order-position" data-position-id="${position.id}">
            <td class="order-id">${orderId}</td>
            <td class="token-id">${position.tokenId ? position.tokenId.substring(0, 10) + '...' : '--'}</td>
            <td>${hash}</td>
            <td>${totalFilled.toFixed(2)} (${fillPercentage}%)</td>
            <td><span class="status-badge status-position">ACTIVE</span></td>
            <td>${created}</td>
            <td>
              <button class="btn-sell-order btn-sell-position" 
                data-position-id="${position.id}"
                data-token-id="${position.tokenId || ''}" 
                data-size="${position.size || 0}"
                data-price="${position.entryPrice || 0}"
                data-direction="${position.direction || ''}">Sell</button>
            </td>
          </tr>
        `;
      }).join('');

      // Render orders
      const orderRows = orders.map((order: any) => {
        const orderStatus = (order.status || 'UNKNOWN').toUpperCase();
        const isFilled = orderStatus === 'FILLED' || orderStatus === 'EXECUTED' || orderStatus === 'CLOSED';
        const isLive = orderStatus === 'LIVE';
        const fillPercentage = order.original_size > 0 
          ? ((order.size_matched || 0) / order.original_size * 100).toFixed(1)
          : '0.0';

        return `
          <tr class="order-row ${isFilled ? 'order-filled' : isLive ? 'order-live' : ''}">
            <td class="order-id">${order.id ? order.id.substring(0, 8) + '...' : '--'}</td>
            <td class="token-id">${order.asset_id ? order.asset_id.substring(0, 10) + '...' : order.token_id ? order.token_id.substring(0, 10) + '...' : '--'}</td>
            <td>${(order.transaction_hash || order.hash || order.id || '--').substring(0, 16)}${(order.transaction_hash || order.hash || order.id || '').length > 16 ? '...' : ''}</td>
            <td>${parseFloat(order.size_matched || order.filled_size || 0).toFixed(2)} (${fillPercentage}%)</td>
            <td><span class="status-badge status-${orderStatus.toLowerCase()}">${order.status || 'UNKNOWN'}</span></td>
            <td>${order.created_at ? new Date(order.created_at * 1000).toLocaleString() : order.created_at_iso || '--'}</td>
            <td>
              ${isLive 
                ? `<button class="btn-cancel-order" data-order-id="${order.id}">Cancel</button>`
                : isFilled && order.side === 'BUY'
                ? `<button class="btn-sell-order" data-order-id="${order.id}" data-token-id="${order.asset_id || order.token_id || ''}" data-size="${order.size_matched || order.filled_size || order.original_size || order.size || 0}" data-price="${order.price || 0}">Sell</button>`
                : '--'
              }
            </td>
          </tr>
        `;
      }).join('');

      ordersDiv.innerHTML = `
        <div class="orders-summary">
          <p><strong>Positions:</strong> ${positions.length} | <strong>Orders:</strong> ${orders.length}</p>
        </div>
        <table class="orders-table">
          <thead>
            <tr>
              <th>Order ID</th>
              <th>Token ID</th>
              <th>Hash</th>
              <th>Filled</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${positionRows}
            ${orderRows}
            ${positions.length === 0 && orders.length === 0 ? '<tr><td colspan="7" class="orders-empty-cell">No orders or positions</td></tr>' : ''}
          </tbody>
        </table>
      `;

      // Add event listeners
      const sellButtons = ordersDiv.querySelectorAll('.btn-sell-order');
      sellButtons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const target = e.target as HTMLButtonElement;
          const positionId = target.getAttribute('data-position-id');
          if (positionId) {
            await this.sellPosition(positionId);
          }
        });
      });

      const cancelButtons = ordersDiv.querySelectorAll('.btn-cancel-order');
      cancelButtons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const orderId = (e.target as HTMLButtonElement).getAttribute('data-order-id');
          if (orderId) {
            await this.cancelOrder(orderId);
          }
        });
      });
    } catch (error) {
      console.error(`[${this.currentAsset.toUpperCase()}] Error fetching orders:`, error);
      ordersDiv.innerHTML = `
        <div class="orders-error">
          <p>Error loading orders: ${error instanceof Error ? error.message : 'Unknown error'}</p>
        </div>
      `;
    }
  }

  private async connectWallet(): Promise<void> {
    this.walletState.isLoading = true;
    this.walletState.error = null;
    this.renderWalletSection();

    try {
      console.log('[Wallet] Attempting to connect...');
      
      const response = await fetch('/api/wallet', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server error (${response.status})`);
      }

      const data = await response.json();

      if (!data.eoaAddress || !data.proxyAddress) {
        throw new Error('Invalid wallet data received: missing eoaAddress or proxyAddress');
      }

      this.walletState.eoaAddress = data.eoaAddress;
      this.walletState.proxyAddress = data.proxyAddress;
      this.walletState.isConnected = true;
      this.walletState.error = null;

      // Fetch balance
      await this.fetchBalance();

      this.renderWalletSection();
      alert('Wallet connected successfully!');
    } catch (error) {
      console.error('[Wallet] Connection error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect wallet';
      this.walletState.error = errorMessage;
      this.walletState.isConnected = false;
      this.renderWalletSection();
    } finally {
      this.walletState.isLoading = false;
      this.renderWalletSection();
    }
  }

  private async fetchBalance(): Promise<void> {
    if (!this.walletState.isConnected) {
      return;
    }

    this.walletState.balanceLoading = true;
    this.renderWalletSection();

    try {
      const response = await fetch('/api/wallet/balance');
      const data = await response.json();

      if (response.ok && data.balance !== null && data.balance !== undefined) {
        this.walletState.balance = data.balance;
        // Update trading managers with balance
        const assets: AssetType[] = ['btc', 'eth', 'sol', 'xrp'];
        for (const asset of assets) {
          const manager = this.tradingManager.getManager(asset);
          if (manager) {
            (manager as any).setWalletBalance?.(data.balance);
          }
        }
      }
    } catch (error) {
      console.error('Balance fetch error:', error);
    } finally {
      this.walletState.balanceLoading = false;
      this.renderWalletSection();
    }
  }

  private disconnectWallet(): void {
    console.log('[Wallet] Disconnecting wallet...');
    
    // Stop trading for all assets
    this.tradingManager.stopAllTrading();
    
    // Reset wallet state
    this.walletState.isConnected = false;
    this.walletState.eoaAddress = null;
    this.walletState.proxyAddress = null;
    this.walletState.apiCredentials = null;
    this.walletState.balance = null;
    this.walletState.error = null;

    // Reset all asset sessions
    const assets: AssetType[] = ['btc', 'eth', 'sol', 'xrp'];
    for (const asset of assets) {
      this.assetSessions.set(asset, {
        isInitialized: false,
        isLoading: false,
        error: null
      });
      // Clear browser CLOB client for each asset
      const manager = this.tradingManager.getManager(asset);
      if (manager) {
        (manager as any).setBrowserClobClient?.(null);
      }
    }

    this.renderWalletSection();
    console.log('[Wallet] Wallet disconnected');
  }

  private async initializeTradingSession(): Promise<void> {
    if (!this.walletState.isConnected) {
      alert('Please connect wallet first');
      return;
    }

    const sessionState = this.assetSessions.get(this.currentAsset);
    if (!sessionState) return;

    sessionState.isLoading = true;
    sessionState.error = null;
    this.renderWalletSection();

    try {
      console.log(`[Session] Initializing ${this.currentAsset.toUpperCase()} trading session...`);

      const response = await fetch('/api/wallet/initialize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to initialize trading session');
      }

      // Store API credentials (shared)
      if (data.credentials) {
        this.walletState.apiCredentials = data.credentials;
        // Set credentials for current asset's trading manager
        this.tradingManager.setApiCredentials(this.currentAsset, data.credentials);
      }

      // Initialize browser CLOB client for THIS asset only
      if (this.walletState.eoaAddress && this.walletState.proxyAddress && data.credentials) {
        await this.initializeBrowserClobClient(this.currentAsset);
        
        // Verify browser client was initialized
        const browserClient = this.tradingManager.getBrowserClobClient(this.currentAsset);
        if (!browserClient) {
          throw new Error('Browser ClobClient initialization failed. Cannot place orders - server-side API is blocked by Cloudflare. Please try reconnecting your wallet.');
        }
      }

      sessionState.isInitialized = true;
      sessionState.error = null;

      // Fetch orders for this asset
      await this.fetchAndDisplayOrders();

      this.renderWalletSection();
      alert(`${ASSET_CONFIG[this.currentAsset].displayName} trading session initialized successfully!`);
    } catch (error) {
      console.error(`[Session] ${this.currentAsset.toUpperCase()} initialization error:`, error);
      sessionState.error = error instanceof Error ? error.message : 'Failed to initialize trading session';
      sessionState.isInitialized = false;
      this.renderWalletSection();
    } finally {
      sessionState.isLoading = false;
      this.renderWalletSection();
    }
  }

  private async initializeBrowserClobClient(asset: AssetType): Promise<void> {
    if (!this.walletState.isConnected || !this.walletState.apiCredentials || !this.walletState.eoaAddress || !this.walletState.proxyAddress) {
      console.warn(`[Browser ClobClient] Cannot initialize ${asset} - wallet not connected or credentials missing`);
      return;
    }

    try {
      const response = await fetch('/api/wallet/private-key', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        console.warn(`[Browser ClobClient] ${asset} - Private key endpoint not available`);
        return;
      }

      const data = await response.json();
      if (!data.privateKey) {
        throw new Error('Private key not returned from server');
      }

      const { initializeBrowserClobClient } = await import('./streaming-platform-clob-init');
      
      const browserClobClient = await initializeBrowserClobClient(
        data.privateKey,
        this.walletState.apiCredentials!,
        this.walletState.proxyAddress!
      );

      // Set in trading manager for THIS asset only
      const manager = this.tradingManager.getManager(asset);
      if (manager) {
        (manager as any).setBrowserClobClient?.(browserClobClient);
        console.log(`[Browser ClobClient] ✅ ${asset.toUpperCase()} session initialized successfully`);
      }
    } catch (error) {
      console.error(`[Browser ClobClient] ❌ ${asset.toUpperCase()} initialization failed:`, error);
      throw error;
    }
  }

  private async sellPosition(positionId: string): Promise<void> {
    const manager = this.tradingManager.getManager(this.currentAsset);
    if (!manager) return;

    try {
      await (manager as any).closePositionManually?.(positionId, 'Manual sell');
      await this.fetchAndDisplayOrders();
      this.renderTradingSection();
      alert('Position closed successfully!');
    } catch (error) {
      console.error('Error selling position:', error);
      alert(`Error: ${error instanceof Error ? error.message : 'Failed to sell position'}`);
    }
  }

  private async cancelOrder(orderId: string): Promise<void> {
    // Cancel order logic
    console.log(`Canceling order ${orderId} for ${this.currentAsset}`);
    // Implementation would call API to cancel order
    await this.fetchAndDisplayOrders();
  }
}
