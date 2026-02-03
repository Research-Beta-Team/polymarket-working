import { TradingManager } from './trading-manager';
import type { StrategyConfig, Trade, TradingStatus, Position } from './trading-types';
import type { EventDisplayData } from './event-manager';
import type { AssetType } from './types';

/**
 * Multi-Asset Trading Manager
 * Wraps multiple TradingManager instances (one per asset)
 * Keeps existing BTC code intact by using individual managers
 */
export class MultiAssetTradingManager {
  private managers: Map<AssetType, TradingManager> = new Map();
  private onStatusUpdate: ((asset: AssetType, status: TradingStatus) => void) | null = null;
  private onTradeUpdate: ((asset: AssetType, trade: Trade) => void) | null = null;

  constructor() {
    // Initialize trading managers for each asset
    const assets: AssetType[] = ['btc', 'eth', 'sol', 'xrp'];
    for (const asset of assets) {
      const manager = new TradingManager();
      this.managers.set(asset, manager);
    }
  }

  /**
   * Set status update callback for all assets
   */
  setOnStatusUpdate(callback: (asset: AssetType, status: TradingStatus) => void): void {
    this.onStatusUpdate = callback;
    // Set callback for each manager
    for (const [asset, manager] of this.managers.entries()) {
      manager.setOnStatusUpdate((status) => {
        if (this.onStatusUpdate) {
          this.onStatusUpdate(asset, status);
        }
      });
    }
  }

  /**
   * Set trade update callback for all assets
   */
  setOnTradeUpdate(callback: (asset: AssetType, trade: Trade) => void): void {
    this.onTradeUpdate = callback;
    // Set callback for each manager
    for (const [asset, manager] of this.managers.entries()) {
      manager.setOnTradeUpdate((trade) => {
        if (this.onTradeUpdate) {
          this.onTradeUpdate(asset, trade);
        }
      });
    }
  }

  /**
   * Get trading manager for a specific asset
   */
  getManager(asset: AssetType): TradingManager | undefined {
    return this.managers.get(asset);
  }

  /**
   * Update market data for a specific asset
   * Note: updateMarketData in TradingManager takes (currentPrice, priceToBeat, activeEvent)
   */
  updateMarketData(asset: AssetType, currentPrice: number | null, priceToBeat: number | null, activeEvent: EventDisplayData | null = null): void {
    const manager = this.managers.get(asset);
    if (manager) {
      (manager as any).updateMarketData(currentPrice, priceToBeat, activeEvent);
    }
  }

  /**
   * Start trading for a specific asset
   */
  async startTrading(asset: AssetType): Promise<void> {
    const manager = this.managers.get(asset);
    if (manager) {
      await manager.startTrading();
    }
  }

  /**
   * Stop trading for a specific asset
   */
  stopTrading(asset: AssetType): void {
    const manager = this.managers.get(asset);
    if (manager) {
      manager.stopTrading();
    }
  }

  /**
   * Stop trading for all assets
   */
  stopAllTrading(): void {
    for (const manager of this.managers.values()) {
      manager.stopTrading();
    }
  }

  /**
   * Get strategy config for a specific asset
   */
  getStrategyConfig(asset: AssetType): StrategyConfig {
    const manager = this.managers.get(asset);
    return manager ? manager.getStrategyConfig() : this.getDefaultStrategyConfig();
  }

  /**
   * Update strategy config for a specific asset
   */
  updateStrategyConfig(asset: AssetType, config: Partial<StrategyConfig>): void {
    const manager = this.managers.get(asset);
    if (manager) {
      manager.updateStrategyConfig(config);
    }
  }

  /**
   * Get trading status for a specific asset
   */
  getStatus(asset: AssetType): TradingStatus {
    const manager = this.managers.get(asset);
    return manager ? manager.getStatus() : this.getDefaultStatus();
  }

  /**
   * Get all positions for a specific asset
   */
  getPositions(asset: AssetType): Position[] {
    const manager = this.managers.get(asset);
    return manager ? manager.getPositions() : [];
  }

  /**
   * Get all trades for a specific asset
   */
  getTrades(asset: AssetType): Trade[] {
    const manager = this.managers.get(asset);
    return manager ? manager.getTrades() : [];
  }

  /**
   * Set API credentials for a specific asset (or all if asset is null)
   */
  setApiCredentials(asset: AssetType | null, credentials: { key: string; secret: string; passphrase: string }): void {
    if (asset) {
      const manager = this.managers.get(asset);
      if (manager) {
        manager.setApiCredentials(credentials);
      }
    } else {
      // Set for all assets
      for (const manager of this.managers.values()) {
        manager.setApiCredentials(credentials);
      }
    }
  }

  /**
   * Initialize browser CLOB client for a specific asset (or all if asset is null)
   */
  async initializeBrowserClobClient(asset: AssetType | null, eoaAddress: string, proxyAddress: string): Promise<void> {
    if (asset) {
      const manager = this.managers.get(asset);
      if (manager) {
        await manager.initializeBrowserClobClient(eoaAddress, proxyAddress);
      }
    } else {
      // Initialize for all assets
      const promises = Array.from(this.managers.values()).map(manager =>
        manager.initializeBrowserClobClient(eoaAddress, proxyAddress).catch(error => {
          console.error(`Error initializing browser CLOB client:`, error);
        })
      );
      await Promise.allSettled(promises);
    }
  }

  /**
   * Get browser CLOB client for a specific asset
   */
  getBrowserClobClient(asset: AssetType): any {
    const manager = this.managers.get(asset);
    return manager ? manager.getBrowserClobClient() : null;
  }

  /**
   * Get all supported assets
   */
  getAssets(): AssetType[] {
    return Array.from(this.managers.keys());
  }

  /**
   * Default strategy config
   */
  private getDefaultStrategyConfig(): StrategyConfig {
    return {
      enabled: false,
      entryPrice: 96,
      profitTargetPrice: 99,
      stopLossPrice: 91,
      tradeSize: 50,
      priceDifference: null,
      flipGuardPendingDistanceUsd: 15,
      flipGuardFilledDistanceUsd: 5,
      entryTimeRemainingMaxSeconds: 180,
    };
  }

  /**
   * Default trading status
   */
  private getDefaultStatus(): TradingStatus {
    return {
      isActive: false,
      totalTrades: 0,
      successfulTrades: 0,
      failedTrades: 0,
      totalProfit: 0,
      pendingLimitOrders: 0,
      positions: [],
      totalPositionSize: 0,
    };
  }
}
