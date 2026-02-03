import { PolymarketAPI, type PolymarketEvent } from './polymarket-api';
import { getNext15MinIntervals, getPrevious15MinInterval, generateEventSlug, formatTimestamp, formatTimestampForTitle, extractTimestampFromSlug } from './event-utils';
import type { AssetType } from './types';
import { ASSET_CONFIG } from './types';

export interface EventDisplayData {
  slug: string;
  title: string;
  startDate: string;
  endDate: string;
  status: 'active' | 'expired' | 'upcoming';
  conditionId?: string;
  questionId?: string;
  clobTokenIds?: string[];
  formattedStartDate: string;
  formattedEndDate: string;
  timestamp: number;
  lastPrice?: number; // Price at the end of the previous event
  rawData?: PolymarketEvent;
}

export class EventManager {
  private events: EventDisplayData[] = [];
  private currentEventIndex: number = -1;
  private refreshInterval: number | null = null;
  private onEventsUpdated: (() => void) | null = null;
  private asset: AssetType;

  constructor(asset: AssetType = 'btc') {
    this.asset = asset;
  }

  setOnEventsUpdated(callback: () => void): void {
    this.onEventsUpdated = callback;
  }

  private createEventFromTimestamp(timestamp: number, event?: PolymarketEvent | null): EventDisplayData {
    const slug = event?.slug || generateEventSlug(timestamp, this.asset);
    const startTimestamp = extractTimestampFromSlug(slug) || timestamp;
    const endTimestamp = startTimestamp + 900; // 15 minutes = 900 seconds
    
    // Calculate dates from timestamp (in GMT+6 / Dhaka time)
    const startDate = new Date(startTimestamp * 1000).toISOString();
    const endDate = new Date(endTimestamp * 1000).toISOString();
    
    // Determine status
    const now = Math.floor(Date.now() / 1000);
    const isActive = startTimestamp <= now && now < endTimestamp;
    const isExpired = now >= endTimestamp;
    
    let status: 'active' | 'expired' | 'upcoming';
    if (event?.closed) {
      status = 'expired';
    } else if (isExpired) {
      status = 'expired';
    } else if (isActive) {
      status = 'active';
    } else {
      status = 'upcoming';
    }
    
    // Format title with Dhaka time (GMT+6)
    const titleTime = formatTimestampForTitle(startTimestamp);
    const assetConfig = ASSET_CONFIG[this.asset];
    const title = event?.title || `${assetConfig.displayName} Up/Down 15m - ${titleTime}`;
    
    // Extract IDs - handle both direct and nested structures
    // Note: API uses questionID (capital ID) not questionId
    let conditionId = event?.conditionId || event?.condition_id;
    let questionId = event?.questionID || event?.questionId || event?.question_id; // API uses questionID
    let clobTokenIds: string[] | undefined = undefined;
    
    // Debug: Log the full event object to see what we received
    console.log(`[EventManager] Event received for ${slug}:`, {
      hasEvent: !!event,
      eventKeys: event ? Object.keys(event) : [],
      conditionId: event?.conditionId || event?.condition_id || 'MISSING',
      questionId: event?.questionID || event?.questionId || event?.question_id || 'MISSING',
      clobTokenIds: event?.clobTokenIds || 'MISSING',
      clobTokenIdsType: typeof event?.clobTokenIds,
      hasMarkets: !!event?.markets,
      marketsLength: event?.markets?.length || 0,
      market0ClobTokenIds: event?.markets?.[0]?.clobTokenIds || 'MISSING',
      market0Tokens: event?.markets?.[0]?.tokens?.length || 0,
      // Log full event structure (first 1000 chars)
      fullEventSample: event ? JSON.stringify(event, null, 2).substring(0, 1000) : 'null',
    });
    
    // Get clobTokenIds from event - it should already be parsed by API layer
    if (event?.clobTokenIds) {
      if (Array.isArray(event.clobTokenIds)) {
        clobTokenIds = event.clobTokenIds;
        console.log(`[EventManager] ✓ Found clobTokenIds in event.clobTokenIds:`, clobTokenIds);
      } else if (typeof event.clobTokenIds === 'string') {
        // Fallback: parse if still a string (shouldn't happen but just in case)
        try {
          const parsed = JSON.parse(event.clobTokenIds);
          if (Array.isArray(parsed)) {
            clobTokenIds = parsed;
            console.log(`[EventManager] ✓ Parsed clobTokenIds from string:`, clobTokenIds);
          }
        } catch (e) {
          console.warn('[EventManager] Failed to parse clobTokenIds as JSON:', e);
        }
      }
    } else if (event?.markets?.[0]) {
      // Fallback: Try to extract from markets if not already extracted
      const market = event.markets[0];
      console.log(`[EventManager] Trying fallback extraction from markets[0] for ${slug}`);
      
      // Try clobTokenIds in market
      if (market.clobTokenIds) {
        if (Array.isArray(market.clobTokenIds)) {
          clobTokenIds = market.clobTokenIds;
          console.log(`[EventManager] ✓ Found clobTokenIds in markets[0].clobTokenIds:`, clobTokenIds);
        } else if (typeof market.clobTokenIds === 'string') {
          try {
            const parsed = JSON.parse(market.clobTokenIds);
            if (Array.isArray(parsed)) {
              clobTokenIds = parsed;
              console.log(`[EventManager] ✓ Found clobTokenIds in markets[0].clobTokenIds (parsed):`, clobTokenIds);
            }
          } catch (e) {
            console.warn('[EventManager] Failed to parse markets[0].clobTokenIds:', e);
          }
        }
      }
      
      // Try tokens array
      if (!clobTokenIds && market.tokens && Array.isArray(market.tokens) && market.tokens.length > 0) {
        const tokenIds = market.tokens
          .map((t: any) => t.token_id || t.tokenId || t.id || t.clobTokenId)
          .filter(Boolean);
        if (tokenIds.length > 0) {
          clobTokenIds = tokenIds;
          console.log(`[EventManager] ✓ Found clobTokenIds in markets[0].tokens:`, clobTokenIds);
        }
      }
      
      // Try to extract conditionId and questionId from market if missing
      if (!conditionId) {
        conditionId = market.conditionId || market.condition_id;
        if (conditionId) {
          console.log(`[EventManager] ✓ Found conditionId in markets[0]:`, conditionId);
        }
      }
      if (!questionId) {
        questionId = market.questionID || market.questionId || market.question_id;
        if (questionId) {
          console.log(`[EventManager] ✓ Found questionId in markets[0]:`, questionId);
        }
      }
    }
    
    // Debug logging
    console.log(`[EventManager] Final extraction for ${slug}:`, {
      conditionId: conditionId || 'MISSING',
      questionId: questionId || 'MISSING',
      clobTokenIds: clobTokenIds || 'MISSING',
      clobTokenIdsCount: clobTokenIds?.length || 0,
    });
    
    return {
      slug,
      title,
      startDate,
      endDate,
      status,
      conditionId,
      questionId,
      clobTokenIds: clobTokenIds as string[] | undefined,
      formattedStartDate: formatTimestamp(startTimestamp),
      formattedEndDate: formatTimestamp(endTimestamp),
      timestamp: startTimestamp,
      rawData: event || undefined
    };
  }

