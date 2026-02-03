import { WebSocketClient } from './websocket-client';
import { EventManager } from './event-manager';
import { TradingManager } from './trading-manager';
import { RedemptionService } from './redemption-service';
import { getNext15MinIntervals } from './event-utils';
import type { PriceUpdate, ConnectionStatus } from './types';

export class StreamingPlatform {
  private wsClient: WebSocketClient;
  private eventManager: EventManager;
  private tradingManager: TradingManager;
  private currentPrice: number | null = null;
  private priceHistory: Array<{ timestamp: number; value: number }> = [];
  private maxHistorySize = 100;
  private currentStatus: ConnectionStatus = {
    connected: false,
    source: null,
    lastUpdate: null,
    error: null
  };
  private countdownInterval: number | null = null;
  private eventPriceToBeat: Map<string, number> = new Map(); // Map of event slug to price to beat
  private eventLastPrice: Map<string, number> = new Map(); // Map of event slug to last price (from previous event end)
  private upPrice: number | null = null; // Current UP token price (0-100 scale)
  private downPrice: number | null = null; // Current DOWN token price (0-100 scale)
  private priceUpdateInterval: number | null = null; // Interval for updating UP/DOWN prices
  private redemptionService: RedemptionService | null = null; // Auto-redemption for resolved markets (background)
  // Wallet connection state
  private walletState: {
    eoaAddress: string | null;
    proxyAddress: string | null;
    isConnected: boolean;
    isLoading: boolean;
    error: string | null;
    isInitialized: boolean;
    balance: number | null;
    balanceLoading: boolean;
    apiCredentials: { key: string; secret: string; passphrase: string } | null;
  } = {
    eoaAddress: null,
    proxyAddress: null,
    isConnected: false,
    isLoading: false,
    error: null,
    isInitialized: false,
    balance: null,
    balanceLoading: false,
    apiCredentials: null,
  };

  constructor() {
    this.wsClient = new WebSocketClient();
    this.eventManager = new EventManager();
    this.tradingManager = new TradingManager();
    this.eventManager.setOnEventsUpdated(() => {
      this.renderEventsTable();
    });
    this.wsClient.setCallbacks(
      this.handlePriceUpdate.bind(this),
      this.handleStatusChange.bind(this)
    );
    this.tradingManager.setOnStatusUpdate(() => {
      this.renderTradingSection();
    });
    this.tradingManager.setOnTradeUpdate((trade) => {
      this.renderTradingSection();
      // When a buy order is filled, fetch and display orders
      if (trade.side === 'BUY' && trade.status === 'filled') {
        console.log('[Orders] Buy order filled, fetching order details...');
        this.fetchAndDisplayOrders();
      }
    });
    this.tradingManager.loadStrategyConfig();
    this.redemptionService = new RedemptionService({
      getPositions: () => this.tradingManager.getPositions(),
      removePositions: (ids) => this.tradingManager.removePositionsByIds(ids),
      onRedemptionSuccess: (eventSlug, positionIds) => {
        console.log('[Redemption] Redeemed winning tokens:', eventSlug, positionIds.length, 'position(s)');
        this.renderTradingSection();
        this.fetchBalance();
      },
      onRedemptionError: (eventSlug, error) => {
        console.warn('[Redemption] Error for', eventSlug, error);
      },
    });
  }

  async initialize(): Promise<void> {
    try {
      console.log('Initializing StreamingPlatform...');
      this.render();
      this.setupEventListeners();
      this.renderWalletSection(); // Initialize wallet section UI
      console.log('Loading events...');
      await this.loadEvents();
      this.eventManager.startAutoRefresh(60000); // Refresh every minute
      this.renderTradingSection(); // Initialize trading section UI
      this.startPriceUpdates(); // Start updating UP/DOWN prices
      console.log('StreamingPlatform initialized successfully');
    } catch (error) {
      console.error('Error initializing StreamingPlatform:', error);
      throw error;
    }
  }

  private setupEventListeners(): void {
    const connectBtn = document.getElementById('connect');
    const disconnectBtn = document.getElementById('disconnect');

    connectBtn?.addEventListener('click', () => {
      this.wsClient.connect();
    });

    disconnectBtn?.addEventListener('click', () => {
      this.wsClient.disconnect();
      this.currentStatus = {
        connected: false,
        source: null,
        lastUpdate: null,
        error: null
      };
      this.updateUI();
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

    // Trading controls
    const startTradingBtn = document.getElementById('start-trading');
    const stopTradingBtn = document.getElementById('stop-trading');
    const saveStrategyBtn = document.getElementById('save-strategy');
    const clearTradesBtn = document.getElementById('clear-trades');

    startTradingBtn?.addEventListener('click', () => {
      this.tradingManager.startTrading();
      this.renderTradingSection();
    });

    stopTradingBtn?.addEventListener('click', () => {
      this.tradingManager.stopTrading();
      this.renderTradingSection();
    });

    const sellAllBtn = document.getElementById('sell-all-btn');
    sellAllBtn?.addEventListener('click', async () => {
      if (!confirm('Sell all positions at market (emergency exit)?')) return;
      try {
        await this.tradingManager.closeAllPositionsManually('Manual Sell all / Emergency');
        this.renderTradingSection();
        this.fetchBalance();
        this.fetchAndDisplayOrders();
      } catch (e) {
        console.error('Sell all failed:', e);
        alert('Sell all failed: ' + (e instanceof Error ? e.message : String(e)));
      }
    });

    saveStrategyBtn?.addEventListener('click', () => {
      this.saveStrategyConfig();
    });

    clearTradesBtn?.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear all trades? This cannot be undone.')) {
        this.tradingManager.clearTrades();
        this.renderTradingSection();
      }
    });

    // Orders section event listeners
    const refreshOrdersBtn = document.getElementById('refresh-orders');
    refreshOrdersBtn?.addEventListener('click', () => {
      this.fetchAndDisplayOrders();
    });

