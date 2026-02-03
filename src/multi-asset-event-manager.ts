import { EventManager } from './event-manager';
import type { EventDisplayData } from './event-manager';
import type { AssetType } from './types';
import { generateEventSlug } from './event-utils';

/**
 * Multi-Asset Event Manager
 * Wraps multiple EventManager instances (one per asset)
 * Keeps existing BTC code intact by using individual managers
 */
export class MultiAssetEventManager {
  private managers: Map<AssetType, EventManager> = new Map();
  private onEventsUpdated: (() => void) | null = null;

  constructor() {
    // Initialize event managers for each asset
    const assets: AssetType[] = ['btc', 'eth', 'sol', 'xrp'];
    for (const asset of assets) {
      const manager = new EventManager(asset);
      this.managers.set(asset, manager);
    }
  }

  setOnEventsUpdated(callback: () => void): void {
    this.onEventsUpdated = callback;
    // Set callback for each manager
    for (const manager of this.managers.values()) {
      manager.setOnEventsUpdated(() => {
        if (this.onEventsUpdated) {
          this.onEventsUpdated();
        }
      });
    }
  }

  /**
   * Load events for a specific asset
   */
  async loadEvents(asset: AssetType, count: number = 10): Promise<void> {
    const manager = this.managers.get(asset);
    if (!manager) {
      throw new Error(`No event manager found for asset: ${asset}`);
    }
    await manager.loadEvents(count);
  }

  /**
   * Load events for all assets
   */
  async loadAllEvents(count: number = 10): Promise<void> {
    const promises = Array.from(this.managers.keys()).map(asset =>
      this.loadEvents(asset, count).catch(error => {
        console.error(`Error loading events for ${asset}:`, error);
      })
    );
    await Promise.allSettled(promises);
  }

  /**
   * Get events for a specific asset
   */
  getEvents(asset: AssetType): EventDisplayData[] {
    const manager = this.managers.get(asset);
    return manager ? manager.getEvents() : [];
  }

  /**
   * Get all events across all assets
   */
  getAllEvents(): Map<AssetType, EventDisplayData[]> {
    const allEvents = new Map<AssetType, EventDisplayData[]>();
    for (const [asset, manager] of this.managers.entries()) {
      allEvents.set(asset, manager.getEvents());
    }
    return allEvents;
  }

  /**
   * Get current event index for a specific asset
   */
  getCurrentEventIndex(asset: AssetType): number {
    const manager = this.managers.get(asset);
    return manager ? manager.getCurrentEventIndex() : -1;
  }

  /**
   * Start auto-refresh for a specific asset
   */
  startAutoRefresh(asset: AssetType, intervalMs: number = 60000): void {
    const manager = this.managers.get(asset);
    if (manager) {
      manager.startAutoRefresh(intervalMs);
    }
  }

  /**
   * Start auto-refresh for all assets
   */
  startAutoRefreshAll(intervalMs: number = 60000): void {
    for (const manager of this.managers.values()) {
      manager.startAutoRefresh(intervalMs);
    }
  }

  /**
   * Stop auto-refresh for a specific asset
   */
  stopAutoRefresh(asset: AssetType): void {
    const manager = this.managers.get(asset);
    if (manager) {
      manager.stopAutoRefresh();
    }
  }

  /**
   * Stop auto-refresh for all assets
   */
  stopAutoRefreshAll(): void {
    for (const manager of this.managers.values()) {
      manager.stopAutoRefresh();
    }
  }

  /**
   * Get the event manager for a specific asset (for direct access if needed)
   */
  getManager(asset: AssetType): EventManager | undefined {
    return this.managers.get(asset);
  }

  /**
   * Get all supported assets
   */
  getAssets(): AssetType[] {
    return Array.from(this.managers.keys());
  }
}