  async loadEvents(count: number = 10): Promise<void> {
    try {
      // Get one expired event (most recent expired)
      const expiredTimestamp = getPrevious15MinInterval();
      const expiredSlug = generateEventSlug(expiredTimestamp, this.asset);
      
      // Get current and upcoming events (count - 1 to make room for expired)
      const futureTimestamps = getNext15MinIntervals(count - 1);
      const futureSlugs = futureTimestamps.map(ts => generateEventSlug(ts, this.asset));
      
      // Fetch all events
      const allSlugs = [expiredSlug, ...futureSlugs];
      const eventData = await Promise.allSettled(
        allSlugs.map(slug => PolymarketAPI.fetchEventBySlug(slug))
      ).then(results => 
        results.map((result, index) => {
          if (result.status === 'fulfilled') {
            return result.value;
          } else {
            // Log the error but continue
            console.warn(`Failed to fetch event ${allSlugs[index]}:`, result.reason);
            return null;
          }
        })
      );
      
      // Create expired event (always show one)
      const expiredEvent = this.createEventFromTimestamp(expiredTimestamp, eventData[0]);
      
      // Create current/upcoming events
      const futureEvents = futureTimestamps
        .map((timestamp, index) => {
          const event = eventData[index + 1]; // +1 because first is expired
          return this.createEventFromTimestamp(timestamp, event);
        })
        .filter(event => {
          // Only include if not expired (we only want one expired at the top)
          return event.status !== 'expired';
        });
      
      // Combine: [1 expired] + [active/upcoming events]
      this.events = [expiredEvent, ...futureEvents];
      
      // Find current active event
      this.currentEventIndex = this.events.findIndex(e => e.status === 'active');
      
      // Notify that events have been updated
      if (this.onEventsUpdated) {
        this.onEventsUpdated();
      }
      
    } catch (error) {
      console.error('Error loading events:', error);
      // Even on error, create placeholder events
      const expiredTimestamp = getPrevious15MinInterval();
      const futureTimestamps = getNext15MinIntervals(count - 1);
      
      const expiredEvent = this.createEventFromTimestamp(expiredTimestamp, null);
      const futureEvents = futureTimestamps
        .map(timestamp => this.createEventFromTimestamp(timestamp, null))
        .filter(event => event.status !== 'expired');
      
      this.events = [expiredEvent, ...futureEvents];
      
      this.currentEventIndex = this.events.findIndex(e => e.status === 'active');
      
      if (this.onEventsUpdated) {
        this.onEventsUpdated();
      }
      
      // Re-throw to show error message
      throw error;
    }
  }

  getEvents(): EventDisplayData[] {
    return this.events;
  }

  getCurrentEventIndex(): number {
    return this.currentEventIndex;
  }

  startAutoRefresh(intervalMs: number = 60000): void {
    this.stopAutoRefresh();
    this.refreshInterval = window.setInterval(() => {
      this.loadEvents().catch(console.error);
    }, intervalMs);
  }

  stopAutoRefresh(): void {
    if (this.refreshInterval !== null) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }
}