    // Events section collapsible functionality
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
      // Make header cursor pointer
      eventsHeader.style.cursor = 'pointer';
      // Ensure initial state is collapsed
      eventsContent.classList.add('collapsed');
      eventsChevron.textContent = '▶';
    }
  }

  private handlePriceUpdate(update: PriceUpdate): void {
    this.currentPrice = update.payload.value;
    this.priceHistory.push({
      timestamp: update.payload.timestamp,
      value: update.payload.value
    });

    if (this.priceHistory.length > this.maxHistorySize) {
      this.priceHistory.shift();
    }

    // Check if we need to capture price for a newly active event
    this.capturePriceForActiveEvent();
    
    // Check if an event just expired and capture the price for the next event
    this.capturePriceForExpiredEvent();

    // Update trading manager with current market data
    this.updateTradingManager();

    this.updatePriceDisplay();
  }

  private capturePriceForExpiredEvent(): void {
    if (this.currentPrice === null) return;

    const events = this.eventManager.getEvents();
    
    // For each event, check if the previous event just expired
    events.forEach((event, index) => {
      if (index > 0) {
        const previousEvent = events[index - 1];
        
        // If previous event is expired and we haven't stored the last price for the next event yet
        if (previousEvent.status === 'expired' && !this.eventLastPrice.has(event.slug) && this.currentPrice !== null) {
          // Store the current price as the last price (price at the last second of previous event)
          // This will be used as "Price to Beat" for the next event when it becomes active
          this.eventLastPrice.set(event.slug, this.currentPrice);
          console.log(`[Last Price] Captured last price for event ${event.slug} from expired event ${previousEvent.slug}: $${this.currentPrice.toFixed(2)}`);
          
          // If this event is now active, set it as price to beat
          if (event.status === 'active' && !this.eventPriceToBeat.has(event.slug)) {
            this.eventPriceToBeat.set(event.slug, this.currentPrice);
            console.log(`[Price to Beat] Set price to beat for active event ${event.slug}: $${this.currentPrice.toFixed(2)}`);
          }
          
          // Re-render to show the last price and update active event
          this.renderEventsTable();
          this.renderActiveEvent();
        }
      }
    });
  }

  private capturePriceForActiveEvent(): void {
    if (this.currentPrice === null) return;

    const events = this.eventManager.getEvents();
    const activeEvent = events.find(e => e.status === 'active');

    // Price to Beat = first BTC value of the active event (set once when we have no value yet)
    if (activeEvent && !this.eventPriceToBeat.has(activeEvent.slug)) {
      this.eventPriceToBeat.set(activeEvent.slug, this.currentPrice);
      console.log(`[Price to Beat] Set first BTC value for active event ${activeEvent.slug}: $${this.currentPrice.toFixed(2)}`);
      this.renderActiveEvent();
    }
  }

  private handleStatusChange(status: ConnectionStatus): void {
    this.currentStatus = status;
    this.updateUI();
  }

  private updatePriceDisplay(): void {
    const priceElement = document.getElementById('current-price');
    const timestampElement = document.getElementById('price-timestamp');
    const changeElement = document.getElementById('price-change');

    if (priceElement && this.currentPrice !== null) {
      priceElement.textContent = this.formatPrice(this.currentPrice);
      
      // Add animation class for price updates
      priceElement.classList.add('price-update');
      setTimeout(() => {
        priceElement.classList.remove('price-update');
      }, 300);
    }

    if (timestampElement && this.priceHistory.length > 0) {
      const lastUpdate = this.priceHistory[this.priceHistory.length - 1];
      timestampElement.textContent = new Date(lastUpdate.timestamp).toLocaleTimeString();
    }

    if (changeElement && this.priceHistory.length >= 2) {
      const current = this.priceHistory[this.priceHistory.length - 1].value;
      const previous = this.priceHistory[this.priceHistory.length - 2].value;
      const change = current - previous;
      const changePercentValue = (change / previous) * 100;
      const changePercent = changePercentValue.toFixed(4);

      changeElement.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePercentValue >= 0 ? '+' : ''}${changePercent}%)`;
      changeElement.className = change >= 0 ? 'positive' : 'negative';
    }
  }

  private updateUI(): void {
    const statusElement = document.getElementById('connection-status');
    const errorElement = document.getElementById('error-message');
    
    if (statusElement) {
      const isConnected = this.currentStatus.connected;
      statusElement.textContent = isConnected ? 'Connected' : 'Disconnected';
      statusElement.className = isConnected ? 'status-connected' : 'status-disconnected';
    }

    if (errorElement) {
      errorElement.textContent = this.currentStatus.error || '';
    }
  }

  private formatPrice(price: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(price);
  }

  /**
   * Format UP/DOWN price (0-100 scale) as cents
   */
  private formatUpDownPrice(price: number): string {
    // Price is in 0-100 scale, convert to cents (0-10000)
    const cents = Math.round(price);
    return `${cents}¢`;
  }

  private async loadEvents(): Promise<void> {
    try {
      await this.eventManager.loadEvents(10);
      
      // Update last prices when events are loaded
      this.updateLastPrices();
      
      this.renderEventsTable();
      // Clear any previous errors
      const errorElement = document.getElementById('events-error');
      if (errorElement) {
        errorElement.textContent = '';
      }
    } catch (error) {
      console.error('Error loading events:', error);
      const errorElement = document.getElementById('events-error');
      if (errorElement) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errorElement.textContent = `Failed to load events: ${errorMessage}`;
        errorElement.style.display = 'block';
      }
      
      // Still try to render with placeholder data if we have timestamps
      const timestamps = getNext15MinIntervals(10);
      if (timestamps.length > 0) {
        this.updateLastPrices();
        this.renderEventsTable();
      }
    }
  }

  private updateLastPrices(): void {
    if (this.currentPrice === null) return;

    const events = this.eventManager.getEvents();
    
    // For each event, if the previous event just expired, capture the price
    events.forEach((event, index) => {
      if (index > 0) {
        const previousEvent = events[index - 1];
        
        // If previous event is expired and we have a current price, store it as last price for this event
        if (previousEvent.status === 'expired' && !this.eventLastPrice.has(event.slug) && this.currentPrice !== null) {
          // Use current price as the last price (price when previous event ended)
          this.eventLastPrice.set(event.slug, this.currentPrice);
        }
      }
    });
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

  private updateCountdown(): void {
    const events = this.eventManager.getEvents();
    const activeEvent = events.find(e => e.status === 'active');
    const countdownElement = document.getElementById('event-countdown');
    
    if (!activeEvent || !countdownElement) {
      this.stopCountdown();
      return;
    }

    const endDate = new Date(activeEvent.endDate);
    const now = new Date();
    const timeLeft = Math.max(0, Math.floor((endDate.getTime() - now.getTime()) / 1000));
    
    countdownElement.textContent = this.formatCountdown(timeLeft);
    
    // If time is up, capture the price and refresh events to update status
    if (timeLeft === 0) {
      // Capture current price as last price for the next event
      if (this.currentPrice !== null) {
        const events = this.eventManager.getEvents();
        const activeEvent = events.find(e => e.status === 'active');
        if (activeEvent) {
          const activeIndex = events.findIndex(e => e.status === 'active');
          const nextEvent = events[activeIndex + 1];
          if (nextEvent && !this.eventLastPrice.has(nextEvent.slug)) {
            this.eventLastPrice.set(nextEvent.slug, this.currentPrice);
          }
        }
      }
      this.stopCountdown();
      this.loadEvents().catch(console.error);
    }
  }

  private startCountdown(): void {
    this.stopCountdown();
    this.countdownInterval = window.setInterval(() => {
      this.updateCountdown();
    }, 1000);
    // Update immediately
    this.updateCountdown();
  }

  private stopCountdown(): void {
    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  /**
   * Fetch UP and DOWN prices for the active event
   */
  private async updateUpDownPrices(): Promise<void> {
    const events = this.eventManager.getEvents();
    const activeEvent = events.find(e => e.status === 'active');

    if (!activeEvent || !activeEvent.clobTokenIds || activeEvent.clobTokenIds.length < 2) {
      this.upPrice = null;
      this.downPrice = null;
      // Update DOM to show no prices
      this.updateUpDownPriceDisplay();
      return;
    }

    const upTokenId = activeEvent.clobTokenIds[0]; // First token = UP
    const downTokenId = activeEvent.clobTokenIds[1]; // Second token = DOWN

    try {
      // Fetch prices in parallel using proxy to avoid CORS issues
      const [upPriceResult, downPriceResult] = await Promise.all([
        fetch(`/api/clob-proxy?side=BUY&token_id=${upTokenId}`),
        fetch(`/api/clob-proxy?side=BUY&token_id=${downTokenId}`),
      ]);

      // Check if response is actually JSON (not TypeScript source)
      if (upPriceResult.ok) {
        const contentType = upPriceResult.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const upData = await upPriceResult.json();
          this.upPrice = upData.price ? parseFloat(upData.price) * 100 : null; // Convert to 0-100 scale
        } else {
          console.warn('UP price response is not JSON, trying direct API call');
          // Try direct API call as fallback
          await this.fetchPriceDirectly(upTokenId, 'up');
        }
      }

      if (downPriceResult.ok) {
        const contentType = downPriceResult.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const downData = await downPriceResult.json();
          this.downPrice = downData.price ? parseFloat(downData.price) * 100 : null; // Convert to 0-100 scale
        } else {
          console.warn('DOWN price response is not JSON, trying direct API call');
          // Try direct API call as fallback
          await this.fetchPriceDirectly(downTokenId, 'down');
        }
      }

      // Update DOM elements directly for smoother updates
      this.updateUpDownPriceDisplay();
    } catch (error) {
      console.error('Error fetching UP/DOWN prices:', error);
      // Fallback to direct API calls if proxy fails
      try {
        if (upTokenId) await this.fetchPriceDirectly(upTokenId, 'up');
        if (downTokenId) await this.fetchPriceDirectly(downTokenId, 'down');
      } catch (fallbackError) {
        console.error('Fallback price fetch also failed:', fallbackError);
      }
    }
  }

  /**
   * Fallback: Fetch price directly from CLOB API (if proxy fails)
   */
  private async fetchPriceDirectly(tokenId: string, type: 'up' | 'down'): Promise<void> {
    try {
      // Use CORS proxy or direct call
      const response = await fetch(`https://clob.polymarket.com/price?side=BUY&token_id=${tokenId}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
        mode: 'cors',
      });

      if (response.ok) {
        const data = await response.json();
        const price = data.price ? parseFloat(data.price) * 100 : null;
        if (type === 'up') {
          this.upPrice = price;
        } else {
          this.downPrice = price;
        }
        this.updateUpDownPriceDisplay();
      }
    } catch (error) {
      console.error(`Error fetching ${type} price directly:`, error);
    }
  }

  /**
   * Update UP/DOWN price display in DOM without re-rendering entire section
   */
  private updateUpDownPriceDisplay(): void {
    const upPriceElement = document.getElementById('up-price-value');
    const downPriceElement = document.getElementById('down-price-value');

    if (upPriceElement) {
      upPriceElement.textContent = this.upPrice !== null ? this.formatUpDownPrice(this.upPrice) : '--';
      // Add animation class
      upPriceElement.classList.add('price-update');
      setTimeout(() => {
        upPriceElement.classList.remove('price-update');
      }, 300);
    }

    if (downPriceElement) {
      downPriceElement.textContent = this.downPrice !== null ? this.formatUpDownPrice(this.downPrice) : '--';
      // Add animation class
      downPriceElement.classList.add('price-update');
      setTimeout(() => {
        downPriceElement.classList.remove('price-update');
      }, 300);
    }
  }

  /**
   * Start updating UP/DOWN prices in real-time
   */
  private startPriceUpdates(): void {
    this.stopPriceUpdates();
    // Update immediately
    this.updateUpDownPrices();
    // Then update every 1 second
    this.priceUpdateInterval = window.setInterval(() => {
      this.updateUpDownPrices();
    }, 1000);
  }

  /**
   * Stop updating UP/DOWN prices
   */
  private stopPriceUpdates(): void {
    if (this.priceUpdateInterval !== null) {
      clearInterval(this.priceUpdateInterval);
      this.priceUpdateInterval = null;
    }
  }

  private renderActiveEvent(): void {
    const events = this.eventManager.getEvents();
    const activeEvent = events.find(e => e.status === 'active');
    const activeEventContainer = document.getElementById('active-event-display');
    
    if (!activeEventContainer) return;

    // Stop countdown if no active event
    if (!activeEvent) {
      this.stopCountdown();
      activeEventContainer.innerHTML = `
        <div class="active-event-empty">
          <p>No active event at the moment</p>
        </div>
      `;
      return;
    }

    // Get price to beat for this event
    const priceToBeat = this.eventPriceToBeat.get(activeEvent.slug);
    const priceToBeatDisplay = priceToBeat !== undefined 
      ? this.formatPrice(priceToBeat) 
      : (this.currentPrice !== null ? this.formatPrice(this.currentPrice) + ' (current)' : 'Loading...');

    // If we have a current price but no stored price to beat, capture it now
    if (priceToBeat === undefined && this.currentPrice !== null) {
      this.eventPriceToBeat.set(activeEvent.slug, this.currentPrice);
    }

    activeEventContainer.innerHTML = `
      <div class="active-event-content">
        <div class="active-event-header">
          <span class="active-event-badge">ACTIVE EVENT</span>
          <span class="active-event-status">LIVE</span>
        </div>
        <div class="active-event-title">${activeEvent.title}</div>
        <div class="active-event-countdown">
          <span class="countdown-label">Time Remaining:</span>
          <span class="countdown-value" id="event-countdown">--:--:--</span>
        </div>
        <div class="active-event-price-to-beat">
          <span class="price-to-beat-label">Price to Beat:</span>
          <span class="price-to-beat-value">${priceToBeatDisplay}</span>
        </div>
        <div class="active-event-up-down-prices">
          <button class="up-down-button up-button" id="up-price-button">
            <span class="button-label">Up</span>
            <span class="button-price" id="up-price-value">${this.upPrice !== null ? this.formatUpDownPrice(this.upPrice) : '--'}</span>
          </button>
          <button class="up-down-button down-button" id="down-price-button">
            <span class="button-label">Down</span>
            <span class="button-price" id="down-price-value">${this.downPrice !== null ? this.formatUpDownPrice(this.downPrice) : '--'}</span>
          </button>
        </div>
        <div class="active-event-details">
          <div class="active-event-detail-item">
            <span class="detail-label">Start:</span>
            <span class="detail-value">${activeEvent.formattedStartDate}</span>
          </div>
          <div class="active-event-detail-item">
            <span class="detail-label">End:</span>
            <span class="detail-value">${activeEvent.formattedEndDate}</span>
          </div>
        </div>
        <div class="active-event-info">
          <div class="info-row">
            <span class="info-label">Condition ID:</span>
            <span class="info-value">${activeEvent.conditionId || '--'}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Question ID:</span>
            <span class="info-value">${activeEvent.questionId || '--'}</span>
          </div>
          <div class="info-row">
            <span class="info-label">CLOB Token IDs:</span>
            <span class="info-value">${activeEvent.clobTokenIds ? activeEvent.clobTokenIds.join(', ') : '--'}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Slug:</span>
            <span class="info-value slug-value">${activeEvent.slug}</span>
          </div>
        </div>
      </div>
    `;

    // Start countdown for active event
    this.startCountdown();
    
    // Update prices if we have token IDs
    if (activeEvent.clobTokenIds && activeEvent.clobTokenIds.length >= 2) {
      this.updateUpDownPrices();
    }
  }

  private renderEventsTable(): void {
    const events = this.eventManager.getEvents();
    const currentIndex = this.eventManager.getCurrentEventIndex();
    const tableBody = document.getElementById('events-table-body');
    
    if (!tableBody) return;

    // Capture price for newly active events
    this.capturePriceForActiveEvent();

    // Also update active event display
    this.renderActiveEvent();

    if (events.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px;">No events found</td></tr>';
      return;
    }

    tableBody.innerHTML = events.map((event, index) => {
      const isCurrent = index === currentIndex;
      const rowClass = isCurrent ? 'event-row current-event' : 'event-row';
      
      const statusClass = event.status === 'active' ? 'status-active' : 
                          event.status === 'expired' ? 'status-expired' : 'status-upcoming';
      const statusText = event.status === 'active' ? 'Active' : 
                        event.status === 'expired' ? 'Expired' : 'Upcoming';

      // Get last price for this event (from previous event's end)
      const lastPrice = this.eventLastPrice.get(event.slug) || event.lastPrice;
      const lastPriceDisplay = lastPrice !== undefined ? this.formatPrice(lastPrice) : '--';

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

  private render(): void {
    const app = document.getElementById('app');
    if (!app) {
      console.error('App element not found! Make sure index.html has <div id="app"></div>');
      return;
    }
    
    console.log('Rendering platform UI...');

    app.innerHTML = `
      <div class="container">
        <header>
          <h1>BTC/USD Streaming Platform</h1>
          <p class="subtitle">Real-time cryptocurrency price data from Polymarket</p>
        </header>

        <div class="controls">
          <div class="button-group">
            <button id="connect" class="btn btn-primary">Connect</button>
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
          <div class="price-label">Current Price</div>
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
          <div class="events-section-header" id="events-section-header">
            <h2>BTC Up/Down 15m Events</h2>
            <span class="events-chevron" id="events-chevron">▶</span>
          </div>
          <div class="events-section-content collapsed" id="events-section-content">
            <div id="events-error" class="error-message"></div>
            <div class="events-table-container">
              <table class="events-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Start Date</th>
                    <th>End Date</th>
                    <th>Status</th>
                    <th>Price to Beat</th>
                    <th>Condition ID</th>
                    <th>Question ID</th>
                    <th>CLOB Token IDs</th>
                    <th>Slug</th>
                  </tr>
                </thead>
                <tbody id="events-table-body">
                  <tr>
                    <td colspan="9" style="text-align: center; padding: 20px;">Loading events...</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="wallet-section" id="wallet-section">
          <h2>Wallet Connection</h2>
          <div class="wallet-controls">
            <div class="wallet-status">
              <div id="wallet-status-display"></div>
              <div class="wallet-actions">
                <button id="connect-wallet" class="btn btn-primary">Connect Wallet</button>
                <button id="disconnect-wallet" class="btn btn-secondary" style="display: none;">Disconnect Wallet</button>
                <button id="initialize-session" class="btn btn-primary" disabled>Initialize Trading Session</button>
              </div>
            </div>
            <div class="wallet-info" id="wallet-info" style="display: none;">
              <h3>Wallet Information</h3>
              <div class="wallet-details">
                <div class="wallet-detail-item">
                  <span class="detail-label">EOA Address:</span>
                  <span class="detail-value" id="eoa-address">--</span>
                </div>
                <div class="wallet-detail-item">
                  <span class="detail-label">Proxy Address:</span>
                  <span class="detail-value" id="proxy-address">--</span>
                </div>
                <div class="wallet-detail-item" id="balance-display" style="display: none;">
                  <span class="detail-label">Balance:</span>
                  <span class="detail-value" id="wallet-balance">--</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="orders-section" id="orders-section">
          <h2>Orders</h2>
          <div class="orders-controls">
            <button id="refresh-orders" class="btn btn-secondary">Refresh Orders</button>
            <span id="orders-count" class="orders-count">Loading...</span>
          </div>
          <div id="orders-container" class="orders-container">
            <p>Loading orders...</p>
          </div>
        </div>

        <div class="trading-section" id="trading-section">
          <h2>Automated Trading</h2>
          <div class="trading-controls">
            <div class="strategy-config">
              <h3>Strategy Configuration</h3>
              <div class="config-grid">
                <div class="config-item">
                  <label>
                    <input type="checkbox" id="strategy-enabled" />
                    Enable Strategy
                  </label>
                </div>
                  <div class="config-item">
                    <label>
                      Entry Price (0-100):
                      <input type="number" id="entry-price" value="96" min="0" max="100" step="0.01" />
                      <small>Order is filled when UP or DOWN value equals entryPrice (exact match)</small>
                    </label>
                  </div>
                  <div class="config-item">
                    <label>
                      Profit Target (0-100):
                      <input type="number" id="profit-target-price" value="100" min="0" max="100" step="0.01" />
                      <small>When active order's UP or DOWN value reaches this price, the order is sold</small>
                    </label>
                  </div>
                  <div class="config-item">
                    <label>
                      Stop Loss (0-100):
                      <input type="number" id="stop-loss-price" value="91" min="0" max="100" step="0.01" />
                      <small>When UP or DOWN value reaches this price, the order is sold</small>
                    </label>
                  </div>
                <div class="config-item">
                  <label>
                    Trade Size (USD):
                    <input type="number" id="trade-size" value="50" min="0" step="0.01" />
                  </label>
                </div>
                <div class="config-item">
                  <label>
                    Price Difference (USD):
                    <input type="number" id="price-difference" value="" min="0" step="0.01" placeholder="Optional" />
                    <small>Only trade when |Price to Beat - Current BTC Price| &gt; this value. Leave empty to disable.</small>
                  </label>
                </div>
                <div class="config-item">
                  <label>
                    Flip Guard – Pending distance (USD):
                    <input type="number" id="flip-guard-pending-distance" value="15" min="0" step="0.5" />
                    <small>Cancel pending entry bids when price distance drops below this.</small>
                  </label>
                </div>
                <div class="config-item">
                  <label>
                    Flip Guard – Filled distance (USD):
                    <input type="number" id="flip-guard-filled-distance" value="5" min="0" step="0.5" />
                    <small>Emergency market sell when filled and price distance drops below this.</small>
                  </label>
                </div>
                <div class="config-item">
                  <label>
                    Entry time remaining max (seconds):
                    <input type="number" id="entry-time-remaining-max" value="180" min="0" step="30" />
                    <small>Only enter when time left in event is less than this (e.g. 180 = 3 min).</small>
                  </label>
                </div>
                <div class="config-item">
                  <label>
                    <small>Direction: Automatically determined (UP or DOWN, whichever reaches entry price first)</small>
                  </label>
                </div>
              </div>
              <div class="config-actions">
                <button id="save-strategy" class="btn btn-primary">Save Strategy</button>
              </div>
            </div>
            <div class="trading-status-panel">
              <h3>Trading Status</h3>
              <div id="trading-status-display"></div>
              <div class="trading-actions">
                <button id="start-trading" class="btn btn-primary">Start Trading</button>
                <button id="stop-trading" class="btn btn-secondary">Stop Trading</button>
                <button id="sell-all-btn" class="btn btn-secondary" title="Emergency: sell all positions at market">Sell all / Emergency</button>
                <button id="clear-trades" class="btn btn-secondary">Clear Trades</button>
              </div>
            </div>
          </div>
          <div class="trades-history">
            <h3>Trade History</h3>
            <div id="trades-table-container"></div>
          </div>
        </div>

        <div class="info-section">
          <h2>About</h2>
          <p>This platform streams real-time BTC/USD price data from Polymarket's Real-Time Data Socket (RTDS).</p>
          <p>The data is sourced from Chainlink oracle networks, providing reliable and accurate Bitcoin price information.</p>
        </div>
      </div>
    `;
  }

  private updateTradingManager(): void {
    const events = this.eventManager.getEvents();
    const activeEvent = events.find(e => e.status === 'active');
    const priceToBeat = activeEvent ? this.eventPriceToBeat.get(activeEvent.slug) : null;

    this.tradingManager.updateMarketData(
      this.currentPrice,
      priceToBeat || null,
      activeEvent || null
    );
  }

  private saveStrategyConfig(): void {
    const enabled = (document.getElementById('strategy-enabled') as HTMLInputElement)?.checked || false;
    const entryPrice = parseFloat((document.getElementById('entry-price') as HTMLInputElement)?.value || '96');
    const profitTargetPrice = parseFloat((document.getElementById('profit-target-price') as HTMLInputElement)?.value || '100');
    const stopLossPrice = parseFloat((document.getElementById('stop-loss-price') as HTMLInputElement)?.value || '91');
    const tradeSize = parseFloat((document.getElementById('trade-size') as HTMLInputElement)?.value || '50');
    const priceDifferenceInput = (document.getElementById('price-difference') as HTMLInputElement)?.value;
    const priceDifference = priceDifferenceInput && priceDifferenceInput.trim() !== ''
      ? parseFloat(priceDifferenceInput)
      : null;
    const flipGuardPending = parseFloat((document.getElementById('flip-guard-pending-distance') as HTMLInputElement)?.value || '15');
    const flipGuardFilled = parseFloat((document.getElementById('flip-guard-filled-distance') as HTMLInputElement)?.value || '5');
    const entryTimeRemainingMax = parseFloat((document.getElementById('entry-time-remaining-max') as HTMLInputElement)?.value || '180');

    this.tradingManager.setStrategyConfig({
      enabled,
      entryPrice,
      profitTargetPrice,
      stopLossPrice,
      tradeSize,
      priceDifference,
      flipGuardPendingDistanceUsd: flipGuardPending,
      flipGuardFilledDistanceUsd: flipGuardFilled,
      entryTimeRemainingMaxSeconds: entryTimeRemainingMax,
    });

    alert('Strategy configuration saved!');
  }

  private renderTradingSection(): void {
    const status = this.tradingManager.getStatus();
    const config = this.tradingManager.getStrategyConfig();
    const trades = this.tradingManager.getTrades();

    // Update strategy config inputs
    const enabledInput = document.getElementById('strategy-enabled') as HTMLInputElement;
    const entryPriceInput = document.getElementById('entry-price') as HTMLInputElement;
    const profitTargetPriceInput = document.getElementById('profit-target-price') as HTMLInputElement;
    const stopLossPriceInput = document.getElementById('stop-loss-price') as HTMLInputElement;
    const tradeSizeInput = document.getElementById('trade-size') as HTMLInputElement;
    const priceDifferenceInput = document.getElementById('price-difference') as HTMLInputElement;
    const flipGuardPendingInput = document.getElementById('flip-guard-pending-distance') as HTMLInputElement;
    const flipGuardFilledInput = document.getElementById('flip-guard-filled-distance') as HTMLInputElement;
    const entryTimeRemainingInput = document.getElementById('entry-time-remaining-max') as HTMLInputElement;

    if (enabledInput) enabledInput.checked = config.enabled;
    if (entryPriceInput) entryPriceInput.value = config.entryPrice.toString();
    if (profitTargetPriceInput) profitTargetPriceInput.value = config.profitTargetPrice.toString();
    if (stopLossPriceInput) stopLossPriceInput.value = config.stopLossPrice.toString();
    if (tradeSizeInput) tradeSizeInput.value = config.tradeSize.toString();
    if (priceDifferenceInput) {
      priceDifferenceInput.value = config.priceDifference !== null && config.priceDifference !== undefined
        ? config.priceDifference.toString()
        : '';
    }
    if (flipGuardPendingInput) flipGuardPendingInput.value = (config.flipGuardPendingDistanceUsd ?? 15).toString();
    if (flipGuardFilledInput) flipGuardFilledInput.value = (config.flipGuardFilledDistanceUsd ?? 5).toString();
    if (entryTimeRemainingInput) entryTimeRemainingInput.value = (config.entryTimeRemainingMaxSeconds ?? 180).toString();

    // Update trading status display
    const statusDisplay = document.getElementById('trading-status-display');
    if (statusDisplay) {
      const positions = status.positions || [];
      const totalPositionSize = positions.reduce((sum, p) => sum + p.size, 0);
      const totalUnrealizedProfit = positions.reduce((sum, p) => sum + (p.unrealizedProfit || 0), 0);
      
      const positionInfo = positions.length > 0
        ? `
          <div class="position-info">
            <h4>Open Positions (${positions.length})</h4>
            <div style="margin-bottom: 15px; padding: 10px; background-color: #f5f5f5; border-radius: 4px;">
              <div style="font-weight: bold; margin-bottom: 8px; font-size: 1.1em;">Cumulative Summary</div>
              <div><strong>Total Position Size:</strong> $${totalPositionSize.toFixed(2)}</div>
              ${status.maxPositionSize !== undefined ? `<div><strong>Max Position Size:</strong> $${status.maxPositionSize.toFixed(2)} (50% of balance)</div>` : ''}
              ${totalUnrealizedProfit !== undefined ? `<div class="${totalUnrealizedProfit >= 0 ? 'profit' : 'loss'}" style="margin-top: 5px;"><strong>Total Unrealized P/L:</strong> $${totalUnrealizedProfit.toFixed(2)}</div>` : ''}
            </div>
            ${positions.map((position, index) => `
              <div class="position-details" style="margin-bottom: 15px; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">
                <div style="font-weight: bold; margin-bottom: 8px;">Position ${index + 1} of ${positions.length}</div>
                <div><strong>Event:</strong> ${position.eventSlug}</div>
                <div><strong>Direction:</strong> ${position.direction || 'N/A'}</div>
                <div><strong>Side:</strong> ${position.side}</div>
                <div><strong>Entry Price:</strong> ${position.entryPrice.toFixed(2)}</div>
                <div><strong>Size:</strong> $${position.size.toFixed(2)}</div>
                ${position.currentPrice !== undefined ? `<div><strong>Current Price:</strong> ${position.currentPrice.toFixed(2)}</div>` : '<div><strong>Current Price:</strong> <em>Updating...</em></div>'}
                ${position.unrealizedProfit !== undefined ? `<div class="${position.unrealizedProfit >= 0 ? 'profit' : 'loss'}"><strong>Unrealized P/L:</strong> $${position.unrealizedProfit.toFixed(2)}</div>` : ''}
              </div>
            `).join('')}
          </div>
        `
        : '<div class="no-position">No open positions</div>';

      statusDisplay.innerHTML = `
        <div class="status-summary">
          <div class="status-item">
            <span class="status-label">Trading Status:</span>
            <span class="${status.isActive ? 'status-active' : 'status-inactive'}">
              ${status.isActive ? 'ACTIVE' : 'INACTIVE'}
            </span>
          </div>
          <div class="status-item">
            <span class="status-label">Total Trades:</span>
            <span class="status-value">${status.totalTrades}</span>
          </div>
          <div class="status-item">
            <span class="status-label">Successful:</span>
            <span class="status-value success">${status.successfulTrades}</span>
          </div>
          <div class="status-item">
            <span class="status-label">Failed:</span>
            <span class="status-value failed">${status.failedTrades}</span>
          </div>
          <div class="status-item">
            <span class="status-label">Total Profit:</span>
            <span class="status-value ${status.totalProfit >= 0 ? 'profit' : 'loss'}">
              $${status.totalProfit.toFixed(2)}
            </span>
          </div>
          <div class="status-item">
            <span class="status-label">Pending Orders:</span>
            <span class="status-value">${status.pendingLimitOrders}</span>
          </div>
        </div>
        ${positionInfo}
      `;
    }

    // Update trades table
    const tradesContainer = document.getElementById('trades-table-container');
    if (tradesContainer) {
      if (trades.length === 0) {
        tradesContainer.innerHTML = '<p class="no-trades">No trades yet</p>';
      } else {
        tradesContainer.innerHTML = `
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

  // Wallet connection methods
  private async connectWallet(): Promise<void> {
    this.walletState.isLoading = true;
    this.walletState.error = null;
    this.renderWalletSection();

    try {
      console.log('[Wallet] Attempting to connect...');
      
      let response: Response;
      try {
        response = await fetch('/api/wallet', {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });
      } catch (fetchError) {
        // Network error or fetch failed
        console.error('[Wallet] Fetch error:', fetchError);
        const errorMsg = fetchError instanceof Error ? fetchError.message : 'Network error';
        throw new Error(`Failed to reach API server: ${errorMsg}. Please check if the API endpoint is available.`);
      }

      console.log('[Wallet] Response status:', response.status, response.statusText);
      
      // Try to parse response as JSON
      let responseData: any;
      try {
        const responseText = await response.text();
        console.log('[Wallet] Response text:', responseText.substring(0, 200));
        
        if (!responseText) {
          throw new Error('Empty response from server');
        }
        
        try {
          responseData = JSON.parse(responseText);
        } catch (parseError) {
          // Response is not JSON
          throw new Error(`Invalid response format: ${responseText.substring(0, 100)}`);
        }
      } catch (parseError) {
        console.error('[Wallet] Parse error:', parseError);
        throw new Error(parseError instanceof Error ? parseError.message : 'Failed to parse server response');
      }
      
      if (!response.ok) {
        console.error('[Wallet] Error response:', responseData);
        const errorMessage = responseData?.error || responseData?.message || `Server error (${response.status})`;
        throw new Error(errorMessage);
      }

      console.log('[Wallet] Success:', responseData);

      if (!responseData.eoaAddress || !responseData.proxyAddress) {
        console.error('[Wallet] Invalid data structure:', responseData);
        throw new Error('Invalid wallet data received: missing eoaAddress or proxyAddress');
      }

      this.walletState.eoaAddress = responseData.eoaAddress;
      this.walletState.proxyAddress = responseData.proxyAddress;
      this.walletState.isConnected = true;
      this.walletState.error = null;

      // Enable initialize button
      const initBtn = document.getElementById('initialize-session') as HTMLButtonElement;
      if (initBtn) {
        initBtn.disabled = false;
      }

      this.renderWalletSection();
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

  private disconnectWallet(): void {
    console.log('[Wallet] Disconnecting wallet...');
    
    // Stop trading if active
    if (this.tradingManager.getStatus().isActive) {
      this.tradingManager.stopTrading();
      console.log('[Wallet] Stopped active trading');
    }
    
    this.redemptionService?.stop();
    // Reset wallet state
    this.walletState.isConnected = false;
    this.walletState.isInitialized = false;
    this.walletState.eoaAddress = '';
    this.walletState.proxyAddress = '';
    this.walletState.balance = 0;
    this.walletState.apiCredentials = null;
    this.walletState.error = null;
    
    // Clear trading manager credentials
    this.tradingManager.setApiCredentials(null);
    this.tradingManager.setBrowserClobClient(null);
    
    // Update UI
    this.renderWalletSection();
    this.renderTradingSection();
    
    console.log('[Wallet] ✅ Wallet disconnected successfully');
  }

  private async initializeTradingSession(): Promise<void> {
    if (!this.walletState.isConnected) {
      alert('Please connect wallet first');
      return;
    }

    this.walletState.isLoading = true;
    this.walletState.error = null;
    this.renderWalletSection();

    try {
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

      this.walletState.isInitialized = true;
      this.redemptionService?.start();
      this.walletState.error = null;

      // Store API credentials in trading manager and wallet state
      if (data.credentials) {
        this.tradingManager.setApiCredentials(data.credentials);
        this.walletState.apiCredentials = data.credentials;
        
        // Initialize browser ClobClient for client-side order placement (bypasses Cloudflare)
        // CRITICAL: This must succeed - server-side API is blocked by Cloudflare
        await this.initializeBrowserClobClient();
        
        // Verify browser client was initialized
        if (!this.tradingManager.getBrowserClobClient()) {
          throw new Error('Browser ClobClient initialization failed. Cannot place orders - server-side API is blocked by Cloudflare. Please try reconnecting your wallet.');
        }
      }

      // Fetch balance after initialization
      await this.fetchBalance();

      // Fetch orders once after initialization
      this.fetchAndDisplayOrders();

      this.renderWalletSection();
      alert('Trading session initialized successfully!');
    } catch (error) {
      console.error('Trading session initialization error:', error);
      this.walletState.error = error instanceof Error ? error.message : 'Failed to initialize trading session';
      this.walletState.isInitialized = false;
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

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch balance');
      }

      this.walletState.balance = data.balance;
      // Update trading manager with wallet balance
      if (data.balance !== null && data.balance !== undefined) {
        this.tradingManager.setWalletBalance(data.balance);
      }
      this.renderWalletSection();
    } catch (error) {
      console.error('Balance fetch error:', error);
      // Don't set error state for balance, just log it
    } finally {
      this.walletState.balanceLoading = false;
      this.renderWalletSection();
    }
  }

  private renderWalletSection(): void {
    const statusDisplay = document.getElementById('wallet-status-display');
    const walletInfo = document.getElementById('wallet-info');
    const eoaAddressEl = document.getElementById('eoa-address');
    const proxyAddressEl = document.getElementById('proxy-address');
    const balanceEl = document.getElementById('wallet-balance');
    const balanceDisplay = document.getElementById('balance-display');
    const connectBtn = document.getElementById('connect-wallet') as HTMLButtonElement;
    const disconnectBtn = document.getElementById('disconnect-wallet') as HTMLButtonElement;
    const initBtn = document.getElementById('initialize-session') as HTMLButtonElement;

    if (statusDisplay) {
      let statusHtml = '';
      
      if (this.walletState.isLoading) {
        statusHtml = '<div class="wallet-status-loading">Loading...</div>';
      } else if (this.walletState.error) {
        statusHtml = `<div class="wallet-status-error">Error: ${this.walletState.error}</div>`;
      } else if (this.walletState.isConnected) {
        statusHtml = '<div class="wallet-status-connected">Wallet Connected</div>';
        if (this.walletState.isInitialized) {
          statusHtml += '<div class="wallet-status-initialized">Trading Session Initialized</div>';
        }
      } else {
        statusHtml = '<div class="wallet-status-disconnected">Wallet Not Connected</div>';
      }

      statusDisplay.innerHTML = statusHtml;
    }

    // Show/hide connect and disconnect buttons based on connection state
    if (connectBtn) {
      if (this.walletState.isConnected) {
        connectBtn.style.display = 'none';
      } else {
        connectBtn.style.display = 'inline-block';
        connectBtn.disabled = this.walletState.isLoading;
        connectBtn.textContent = this.walletState.isLoading ? 'Connecting...' : 'Connect Wallet';
      }
    }

    if (disconnectBtn) {
      if (this.walletState.isConnected) {
        disconnectBtn.style.display = 'inline-block';
        disconnectBtn.disabled = this.walletState.isLoading;
      } else {
        disconnectBtn.style.display = 'none';
      }
    }

    if (initBtn) {
      initBtn.disabled = this.walletState.isLoading || !this.walletState.isConnected || this.walletState.isInitialized;
      initBtn.textContent = this.walletState.isLoading ? 'Initializing...' : 
                           this.walletState.isInitialized ? 'Session Initialized' : 
                           'Initialize Trading Session';
    }

    if (this.walletState.isConnected && walletInfo) {
      walletInfo.style.display = 'block';
      
      if (eoaAddressEl) {
        eoaAddressEl.textContent = this.walletState.eoaAddress || '--';
      }
      
      if (proxyAddressEl) {
        proxyAddressEl.textContent = this.walletState.proxyAddress || '--';
      }

      if (this.walletState.isInitialized) {
        if (balanceDisplay) {
          balanceDisplay.style.display = 'block';
        }
        
        if (balanceEl) {
          if (this.walletState.balanceLoading) {
            balanceEl.textContent = 'Loading...';
          } else if (this.walletState.balance !== null) {
            balanceEl.textContent = `${this.walletState.balance.toFixed(2)} USDC.e`;
          } else {
            balanceEl.textContent = '--';
          }
        }
      } else {
        if (balanceDisplay) {
          balanceDisplay.style.display = 'none';
        }
      }
    } else if (walletInfo) {
      walletInfo.style.display = 'none';
    }
  }

  /**
   * Fetch and display active orders
   */
  private async fetchAndDisplayOrders(): Promise<void> {
    if (!this.walletState.isInitialized || !this.walletState.apiCredentials || !this.walletState.proxyAddress) {
      const ordersContainer = document.getElementById('orders-container');
      const ordersCount = document.getElementById('orders-count');
      if (ordersContainer) {
        // Show not initialized state with table structure
        ordersContainer.innerHTML = `
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
              <tr><td colspan="7" class="orders-empty-cell">Wallet not initialized. Please initialize trading session first.</td></tr>
            </tbody>
          </table>
        `;
      }
      if (ordersCount) {
        ordersCount.textContent = 'N/A';
      }
      return;
    }

    const ordersContainer = document.getElementById('orders-container');
    const ordersCount = document.getElementById('orders-count');

    if (ordersContainer) {
      // Show loading state with table structure
      ordersContainer.innerHTML = `
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
              <tr><td colspan="7" class="orders-loading-cell">Loading orders...</td></tr>
          </tbody>
        </table>
      `;
    }

    try {
      console.log('[Orders] Fetching active orders...');
      
      const response = await fetch(
        `/api/orders?apiCredentials=${encodeURIComponent(JSON.stringify(this.walletState.apiCredentials))}&proxyAddress=${encodeURIComponent(this.walletState.proxyAddress)}`
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch orders');
      }

      const orders = data.orders || [];
      console.log('[Orders] Fetched orders:', orders.length);
      
      // Get all positions from trading manager
      const status = this.tradingManager.getStatus();
      const positions = status.positions || [];
      
      // Count orders by status
      const liveOrders = orders.filter((o: any) => o.status === 'LIVE').length;
      const filledOrders = orders.filter((o: any) => 
        o.status === 'FILLED' || o.status === 'EXECUTED' || o.status === 'CLOSED'
      ).length;

      if (ordersCount) {
        const positionText = positions.length > 0 ? `${positions.length} position${positions.length > 1 ? 's' : ''}` : '';
        const ordersText = orders.length === 0 ? 'No orders' : `${orders.length} total (${liveOrders} live, ${filledOrders} filled)`;
        ordersCount.textContent = positions.length > 0 ? `${positionText}, ${ordersText}` : ordersText;
      }

      // Always render orders table with headers
      if (ordersContainer) {
        // Build position rows for all positions
        const positionRows = positions.map((position, index) => {
          // Get filled orders for this position
          const filledOrdersForPosition = position.filledOrders || [];
          const totalFilled = filledOrdersForPosition.reduce((sum, fo) => sum + fo.size, 0);
          const fillPercentage = position.size > 0 ? (totalFilled / position.size * 100).toFixed(1) : '0.0';
          
          // Get first order ID and hash from filled orders
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

        ordersContainer.innerHTML = `
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
              ${orders.length === 0 && positions.length === 0
                ? '<tr><td colspan="7" class="orders-empty-cell">No orders or positions</td></tr>'
                : orders.map((order: any) => {
                    const orderStatus = (order.status || 'UNKNOWN').toUpperCase();
                    const isFilled = orderStatus === 'FILLED' || orderStatus === 'EXECUTED' || orderStatus === 'CLOSED';
                    const isLive = orderStatus === 'LIVE';
                    const rowClass = isFilled ? 'order-row order-filled' : isLive ? 'order-row order-live' : 'order-row';
                    const fillPercentage = order.original_size > 0 
                      ? ((order.size_matched || 0) / order.original_size * 100).toFixed(1)
                      : '0.0';
                    
                    return `
                      <tr class="${rowClass}" data-order-id="${order.id}">
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
                            ? `<button class="btn-sell-order" 
                                 data-order-id="${order.id}" 
                                 data-token-id="${order.asset_id || order.token_id || ''}" 
                                 data-size="${order.size_matched || order.filled_size || order.original_size || order.size || 0}"
                                 data-price="${order.price || 0}">Sell</button>`
                            : '--'
                          }
                        </td>
                      </tr>
                    `;
                  }).join('')
              }
            </tbody>
          </table>
        `;

        // Add event listeners for cancel and sell buttons
        const cancelButtons = ordersContainer.querySelectorAll('.btn-cancel-order');
        cancelButtons.forEach(btn => {
          btn.addEventListener('click', async (e) => {
            const orderId = (e.target as HTMLButtonElement).getAttribute('data-order-id');
            if (orderId) {
              await this.cancelOrder(orderId);
            }
          });
        });

        // Add event listeners for sell buttons (both order sell and position sell)
        const sellButtons = ordersContainer.querySelectorAll('.btn-sell-order');
        sellButtons.forEach(btn => {
          btn.addEventListener('click', async (e) => {
            const isPosition = btn.classList.contains('btn-sell-position');
            const orderId = (e.target as HTMLButtonElement).getAttribute('data-order-id');
            const tokenId = (e.target as HTMLButtonElement).getAttribute('data-token-id');
            const size = (e.target as HTMLButtonElement).getAttribute('data-size');
            const price = (e.target as HTMLButtonElement).getAttribute('data-price');
            
            if (isPosition) {
              // Sell specific position
              const positionId = (e.target as HTMLButtonElement).getAttribute('data-position-id');
              if (positionId) {
                await this.sellPosition(positionId, tokenId || '', parseFloat(size || '0'), parseFloat(price || '0'));
              }
            } else if (orderId && tokenId && size) {
              // Sell specific order
              await this.sellOrder(orderId, tokenId, parseFloat(size), parseFloat(price || '0'));
            }
          });
        });
      }
    } catch (error) {
      console.error('[Orders] Error fetching orders:', error);
      if (ordersContainer) {
        // Show error state with table structure
        ordersContainer.innerHTML = `
          <table class="orders-table">
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Token ID</th>
                <th>Side</th>
                <th>Price</th>
                <th>Size</th>
                <th>Filled</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr><td colspan="9" class="orders-error-cell">Error loading orders: ${error instanceof Error ? error.message : 'Unknown error'}</td></tr>
            </tbody>
          </table>
        `;
      }
      if (ordersCount) {
        ordersCount.textContent = 'Error';
      }
    }
  }

  /**
   * Cancel an order
   */
  private async cancelOrder(orderId: string): Promise<void> {
    if (!this.walletState.apiCredentials) {
      alert('API credentials not available');
      return;
    }

    if (!confirm(`Are you sure you want to cancel order ${orderId.substring(0, 8)}...?`)) {
      return;
    }

    try {
      console.log('[Orders] Cancelling order:', orderId);

      const response = await fetch('/api/orders', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          orderId,
          apiCredentials: this.walletState.apiCredentials,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to cancel order');
      }

      console.log('[Orders] ✅ Order cancelled successfully:', orderId);

      // Refresh orders list
      await this.fetchAndDisplayOrders();
    } catch (error) {
      console.error('[Orders] ❌ Error cancelling order:', error);
      alert(`Failed to cancel order: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Sell position manually (by position ID)
   * Uses TradingManager's public method to close the position
   */
  private async sellPosition(positionId: string, tokenId: string, size: number, entryPrice: number): Promise<void> {
    if (!this.walletState.apiCredentials) {
      alert('API credentials not available');
      return;
    }

    // Get position details from trading manager
    const status = this.tradingManager.getStatus();
    const position = status.positions?.find(p => p.id === positionId);
    
    if (!position) {
      alert('Position not found');
      return;
    }

    if (!confirm(`Sell position?\nPosition ID: ${positionId.substring(0, 8)}...\nDirection: ${position.direction || 'N/A'}\nSize: $${size.toFixed(2)}\nEntry Price: ${entryPrice.toFixed(2)}`)) {
      return;
    }

    try {
      console.log('[Orders] Selling position manually:', {
        positionId,
        tokenId,
        size,
        entryPrice,
        direction: position.direction,
      });

      // Use TradingManager's public method to close the position
      await this.tradingManager.closePositionManually(positionId, 'Manual sell');
      
      console.log('[Orders] ✅ Position sold successfully');
      alert(`Position sold successfully!`);
      
      // Refresh orders list
      await this.fetchAndDisplayOrders();
    } catch (error) {
      console.error('[Orders] ❌ Error selling position:', error);
      alert(`Failed to sell position: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Sell order using order information
   * Sells the entire position (max shares) for the given order
   */
  private async sellOrder(orderId: string, tokenId: string, size: number, entryPrice: number): Promise<void> {
    if (!this.walletState.apiCredentials) {
      alert('API credentials not available');
      return;
    }

    if (!confirm(`Sell entire position for order ${orderId.substring(0, 8)}...?\nSize: $${size.toFixed(2)}\nEntry Price: ${entryPrice.toFixed(2)}`)) {
      return;
    }

    try {
      console.log('[Orders] Selling order:', {
        orderId,
        tokenId,
        size,
        entryPrice,
      });

      // Check if there's an active position for this token
      const status = this.tradingManager.getStatus();
      const position = status.positions?.find(p => p.tokenId === tokenId);
      
      if (position) {
        // If there's an active position for this token, use trading manager's closePosition
        console.log('[Orders] Found active position for this token, using TradingManager to close position');
        // Note: sellOrder is for selling a specific order, not a position
        // The position will be updated when the sell order is filled
      }

      // Place sell order directly
      if (this.tradingManager.getApiCredentials()) {
        const browserClobClient = (this.tradingManager as any).browserClobClient;
        
        if (browserClobClient) {
          const { OrderType, Side } = await import('@polymarket/clob-client');
          
          // Get bid price for SELL orders
          const bidPriceResponse = await browserClobClient.getPrice(tokenId, Side.SELL);
          const bidPrice = parseFloat(bidPriceResponse.price);
          
          if (isNaN(bidPrice) || bidPrice <= 0 || bidPrice >= 1) {
            throw new Error('Invalid market price for SELL');
          }

          // Get fee rate
          let feeRateBps: number;
          try {
            feeRateBps = await browserClobClient.getFeeRateBps(tokenId);
            if (!feeRateBps || feeRateBps === 0) {
              feeRateBps = 1000;
            }
          } catch (error) {
            feeRateBps = 1000;
          }

          // Calculate shares from USD size
          // Position size is in USD, so shares = USD / price
          const shares = size / bidPrice;

          const marketOrder = {
            tokenID: tokenId,
            amount: shares,
            side: Side.SELL,
            feeRateBps: feeRateBps,
          };

          console.log('[Orders] Browser SELL order details:', {
            bidPrice: bidPrice.toFixed(4),
            bidPricePercent: (bidPrice * 100).toFixed(2),
            positionSizeUSD: size,
            shares: shares.toFixed(2),
          });

          const response = await browserClobClient.createAndPostMarketOrder(
            marketOrder,
            { negRisk: false },
            OrderType.FAK
          );

          if (response?.orderID) {
            console.log('[Orders] ✅ SELL order placed successfully:', response.orderID);
            alert(`Sell order placed successfully!\nOrder ID: ${response.orderID.substring(0, 8)}...`);
            
            // Refresh orders list
            await this.fetchAndDisplayOrders();
          } else {
            throw new Error('Order submission failed - no order ID returned');
          }
        } else {
          // Fallback to server-side API - use SELL side for bid prices
          const bidPrice = await fetch(`/api/clob-proxy?side=SELL&token_id=${tokenId}`)
            .then(res => res.json())
            .then(data => parseFloat(data.price));

          if (!bidPrice || isNaN(bidPrice) || bidPrice <= 0 || bidPrice >= 1) {
            throw new Error('Invalid market price');
          }

          const shares = size / bidPrice;

          const response = await fetch('/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tokenId,
              size: shares,
              side: 'SELL',
              isMarketOrder: true,
              apiCredentials: this.walletState.apiCredentials,
              negRisk: false,
            }),
          });

          const data = await response.json();
          if (response.ok && data.orderId) {
            console.log('[Orders] ✅ SELL order placed successfully:', data.orderId);
            alert(`Sell order placed successfully!\nOrder ID: ${data.orderId.substring(0, 8)}...`);
            
            // Refresh orders list
            await this.fetchAndDisplayOrders();
          } else {
            throw new Error(data.error || 'Order failed');
          }
        }
      } else {
        throw new Error('API credentials not available');
      }
    } catch (error) {
      console.error('[Orders] ❌ Error selling order:', error);
      alert(`Failed to sell order: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Initialize browser ClobClient for client-side order placement (bypasses Cloudflare)
   */
  private async initializeBrowserClobClient(): Promise<void> {
    if (!this.walletState.isConnected || !this.walletState.apiCredentials) {
      console.warn('[Browser ClobClient] Cannot initialize - wallet not connected or credentials missing');
      return;
    }

    try {
      // Get private key from backend (for now, we'll need to pass it securely)
      // In production, consider using a browser wallet extension instead
      const response = await fetch('/api/wallet/private-key', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        // If endpoint doesn't exist, fall back to server-side API
        console.warn('[Browser ClobClient] Private key endpoint not available, will use server-side API');
        return;
      }

      const data = await response.json();
      if (!data.privateKey) {
        throw new Error('Private key not returned from server');
      }

      // Import the initialization function
      const { initializeBrowserClobClient } = await import('./streaming-platform-clob-init');
      
      // Initialize browser ClobClient
      const browserClobClient = await initializeBrowserClobClient(
        data.privateKey,
        this.walletState.apiCredentials!,
        this.walletState.proxyAddress!
      );

      // Set in trading manager
      this.tradingManager.setBrowserClobClient(browserClobClient);

      console.log('[Browser ClobClient] ✅ Successfully initialized and set in TradingManager');
    } catch (error) {
      console.error('[Browser ClobClient] ❌ Failed to initialize:', error);
      // Don't throw - fall back to server-side API
      console.warn('[Browser ClobClient] Will use server-side API (may be blocked by Cloudflare)');
    }
  }
}

