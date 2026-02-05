import { WebSocketClient } from './websocket-client';
import { EventManager } from './event-manager';
import { TradingManager } from './trading-manager';
import { RedemptionService } from './redemption-service';
import { getNext15MinIntervals } from './event-utils';
import type { PriceUpdate, ConnectionStatus } from './types';
import { Chart } from 'chart.js/auto';
import annotationPlugin from 'chartjs-plugin-annotation';
import { initializeBrowserClobClient as createBrowserClobClientFromInit } from './streaming-platform-clob-init';

Chart.register(annotationPlugin);

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
  private priceChart: Chart | null = null; // Chart.js line chart instance
  private ordersRefreshIntervalId: number | null = null; // Periodic refresh of orders/positions list
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
      // When any order is filled (buy or sell), refresh orders/positions list so UI stays in sync
      if (trade.status === 'filled') {
        this.fetchAndDisplayPositions();
        this.fetchAndDisplayOpenOrders();
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
      const btn = sellAllBtn as HTMLButtonElement;
      const originalText = btn.textContent;
      try {
        btn.disabled = true;
        btn.textContent = 'Selling...';
        await this.tradingManager.closeAllPositionsManually('Manual Sell all / Emergency');
        this.renderTradingSection();
        await this.fetchBalance();
        this.fetchAndDisplayPositions();
      } catch (e) {
        console.error('Sell all failed:', e);
        alert('Sell all failed: ' + (e instanceof Error ? e.message : String(e)));
      } finally {
        btn.disabled = false;
        btn.textContent = originalText ?? 'Sell all / Emergency';
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

    // Positions tab
    const refreshPositionsBtn = document.getElementById('refresh-positions');
    refreshPositionsBtn?.addEventListener('click', () => {
      this.fetchAndDisplayPositions();
    });
    const refreshOpenOrdersBtn = document.getElementById('refresh-open-orders');
    refreshOpenOrdersBtn?.addEventListener('click', () => {
      this.fetchAndDisplayOpenOrders();
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
      const iconName = change >= 0 ? 'trending_up' : 'trending_down';
      const text = `${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePercentValue >= 0 ? '+' : ''}${changePercent}%)`;
      changeElement.className = `text-sm mt-1 flex items-center gap-1 ${change >= 0 ? 'text-emerald-500' : 'text-red-500'}`;
      changeElement.innerHTML = `<span class="material-icons-round text-sm">${iconName}</span> ${text}`;
    }

    this.renderPriceLineChart();
  }

  private updateUI(): void {
    const statusElement = document.getElementById('connection-status');
    const errorElement = document.getElementById('error-message');

    if (statusElement) {
      const isConnected = this.currentStatus.connected;
      statusElement.textContent = isConnected ? 'Connected' : 'Disconnected';
      statusElement.className = `text-[11px] font-medium ${isConnected ? 'text-emerald-500' : 'text-slate-500'}`;
    }

    if (errorElement) {
      errorElement.textContent = this.currentStatus.error || '';
      (errorElement as HTMLElement).style.display = this.currentStatus.error ? 'block' : 'none';
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
      this.updateFooterIds('', '', '');
      activeEventContainer.innerHTML = `<div class="text-center py-8 text-slate-500">No active event at the moment</div>`;
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

    this.updateFooterIds(activeEvent.conditionId || '', activeEvent.questionId || '', '');

    const upPriceStr = this.upPrice !== null ? this.formatUpDownPrice(this.upPrice) : '--';
    const downPriceStr = this.downPrice !== null ? this.formatUpDownPrice(this.downPrice) : '--';

    activeEventContainer.innerHTML = `
      <div class="flex justify-between items-start mb-6">
        <div>
          <div class="flex items-center gap-3">
            <span class="bg-indigo-500/10 text-indigo-500 text-[10px] font-bold px-2 py-0.5 rounded border border-indigo-500/20 uppercase tracking-widest">Active Event</span>
            <span class="flex items-center gap-1 px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-[10px] font-bold">
              <span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span> LIVE
            </span>
          </div>
          <h3 class="text-2xl font-bold mt-2 text-slate-900 dark:text-white">${activeEvent.title}</h3>
          <p class="text-slate-500 text-sm mt-1">${activeEvent.formattedStartDate} – ${activeEvent.formattedEndDate}</p>
        </div>
        <div class="text-right">
          <p class="text-xs font-semibold text-slate-400 uppercase tracking-widest">Time Remaining</p>
          <div id="event-countdown" class="text-3xl font-mono font-bold text-indigo-500 mt-1">--:--:--</div>
        </div>
      </div>
      <div class="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-6 border border-slate-100 dark:border-slate-600 mb-8">
        <div class="flex flex-col items-center justify-center">
          <p class="text-sm font-medium text-slate-500 mb-1">Target Price to Beat</p>
          <p class="text-4xl font-mono font-bold text-violet-600 dark:text-violet-400 tracking-tighter">${priceToBeatDisplay}</p>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-6">
        <button type="button" class="group relative overflow-hidden bg-emerald-500 text-white p-6 rounded-2xl flex flex-col items-center gap-2 hover:opacity-90 transition-all transform active:scale-[0.98]" id="up-price-button">
          <span class="material-icons-round text-4xl group-hover:-translate-y-1 transition-transform">expand_less</span>
          <span class="text-2xl font-black uppercase tracking-widest">UP</span>
          <span class="text-lg font-bold bg-white/20 px-4 py-1 rounded-full" id="up-price-value">${upPriceStr}</span>
        </button>
        <button type="button" class="group relative overflow-hidden bg-red-500 text-white p-6 rounded-2xl flex flex-col items-center gap-2 hover:opacity-90 transition-all transform active:scale-[0.98]" id="down-price-button">
          <span class="material-icons-round text-4xl group-hover:translate-y-1 transition-transform">expand_more</span>
          <span class="text-2xl font-black uppercase tracking-widest">DOWN</span>
          <span class="text-lg font-bold bg-white/20 px-4 py-1 rounded-full" id="down-price-value">${downPriceStr}</span>
        </button>
      </div>
    `;

    // Start countdown for active event
    this.startCountdown();
    
    // Update prices if we have token IDs
    if (activeEvent.clobTokenIds && activeEvent.clobTokenIds.length >= 2) {
      this.updateUpDownPrices();
    }

    // Update line chart so Target line (price to beat) is shown
    this.renderPriceLineChart();
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

    if (this.priceChart) {
      try {
        this.priceChart.destroy();
      } catch {
        // ignore
      }
      this.priceChart = null;
    }

    console.log('Rendering platform UI...');

    app.innerHTML = `
      <header class="sticky top-0 z-50 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-black/90 backdrop-blur-md">
        <div class="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-8 h-8 bg-white border border-slate-200 rounded-lg flex items-center justify-center text-slate-700">
              <span class="material-icons-round text-xl">analytics</span>
            </div>
            <h1 class="text-xl font-bold tracking-tight">CryptoDash <span class="text-xs font-normal text-slate-500 dark:text-slate-400 ml-2">BTC/USD Streaming</span></h1>
          </div>
          <div class="flex items-center gap-4">
            <div id="wallet-status-display" class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-xs font-semibold">Wallet Not Connected</div>
            <button id="disconnect-wallet" type="button" class="px-4 py-2 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded-lg text-sm font-medium transition-all" style="display: none;">Disconnect</button>
          </div>
        </div>
      </header>

      <div id="error-message" class="max-w-7xl mx-auto px-4 py-1 text-sm text-red-600 dark:text-red-400"></div>

      <main class="max-w-7xl mx-auto px-4 py-8">
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          <div class="lg:col-span-2 bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm relative overflow-hidden">
            <div class="flex justify-between items-start mb-4">
              <div>
                <p class="text-sm font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">Current BTC Price</p>
                <div id="current-price" class="text-5xl font-black mt-1 tabular-nums text-slate-900 dark:text-white">--</div>
                <p id="price-change" class="text-sm mt-1 flex items-center gap-1 text-slate-500">--</p>
              </div>
              <div class="text-right">
                <p class="text-xs text-slate-400">Last Update</p>
                <p id="price-timestamp" class="text-sm font-mono text-slate-500 dark:text-slate-400">--</p>
              </div>
            </div>
            <div id="price-chart-wrapper" class="w-full mt-4 price-chart-gradient rounded">
              <canvas id="price-line-chart" role="img" aria-label="BTC price line chart with target"></canvas>
            </div>
          </div>
          <div class="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col justify-between">
            <div class="space-y-4">
              <h3 class="text-sm font-semibold text-slate-400 uppercase tracking-wider">Session Stats</h3>
              <div id="trading-status-display" class="grid grid-cols-2 gap-4">
                <div class="bg-slate-50 dark:bg-slate-700/50 p-4 rounded-xl"><p class="text-xs text-slate-500">Total Profit</p><p class="text-xl font-bold text-emerald-500">$0.00</p></div>
                <div class="bg-slate-50 dark:bg-slate-700/50 p-4 rounded-xl"><p class="text-xs text-slate-500">Win Rate</p><p class="text-xl font-bold">0%</p></div>
                <div class="bg-slate-50 dark:bg-slate-700/50 p-4 rounded-xl"><p class="text-xs text-slate-500">Total Trades</p><p class="text-xl font-bold">0</p></div>
                <div class="bg-slate-50 dark:bg-slate-700/50 p-4 rounded-xl"><p class="text-xs text-slate-500">Pending</p><p class="text-xl font-bold">0</p></div>
              </div>
            </div>
            <div class="mt-6 pt-6 border-t border-slate-100 dark:border-slate-700">
              <h3 class="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">Bot status – Bought token</h3>
              <div id="active-position-box" class="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 min-h-[100px] border border-slate-200 dark:border-slate-600">
                <p class="text-slate-500 text-sm">No active trade to show.</p>
              </div>
            </div>
            <div class="mt-6 pt-6 border-t border-slate-100 dark:border-slate-700">
              <div class="flex items-center justify-between text-sm">
                <span class="text-slate-500">Trading Status</span>
                <span id="trading-status-badge" class="flex items-center gap-1.5 font-bold text-slate-500"><span class="w-2 h-2 rounded-full bg-slate-400"></span> INACTIVE</span>
              </div>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-12 gap-6">
          <div class="xl:col-span-8 space-y-6">
            <div class="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-lg overflow-hidden">
              <div class="bg-white border-b border-slate-200 h-1"></div>
              <div class="p-6">
                <div id="active-event-display">
                  <div class="text-center py-8 text-slate-500">Loading events...</div>
                </div>
              </div>
            </div>
            <div class="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
              <div class="border-b border-slate-200 dark:border-slate-700">
                <nav class="flex px-6" aria-label="Tabs">
                  <button type="button" data-tab="positions" class="tab-btn border-b-2 border-indigo-500 py-4 px-6 text-sm font-bold text-indigo-500">Positions</button>
                  <button type="button" data-tab="open-orders" class="tab-btn border-b-2 border-transparent py-4 px-6 text-sm font-medium text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">Open Orders</button>
                  <button type="button" data-tab="history" class="tab-btn border-b-2 border-transparent py-4 px-6 text-sm font-medium text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">History</button>
                  <button type="button" data-tab="wallet" class="tab-btn border-b-2 border-transparent py-4 px-6 text-sm font-medium text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">Wallet Info</button>
                </nav>
              </div>
              <div class="p-6">
                <div id="tab-positions" class="tab-panel">
                  <div id="positions-section" class="flex flex-wrap items-center justify-between gap-4 mb-4">
                    <button id="refresh-positions" type="button" class="px-4 py-2 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded-lg text-sm font-medium">Refresh</button>
                    <span id="positions-count" class="text-sm text-slate-500">Loading...</span>
                  </div>
                  <div id="positions-container" class="min-h-[100px]">Loading positions...</div>
                </div>
                <div id="tab-open-orders" class="tab-panel hidden">
                  <div id="open-orders-section" class="flex flex-wrap items-center justify-between gap-4 mb-4">
                    <button id="refresh-open-orders" type="button" class="px-4 py-2 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded-lg text-sm font-medium">Refresh</button>
                    <span id="open-orders-count" class="text-sm text-slate-500">—</span>
                  </div>
                  <div id="open-orders-container" class="min-h-[80px] text-sm text-slate-500">Switch to this tab or click Refresh to load open orders.</div>
                </div>
                <div id="tab-history" class="tab-panel hidden">
                  <div id="trades-table-container"></div>
                </div>
                <div id="tab-wallet" class="tab-panel hidden">
                  <div id="wallet-section" class="space-y-4">
                    <div id="wallet-status-display-tab"></div>
                    <div class="flex flex-wrap gap-2">
                      <button id="connect-wallet" type="button" class="px-4 py-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg text-sm font-medium">Connect Wallet</button>
                      <button id="initialize-session" type="button" class="px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg text-sm font-medium disabled:opacity-50" disabled>Initialize Trading Session</button>
                    </div>
                    <div id="wallet-info" class="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 space-y-2" style="display: none;">
                      <div class="flex justify-between"><span class="text-slate-500 text-sm">EOA Address:</span><span id="eoa-address" class="font-mono text-xs break-all">--</span></div>
                      <div class="flex justify-between"><span class="text-slate-500 text-sm">Proxy Address:</span><span id="proxy-address" class="font-mono text-xs break-all">--</span></div>
                      <div id="balance-display" class="flex justify-between" style="display: none;"><span class="text-slate-500 text-sm">Balance:</span><span id="wallet-balance" class="font-mono text-sm">--</span></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="events-section border border-slate-200 dark:border-slate-700 rounded-2xl bg-white dark:bg-slate-800 overflow-hidden">
              <div id="events-section-header" class="flex justify-between items-center px-6 py-4 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50">
                <h2 class="font-bold text-slate-900 dark:text-white">BTC Up/Down 15m Events</h2>
                <span id="events-chevron" class="text-indigo-500 font-bold">▶</span>
              </div>
              <div id="events-section-content" class="events-section-content collapsed overflow-x-auto">
                <div id="events-error" class="px-6 py-2 text-sm text-red-600"></div>
                <table class="w-full text-sm border-collapse">
                  <thead><tr><th class="text-left p-2 border-b border-slate-200 dark:border-slate-700">Title</th><th class="text-left p-2 border-b">Start</th><th class="text-left p-2 border-b">End</th><th class="text-left p-2 border-b">Status</th><th class="text-left p-2 border-b">Price to Beat</th><th class="text-left p-2 border-b">Condition ID</th><th class="text-left p-2 border-b">Question ID</th><th class="text-left p-2 border-b">CLOB Token IDs</th><th class="text-left p-2 border-b">Slug</th></tr></thead>
                  <tbody id="events-table-body"><tr><td colspan="9" class="p-4 text-center text-slate-500">Loading...</td></tr></tbody>
                </table>
              </div>
            </div>
          </div>

          <div class="xl:col-span-4 space-y-6">
            <div class="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
              <div class="p-5 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center">
                <h3 class="font-bold flex items-center gap-2 text-slate-900 dark:text-white"><span class="material-icons-round text-indigo-500">settings</span> Strategy Config</h3>
                <label class="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" id="strategy-enabled" class="sr-only peer" />
                  <div class="w-11 h-6 bg-slate-200 dark:bg-slate-700 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-white peer-checked:border peer-checked:border-slate-300"></div>
                </label>
              </div>
              <div class="p-6 space-y-5">
                <div class="grid grid-cols-2 gap-4">
                  <div class="space-y-1.5"><label class="text-xs font-bold text-slate-500 uppercase">Entry Price (0-100)</label><input type="number" id="entry-price" value="96" min="0" max="100" step="0.01" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm" /></div>
                  <div class="space-y-1.5"><label class="text-xs font-bold text-slate-500 uppercase">Profit Target</label><input type="number" id="profit-target-price" value="100" min="0" max="100" step="0.01" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm" /></div>
                </div>
                <div class="grid grid-cols-2 gap-4">
                  <div class="space-y-1.5"><label class="text-xs font-bold text-slate-500 uppercase">Stop Loss</label><input type="number" id="stop-loss-price" value="91" min="0" max="100" step="0.01" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm" /></div>
                  <div class="space-y-1.5">
                  <label class="text-xs font-bold text-slate-500 uppercase">Trade Size</label>
                  <div class="flex gap-2 items-center">
                    <input type="number" id="trade-size" value="50" min="0" step="0.01" class="flex-1 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm" />
                    <select id="trade-size-unit" class="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm min-w-[80px]">
                      <option value="USD">USD</option>
                      <option value="shares">Shares</option>
                    </select>
                  </div>
                </div>
                </div>
                <div class="space-y-1.5"><label class="text-xs font-bold text-slate-500 uppercase">Price Difference (USD)</label><input type="number" id="price-difference" value="" min="0" step="0.01" placeholder="Optional" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm" /></div>
                <div class="grid grid-cols-2 gap-4">
                  <div class="space-y-1.5"><label class="text-xs font-bold text-slate-500 uppercase">Flip Guard Pending (USD)</label><input type="number" id="flip-guard-pending-distance" value="15" min="0" step="0.5" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm" /></div>
                  <div class="space-y-1.5"><label class="text-xs font-bold text-slate-500 uppercase">Flip Guard Filled (USD)</label><input type="number" id="flip-guard-filled-distance" value="5" min="0" step="0.5" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm" /></div>
                </div>
                <div class="space-y-1.5"><label class="text-xs font-bold text-slate-500 uppercase">Entry time remaining max (s)</label><input type="number" id="entry-time-remaining-max" value="180" min="0" step="30" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm" /></div>
                <button id="save-strategy" type="button" class="w-full bg-white border border-slate-200 text-slate-700 font-bold py-3 rounded-xl hover:bg-slate-50 transition-colors shadow-lg">Save Strategy</button>
                <div class="grid grid-cols-2 gap-3 pt-4 border-t border-slate-100 dark:border-slate-700">
                  <button id="start-trading" type="button" class="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 font-bold py-2 rounded-lg text-sm flex items-center justify-center gap-1"><span class="material-icons-round text-sm">play_arrow</span> Start</button>
                  <button id="stop-trading" type="button" class="bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 font-bold py-2 rounded-lg text-sm flex items-center justify-center gap-1"><span class="material-icons-round text-sm">stop</span> Stop</button>
                </div>
                <button id="sell-all-btn" type="button" class="w-full bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-bold py-2 rounded-lg text-sm">Sell all / Emergency</button>
                <button id="clear-trades" type="button" class="w-full bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-bold py-2 rounded-lg text-sm">Clear Current Trades</button>
              </div>
            </div>
            <div class="bg-slate-100 dark:bg-slate-800/50 rounded-2xl p-6 border border-slate-200 dark:border-slate-700">
              <h4 class="text-sm font-bold mb-2 text-slate-900 dark:text-white">About Platform</h4>
              <p class="text-xs text-slate-500 leading-relaxed">This platform streams real-time BTC/USD price data from Polymarket's Real-Time Data Socket (RTDS). Data is sourced via Chainlink oracle networks for reliable settlement.</p>
            </div>
          </div>
        </div>
      </main>

      <footer class="max-w-7xl mx-auto px-4 py-12 border-t border-slate-200 dark:border-slate-800 mt-12">
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          <div class="space-y-2"><p class="text-[10px] font-bold text-slate-400 uppercase">Condition ID</p><p id="footer-condition-id" class="text-[11px] font-mono break-all text-slate-500">--</p></div>
          <div class="space-y-2"><p class="text-[10px] font-bold text-slate-400 uppercase">Question ID</p><p id="footer-question-id" class="text-[11px] font-mono break-all text-slate-500">--</p></div>
          <div class="space-y-2"><p class="text-[10px] font-bold text-slate-400 uppercase">Proxy Address</p><p id="footer-proxy" class="text-[11px] font-mono break-all text-slate-500">--</p></div>
          <div class="space-y-2"><p class="text-[10px] font-bold text-slate-400 uppercase">Status</p><div class="flex items-center gap-2"><span id="connection-status" class="text-slate-500 text-[11px]">Disconnected</span><button id="connect" type="button" class="text-xs text-indigo-500 hover:underline">Connect</button><button id="disconnect" type="button" class="text-xs text-slate-500 hover:underline">Disconnect</button></div></div>
        </div>
      </footer>

      <button type="button" data-dark-toggle class="fixed bottom-6 right-6 p-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-full shadow-xl hover:scale-110 transition-transform" aria-label="Toggle dark mode">
        <span class="material-icons-round block dark:hidden">dark_mode</span>
        <span class="material-icons-round hidden dark:block">light_mode</span>
      </button>
    `;

    this.setupTabListeners();
    this.renderPriceLineChart();
  }

  private setupTabListeners(): void {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const panels = document.querySelectorAll('.tab-panel');
    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = (btn as HTMLElement).getAttribute('data-tab');
        tabBtns.forEach((b) => {
          b.classList.remove('border-indigo-500', 'text-indigo-500', 'font-bold');
          b.classList.add('border-transparent', 'text-slate-500', 'font-medium');
        });
        btn.classList.add('border-indigo-500', 'text-indigo-500', 'font-bold');
        btn.classList.remove('border-transparent', 'text-slate-500');
        panels.forEach((panel) => {
          const id = panel.getAttribute('id');
          if (id === `tab-${tab}`) {
            panel.classList.remove('hidden');
          } else {
            panel.classList.add('hidden');
          }
        });
        if (tab === 'open-orders') {
          this.fetchAndDisplayOpenOrders();
        }
        if (tab === 'positions') {
          this.fetchAndDisplayPositions();
        }
      });
    });
  }

  private renderPriceLineChart(): void {
    const canvas = document.getElementById('price-line-chart') as HTMLCanvasElement | null;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const events = this.eventManager.getEvents();
    const activeEvent = events.find((e) => e.status === 'active');
    const priceToBeat = activeEvent ? this.eventPriceToBeat.get(activeEvent.slug) : undefined;

    const slice = this.priceHistory.slice(-60);
    const labels = slice.length > 0
      ? slice.map((d) => new Date(d.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }))
      : [''];
    const data = slice.length > 0 ? slice.map((d) => d.value) : [0];

    // Y-axis range: include all price data and the target (price to beat) so both the orange line and target line are visible
    const dataMin = data.length > 0 ? Math.min(...data) : 0;
    const dataMax = data.length > 0 ? Math.max(...data) : 100;
    let yMin = dataMin;
    let yMax = dataMax;
    if (priceToBeat != null && priceToBeat > 0) {
      yMin = Math.min(yMin, priceToBeat);
      yMax = Math.max(yMax, priceToBeat);
    }
    const padding = Math.max(25, (yMax - yMin) * 0.05);
    const suggestedMin = yMin - padding;
    const suggestedMax = yMax + padding;

    const isDark = document.documentElement.classList.contains('dark');
    const gridColor = isDark ? 'rgba(148, 163, 184, 0.15)' : 'rgba(148, 163, 184, 0.2)';
    const textColor = isDark ? '#94a3b8' : '#64748b';

    const annotation: Record<string, unknown> = {};
    if (priceToBeat != null && priceToBeat > 0) {
      annotation.targetLine = {
        type: 'line',
        scaleID: 'y',
        yMin: priceToBeat,
        yMax: priceToBeat,
        borderColor: '#64748b',
        borderWidth: 2,
        borderDash: [6, 4],
        label: {
          display: true,
          content: 'Target',
          position: 'end',
          backgroundColor: 'rgba(100, 116, 139, 0.9)',
          color: '#fff',
          font: { size: 11, weight: '600' },
        },
      };
    }

    if (this.priceChart) {
      this.priceChart.data.labels = labels;
      this.priceChart.data.datasets[0].data = data;
      const opts = this.priceChart.options.plugins?.annotation as { annotations?: Record<string, unknown> } | undefined;
      if (opts) opts.annotations = annotation;
      // Update Y scale so axis matches current price range (and includes target)
      const yScale = this.priceChart.options.scales?.y as { min?: number; max?: number; suggestedMin?: number; suggestedMax?: number } | undefined;
      if (yScale) {
        yScale.min = suggestedMin;
        yScale.max = suggestedMax;
      }
      this.priceChart.update('none');
      return;
    }

    const chartConfig = {
      type: 'line' as const,
      data: {
        labels,
        datasets: [
          {
            label: 'BTC Price',
            data,
            borderColor: '#f97316',
            backgroundColor: 'rgba(249, 115, 22, 0.08)',
            fill: true,
            tension: 0.2,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' as const },
        plugins: {
          legend: { display: false },
          annotation: { annotations: annotation },
        },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: { maxTicksLimit: 6, color: textColor, font: { size: 10 } },
          },
          y: {
            position: 'right' as const,
            grid: { color: gridColor },
            suggestedMin,
            suggestedMax,
            ticks: {
              color: textColor,
              font: { size: 10 },
              callback: (value: string | number) => (typeof value === 'number' ? `$${value.toLocaleString()}` : value),
            },
          },
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.priceChart = new Chart(ctx, chartConfig as any);
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
    const tradeSizeUnit = ((document.getElementById('trade-size-unit') as HTMLSelectElement)?.value || 'USD') as 'USD' | 'shares';
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
      tradeSizeUnit,
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
    const tradeSizeUnitSelect = document.getElementById('trade-size-unit') as HTMLSelectElement;
    const priceDifferenceInput = document.getElementById('price-difference') as HTMLInputElement;
    const flipGuardPendingInput = document.getElementById('flip-guard-pending-distance') as HTMLInputElement;
    const flipGuardFilledInput = document.getElementById('flip-guard-filled-distance') as HTMLInputElement;
    const entryTimeRemainingInput = document.getElementById('entry-time-remaining-max') as HTMLInputElement;

    if (enabledInput) enabledInput.checked = config.enabled;
    if (entryPriceInput) entryPriceInput.value = config.entryPrice.toString();
    if (profitTargetPriceInput) profitTargetPriceInput.value = config.profitTargetPrice.toString();
    if (stopLossPriceInput) stopLossPriceInput.value = config.stopLossPrice.toString();
    if (tradeSizeInput) tradeSizeInput.value = config.tradeSize.toString();
    if (tradeSizeUnitSelect) tradeSizeUnitSelect.value = config.tradeSizeUnit ?? 'USD';
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
      const winRate = status.totalTrades > 0 ? ((status.successfulTrades / status.totalTrades) * 100).toFixed(0) : '0';
      const profitClass = status.totalProfit >= 0 ? 'text-emerald-500' : 'text-red-500';
      statusDisplay.innerHTML = `
        <div class="grid grid-cols-2 gap-4">
          <div class="bg-slate-50 dark:bg-slate-700/50 p-4 rounded-xl">
            <p class="text-xs text-slate-500">Total Profit</p>
            <p class="text-xl font-bold ${profitClass}">$${status.totalProfit.toFixed(2)}</p>
          </div>
          <div class="bg-slate-50 dark:bg-slate-700/50 p-4 rounded-xl">
            <p class="text-xs text-slate-500">Win Rate</p>
            <p class="text-xl font-bold">${winRate}%</p>
          </div>
          <div class="bg-slate-50 dark:bg-slate-700/50 p-4 rounded-xl">
            <p class="text-xs text-slate-500">Total Trades</p>
            <p class="text-xl font-bold">${status.totalTrades}</p>
          </div>
          <div class="bg-slate-50 dark:bg-slate-700/50 p-4 rounded-xl">
            <p class="text-xs text-slate-500">Pending</p>
            <p class="text-xl font-bold">${status.pendingLimitOrders}</p>
          </div>
        </div>
      `;

      const badgeEl = document.getElementById('trading-status-badge');
      if (badgeEl) {
        badgeEl.innerHTML = status.isActive
          ? '<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span class="text-emerald-500">ACTIVE</span>'
          : '<span class="w-2 h-2 rounded-full bg-slate-400"></span><span class="text-slate-500">INACTIVE</span>';
        badgeEl.className = `flex items-center gap-1.5 font-bold text-sm ${status.isActive ? 'text-emerald-500' : 'text-slate-500'}`;
      }
    }

    // Active position box (bot status – bought token)
    const activePositionBox = document.getElementById('active-position-box');
    if (activePositionBox) {
      const positions = status.positions ?? [];
      if (positions.length === 0) {
        activePositionBox.innerHTML = '<p class="text-slate-500 text-sm">No active trade to show.</p>';
      } else {
        const totalSize = positions.reduce((s, p) => s + p.size, 0);
        const totalUnrealized = positions.reduce((s, p) => s + (p.unrealizedProfit ?? 0), 0);
        const first = positions[0];
        const currentPrice = first.currentPrice ?? 0;
        const direction = first.direction ?? 'UP';
        const entryPrice = first.entryPrice;
        const entryTime = positions.reduce((earliest, p) => (p.entryTimestamp < earliest ? p.entryTimestamp : earliest), positions[0].entryTimestamp);
        const currentValue = totalSize + totalUnrealized;
        const unrealizedClass = totalUnrealized >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
        activePositionBox.innerHTML = `
          <div class="space-y-2 text-sm">
            <div class="flex justify-between"><span class="text-slate-500">Direction</span><span class="font-medium">${direction}</span></div>
            <div class="flex justify-between"><span class="text-slate-500">Current price</span><span class="font-mono font-medium">${currentPrice.toFixed(2)}</span></div>
            <div class="flex justify-between"><span class="text-slate-500">Entry price</span><span class="font-mono">${entryPrice.toFixed(2)}</span></div>
            <div class="flex justify-between"><span class="text-slate-500">Position size</span><span class="font-mono">$${totalSize.toFixed(2)}</span></div>
            <div class="flex justify-between"><span class="text-slate-500">Value (est.)</span><span class="font-mono">$${currentValue.toFixed(2)}</span></div>
            <div class="flex justify-between"><span class="text-slate-500">Unrealized P&amp;L</span><span class="font-mono font-medium ${unrealizedClass}">$${totalUnrealized >= 0 ? '+' : ''}${totalUnrealized.toFixed(2)}</span></div>
            <div class="flex justify-between"><span class="text-slate-500">Entry time</span><span class="font-mono text-xs">${new Date(entryTime).toLocaleString()}</span></div>
          </div>
        `;
      }
    }

    // History tab: show only filled orders (buy and sell) by the bot; deduplicate by order (transactionHash) so each execution shows once
    const tradesContainer = document.getElementById('trades-table-container');
    if (tradesContainer) {
      const filled = trades.filter((t) => t.status === 'filled');
      const seenOrderIds = new Set<string>();
      const filledTrades = filled
        .filter((t) => {
          const key = t.transactionHash ?? t.id;
          if (seenOrderIds.has(key)) return false;
          seenOrderIds.add(key);
          return true;
        })
        .slice()
        .reverse();
      if (filledTrades.length === 0) {
        tradesContainer.innerHTML = '<p class="no-trades text-slate-500 text-sm">No filled orders yet. Filled buy and sell orders executed by the bot will appear here.</p>';
      } else {
        tradesContainer.innerHTML = `
          <p class="text-slate-500 text-xs mb-2">Filled orders (buy & sell) executed by the bot — most recent first.</p>
          <table class="trades-table w-full border-collapse text-sm">
            <thead>
              <tr class="border-b border-slate-200 dark:border-slate-700">
                <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Time</th>
                <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Event</th>
                <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Side</th>
                <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Size</th>
                <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Price</th>
                <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Type</th>
                <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Profit</th>
                <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Reason</th>
              </tr>
            </thead>
            <tbody>
              ${filledTrades.map((trade) => `
                <tr class="trade-row trade-filled border-b border-slate-100 dark:border-slate-700/50">
                  <td class="py-2 pr-2">${new Date(trade.timestamp).toLocaleString()}</td>
                  <td class="event-slug py-2 pr-2">${trade.eventSlug}</td>
                  <td class="py-2 pr-2"><span class="side-${trade.side.toLowerCase()}">${trade.side}</span>${trade.direction ? ` <span class="direction-badge direction-${trade.direction.toLowerCase()}">${trade.direction}</span>` : ''}</td>
                  <td class="py-2 pr-2">$${trade.size.toFixed(2)}</td>
                  <td class="py-2 pr-2">${trade.price.toFixed(2)}${trade.orderType === 'LIMIT' && trade.limitPrice ? ` (limit: ${trade.limitPrice.toFixed(2)})` : ''}</td>
                  <td class="py-2 pr-2">${trade.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET'}</td>
                  <td class="py-2 pr-2 ${trade.profit !== undefined ? (trade.profit >= 0 ? 'profit text-emerald-600' : 'loss text-red-600') : ''}">${trade.profit !== undefined ? `$${trade.profit.toFixed(2)}` : '—'}</td>
                  <td class="reason py-2 pr-2 text-slate-600 dark:text-slate-400">${trade.reason}</td>
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
    this.stopOrdersRefreshInterval();

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
      this.fetchAndDisplayPositions();
      this.startOrdersRefreshInterval();

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

  private updateFooterIds(conditionId: string, questionId: string, proxy: string): void {
    const condEl = document.getElementById('footer-condition-id');
    const qEl = document.getElementById('footer-question-id');
    const proxyEl = document.getElementById('footer-proxy');
    if (condEl) condEl.textContent = conditionId || '--';
    if (qEl) qEl.textContent = questionId || '--';
    if (proxyEl) proxyEl.textContent = proxy || this.walletState.proxyAddress || '--';
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
        statusHtml = '<span class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 text-xs font-semibold">Loading...</span>';
      } else if (this.walletState.error) {
        statusHtml = `<span class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-xs font-semibold">Error: ${this.walletState.error}</span>`;
      } else if (this.walletState.isConnected) {
        statusHtml = '<span class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 text-xs font-semibold"><span class="relative flex h-2 w-2"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span></span> WALLET CONNECTED</span>';
      } else {
        statusHtml = '<span class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-xs font-semibold">Wallet Not Connected</span>';
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

    const footerProxy = document.getElementById('footer-proxy');
    if (footerProxy) footerProxy.textContent = this.walletState.proxyAddress || '--';
  }

  private startOrdersRefreshInterval(): void {
    this.stopOrdersRefreshInterval();
    const intervalMs = 20000; // 20 seconds
    this.ordersRefreshIntervalId = window.setInterval(() => {
      if (this.walletState.proxyAddress) {
        this.fetchAndDisplayPositions();
      }
    }, intervalMs);
  }

  private stopOrdersRefreshInterval(): void {
    if (this.ordersRefreshIntervalId !== null) {
      window.clearInterval(this.ordersRefreshIntervalId);
      this.ordersRefreshIntervalId = null;
    }
  }

  /**
   * Fetch and display active positions from Polymarket Data API.
   */
  private async fetchAndDisplayPositions(): Promise<void> {
    const container = document.getElementById('positions-container');
    const countEl = document.getElementById('positions-count');

    if (!this.walletState.proxyAddress) {
      if (container) {
        container.innerHTML = `<p class="text-slate-500 text-sm">Connect wallet and initialize to see positions.</p>`;
      }
      if (countEl) countEl.textContent = '—';
      return;
    }

    if (container) {
      container.innerHTML = `<p class="text-slate-500 text-sm">Loading positions...</p>`;
    }
    if (countEl) countEl.textContent = 'Loading...';

    try {
      const response = await fetch(
        `/api/positions?proxyAddress=${encodeURIComponent(this.walletState.proxyAddress)}`
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch positions');
      }

      const positions: any[] = data.positions || [];
      console.log('[Positions] Fetched:', positions.length);

      if (countEl) {
        countEl.textContent = positions.length === 0
          ? 'No positions'
          : `${positions.length} position${positions.length !== 1 ? 's' : ''}`;
      }

      if (container) {
        if (positions.length === 0) {
          container.innerHTML = `<p class="text-slate-500 text-sm">No active positions on Polymarket.</p>`;
          return;
        }

        const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const pnlClass = (pnl: number) => (pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400');
        const rows = positions.map((p: any) => {
          const size = Number(p.size ?? 0);
          const avgPrice = Number(p.avgPrice ?? 0);
          const curPrice = Number(p.curPrice ?? 0);
          const currentValue = Number(p.currentValue ?? 0);
          const cashPnl = Number(p.cashPnl ?? 0);
          const percentPnl = Number(p.percentPnl ?? 0);
          const title = (p.title || p.slug || p.eventSlug || '—').toString().slice(0, 40);
          const outcome = (p.outcome || '—').toString();
          const eventSlug = (p.eventSlug || '—').toString();
          // Data API prices are typically 0-1 decimal; display as 0-100
          const avgPct = avgPrice <= 1 && avgPrice >= 0 ? avgPrice * 100 : avgPrice;
          const curPct = curPrice <= 1 && curPrice >= 0 ? curPrice * 100 : curPrice;

          return `
            <tr class="border-b border-slate-100 dark:border-slate-700/50">
              <td class="py-2 pr-2 text-slate-700 dark:text-slate-300">${esc(title)}${title.length >= 40 ? '…' : ''}</td>
              <td class="py-2 pr-2 font-medium">${esc(outcome)}</td>
              <td class="py-2 pr-2 font-mono">${size.toFixed(2)}</td>
              <td class="py-2 pr-2 font-mono">${avgPct.toFixed(2)}</td>
              <td class="py-2 pr-2 font-mono">${curPct.toFixed(2)}</td>
              <td class="py-2 pr-2 font-mono">$${currentValue.toFixed(2)}</td>
              <td class="py-2 pr-2 font-mono ${pnlClass(cashPnl)}">$${cashPnl >= 0 ? '+' : ''}${cashPnl.toFixed(2)}</td>
              <td class="py-2 pr-2 font-mono ${pnlClass(percentPnl)}">${percentPnl >= 0 ? '+' : ''}${percentPnl.toFixed(1)}%</td>
              <td class="py-2 pr-2 text-slate-500 text-xs">${esc(eventSlug)}</td>
            </tr>
          `;
        }).join('');

        container.innerHTML = `
          <p class="text-slate-500 text-xs mb-2">Active positions from Polymarket (by proxy wallet).</p>
          <div class="overflow-x-auto">
            <table class="orders-table w-full border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 dark:border-slate-700">
                  <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Market</th>
                  <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Outcome</th>
                  <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Size</th>
                  <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Avg price</th>
                  <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Cur price</th>
                  <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Value</th>
                  <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">P&amp;L</th>
                  <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">% P&amp;L</th>
                  <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Event</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        `;
      }
    } catch (error) {
      console.error('[Positions] Error:', error);
      if (container) {
        container.innerHTML = `<p class="text-red-600 text-sm">Error loading positions: ${error instanceof Error ? error.message : 'Unknown error'}</p>`;
      }
      if (countEl) countEl.textContent = 'Error';
    }
  }

  /**
   * Fetch and display only open (unfilled) orders in the Open Orders tab.
   */
  private async fetchAndDisplayOpenOrders(): Promise<void> {
    const container = document.getElementById('open-orders-container');
    const countEl = document.getElementById('open-orders-count');
    if (!container) return;

    if (!this.walletState.isInitialized || !this.walletState.apiCredentials || !this.walletState.proxyAddress) {
      container.innerHTML = `<p class="text-slate-500 text-sm">Wallet not initialized. Initialize trading session first.</p>`;
      if (countEl) countEl.textContent = '—';
      return;
    }

    container.innerHTML = `<p class="text-slate-500 text-sm">Loading open orders...</p>`;
    if (countEl) countEl.textContent = 'Loading...';

    try {
      const response = await fetch(
        `/api/orders?apiCredentials=${encodeURIComponent(JSON.stringify(this.walletState.apiCredentials))}&proxyAddress=${encodeURIComponent(this.walletState.proxyAddress)}`
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to fetch orders');

      const allOrders: any[] = data.orders || [];
      const openOrders = allOrders.filter(
        (o: any) => (o.status || '').toUpperCase() === 'LIVE' || (o.status || '').toUpperCase() === 'PARTIALLY_FILLED'
      );

      if (countEl) {
        countEl.textContent = openOrders.length === 0 ? 'No open orders' : `${openOrders.length} open order${openOrders.length !== 1 ? 's' : ''}`;
      }

      if (openOrders.length === 0) {
        container.innerHTML = `<p class="text-slate-500 text-sm">No open orders. Orders that are placed but not yet filled appear here.</p>`;
        return;
      }

      const rows = openOrders.map((order: any) => {
        const orderId = order.id || order.orderID || '--';
        const side = (order.side || '—').toUpperCase();
        const price = order.price != null ? Number(order.price).toFixed(2) : '—';
        const originalSize = order.original_size != null ? Number(order.original_size).toFixed(2) : '—';
        const matched = order.size_matched != null ? Number(order.size_matched).toFixed(2) : '0';
        const tokenId = order.asset_id || order.token_id || '—';
        const created = order.created_at
          ? new Date(typeof order.created_at === 'number' ? order.created_at * 1000 : order.created_at).toLocaleString()
          : '—';
        const status = (order.status || 'LIVE').toUpperCase();
        return `
          <tr class="order-row order-live" data-order-id="${orderId}">
            <td class="order-id font-mono text-xs">${String(orderId).substring(0, 12)}...</td>
            <td><span class="status-badge ${side === 'BUY' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}">${side}</span></td>
            <td>${price}</td>
            <td>${originalSize}</td>
            <td>${matched}</td>
            <td class="font-mono text-xs">${String(tokenId).substring(0, 10)}...</td>
            <td class="text-slate-500">${created}</td>
            <td><span class="status-badge status-live">${status}</span></td>
            <td><button type="button" class="btn-cancel-open-order px-2 py-1 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded text-xs font-medium hover:bg-red-200 dark:hover:bg-red-900/50" data-order-id="${orderId}">Cancel</button></td>
          </tr>
        `;
      }).join('');

      container.innerHTML = `
        <table class="orders-table w-full border-collapse text-sm">
          <thead>
            <tr class="border-b border-slate-200 dark:border-slate-700">
              <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Order ID</th>
              <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Side</th>
              <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Price</th>
              <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Size</th>
              <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Matched</th>
              <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Token</th>
              <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Created</th>
              <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Status</th>
              <th class="text-left py-2 pr-2 font-medium text-slate-600 dark:text-slate-400">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;

      container.querySelectorAll('.btn-cancel-open-order').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const id = (e.target as HTMLButtonElement).getAttribute('data-order-id');
          if (id) await this.cancelOrder(id);
        });
      });
    } catch (error) {
      console.error('[Open Orders] Error fetching:', error);
      container.innerHTML = `<p class="text-red-600 dark:text-red-400 text-sm">Error: ${error instanceof Error ? error.message : 'Unknown error'}</p>`;
      if (countEl) countEl.textContent = 'Error';
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

      await this.fetchAndDisplayPositions();
      await this.fetchAndDisplayOpenOrders();
    } catch (error) {
      console.error('[Orders] ❌ Error cancelling order:', error);
      alert(`Failed to cancel order: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
            await this.fetchAndDisplayPositions();
            await this.fetchAndDisplayOpenOrders();
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
            await this.fetchAndDisplayPositions();
            await this.fetchAndDisplayOpenOrders();
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
   * Throws with a clear message if init fails (e.g. private key not configured, or client creation error).
   */
  private async initializeBrowserClobClient(): Promise<void> {
    if (!this.walletState.isConnected || !this.walletState.apiCredentials) {
      throw new Error('Wallet not connected or API credentials missing. Connect wallet and initialize session.');
    }

    // Get private key from backend (required for browser ClobClient)
    const response = await fetch('/api/wallet/private-key', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data?.error || `Private key API returned ${response.status}`;
      if (response.status === 500 && (msg.includes('Private key') || msg.includes('not configured'))) {
        throw new Error(
          'Private key not configured. Add POLYMARKET_MAGIC_PK to your environment (.env locally or Vercel env vars) and try reconnecting.'
        );
      }
      throw new Error(`Cannot initialize browser client: ${msg}`);
    }

    if (!data.privateKey) {
      throw new Error('Private key not returned from server. Check that POLYMARKET_MAGIC_PK is set in your environment.');
    }

    try {
      const browserClobClient = await createBrowserClobClientFromInit(
        data.privateKey,
        this.walletState.apiCredentials,
        this.walletState.proxyAddress!
      );
      this.tradingManager.setBrowserClobClient(browserClobClient);
      console.log('[Browser ClobClient] ✅ Successfully initialized and set in TradingManager');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[Browser ClobClient] ❌ Failed to initialize:', error);
      throw new Error(`Browser ClobClient initialization failed: ${detail}. Please try reconnecting your wallet.`);
    }
  }
}

