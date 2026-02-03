/**
 * Auto-Redemption Service
 * Monitors resolved 15-minute markets and redeems winning tokens to USDC.
 * Runs as a background task and does not block trading logic.
 */

import type { Position } from './trading-types';
import { PolymarketAPI } from './polymarket-api';

const REDEMPTION_CHECK_INTERVAL_MS = 60_000; // 1 minute
const REDEEM_API_PATH = '/api/redeem';

export type GetPositionsFn = () => Position[];
export type RemovePositionsFn = (positionIds: string[]) => void;

export interface RedemptionServiceConfig {
  getPositions: GetPositionsFn;
  removePositions?: RemovePositionsFn;
  onRedemptionSuccess?: (eventSlug: string, positionIds: string[], amount?: string) => void;
  onRedemptionError?: (eventSlug: string, error: string) => void;
}

export class RedemptionService {
  private config: RedemptionServiceConfig;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private redeemedPositionIds: Set<string> = new Set();
  private isRunning = false;

  constructor(config: RedemptionServiceConfig) {
    this.config = config;
  }

  /** Start background redemption checks. Does not block. */
  start(): void {
    if (this.intervalId != null) return;
    this.isRunning = true;
    console.log('[RedemptionService] Started (background, every %s s)', REDEMPTION_CHECK_INTERVAL_MS / 1000);
    this.runCheck().catch((e) => console.warn('[RedemptionService] First check error:', e));
    this.intervalId = setInterval(() => {
      this.runCheck().catch((e) => console.warn('[RedemptionService] Check error:', e));
    }, REDEMPTION_CHECK_INTERVAL_MS);
  }

  /** Stop background checks. */
  stop(): void {
    if (this.intervalId != null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('[RedemptionService] Stopped');
  }

  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * One redemption check pass: find positions in resolved markets and attempt redeem.
   * Non-blocking for the caller; runs async work in background.
   */
  private async runCheck(): Promise<void> {
    const positions = this.config.getPositions();
    if (positions.length === 0) return;

    const byEvent = new Map<string, Position[]>();
    for (const p of positions) {
      if (this.redeemedPositionIds.has(p.id)) continue;
      const list = byEvent.get(p.eventSlug) ?? [];
      list.push(p);
      byEvent.set(p.eventSlug, list);
    }

    for (const [eventSlug, list] of byEvent.entries()) {
      if (list.length === 0) continue;
      try {
        await this.tryRedeemForEvent(eventSlug, list);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[RedemptionService] Event %s:', eventSlug, msg);
        this.config.onRedemptionError?.(eventSlug, msg);
      }
    }
  }

  private async tryRedeemForEvent(eventSlug: string, positions: Position[]): Promise<void> {
    const event = await PolymarketAPI.fetchEventBySlug(eventSlug);
    if (!event) return;
    if (!event.closed) return;

    const conditionId = event.conditionId ?? event.condition_id;
    const clobTokenIds = normalizeClobTokenIds(event.clobTokenIds);
    if (!conditionId || !clobTokenIds || clobTokenIds.length < 2) {
      console.log('[RedemptionService] Skip %s: missing conditionId or clobTokenIds', eventSlug);
      return;
    }

    // Binary: index set 1 = YES/UP (clobTokenIds[0]), 2 = NO/DOWN (clobTokenIds[1])
    const yesTokenId = clobTokenIds[0];
    const noTokenId = clobTokenIds[1];

    const toRedeemByIndexSet = new Map<number, Position[]>();
    for (const p of positions) {
      if (this.redeemedPositionIds.has(p.id)) continue;
      const indexSet = p.tokenId === yesTokenId ? 1 : p.tokenId === noTokenId ? 2 : null;
      if (indexSet == null) continue;
      const arr = toRedeemByIndexSet.get(indexSet) ?? [];
      arr.push(p);
      toRedeemByIndexSet.set(indexSet, arr);
    }

    for (const [indexSet, posList] of toRedeemByIndexSet.entries()) {
      if (posList.length === 0) continue;
      try {
        const result = await this.callRedeemApi(conditionId, indexSet);
        if (result?.success) {
          for (const p of posList) this.redeemedPositionIds.add(p.id);
          const ids = posList.map((p) => p.id);
          console.log('[RedemptionService] Redeemed %s conditionId=%s indexSet=%s positions=%s', eventSlug, conditionId.slice(0, 10) + '...', indexSet, ids.length);
          this.config.onRedemptionSuccess?.(eventSlug, ids, result.amount);
          if (this.config.removePositions) this.config.removePositions(ids);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[RedemptionService] Redeem failed %s indexSet=%s:', eventSlug, indexSet, msg);
        this.config.onRedemptionError?.(eventSlug, msg);
      }
    }
  }

  private async callRedeemApi(conditionId: string, indexSet: number): Promise<{ success: boolean; amount?: string } | null> {
    const res = await fetch(REDEEM_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conditionId, indexSet }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || `Redeem API ${res.status}`);
    }
    const data = await res.json().catch(() => ({}));
    return { success: !!data.success, amount: data.amount };
  }
}

function normalizeClobTokenIds(value: string[] | string | undefined): string[] | null {
  if (!value) return null;
  if (Array.isArray(value)) return value.length >= 2 ? value : null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) && parsed.length >= 2 ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}
