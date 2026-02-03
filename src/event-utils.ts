import type { AssetType } from './types';

/**
 * Calculate 15-minute interval timestamps for up/down events
 * Events occur at :00, :15, :30, :45 of each hour
 */

export function getCurrent15MinInterval(): number {
  const now = new Date();
  const minutes = now.getMinutes();
  
  // Round down to the nearest 15-minute interval
  const roundedMinutes = Math.floor(minutes / 15) * 15;
  
  const intervalStart = new Date(now);
  intervalStart.setMinutes(roundedMinutes, 0, 0);
  
  return Math.floor(intervalStart.getTime() / 1000);
}

export function getNext15MinIntervals(count: number = 10): number[] {
  const intervals: number[] = [];
  const now = new Date();
  const minutes = now.getMinutes();
  
  // Round down to the nearest 15-minute interval
  const roundedMinutes = Math.floor(minutes / 15) * 15;
  
  // Start from the current interval
  let currentInterval = new Date(now);
  currentInterval.setMinutes(roundedMinutes, 0, 0);
  
  for (let i = 0; i < count; i++) {
    const timestamp = Math.floor(currentInterval.getTime() / 1000);
    intervals.push(timestamp);
    
    // Add 15 minutes for the next interval
    currentInterval.setMinutes(currentInterval.getMinutes() + 15);
  }
  
  return intervals;
}

export function getPrevious15MinInterval(): number {
  const now = new Date();
  const minutes = now.getMinutes();
  
  // Round down to the nearest 15-minute interval
  const roundedMinutes = Math.floor(minutes / 15) * 15;
  
  // Get the previous interval (15 minutes before current)
  let previousInterval = new Date(now);
  previousInterval.setMinutes(roundedMinutes, 0, 0);
  previousInterval.setMinutes(previousInterval.getMinutes() - 15);
  
  return Math.floor(previousInterval.getTime() / 1000);
}

/**
 * Generate event slug for a specific asset
 * Format: {asset}-updown-15m-{timestamp}
 */
export function generateEventSlug(timestamp: number, asset: AssetType = 'btc'): string {
  return `${asset}-updown-15m-${timestamp}`;
}

/**
 * Extract timestamp from event slug
 * Supports: btc-updown-15m-{timestamp}, eth-updown-15m-{timestamp}, etc.
 */
export function extractTimestampFromSlug(slug: string): number | null {
  const match = slug.match(/(?:btc|eth|sol|xrp)-updown-15m-(\d+)/);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Extract asset type from event slug
 */
export function extractAssetFromSlug(slug: string): AssetType | null {
  const match = slug.match(/(btc|eth|sol|xrp)-updown-15m-/);
  if (match && match[1]) {
    return match[1] as AssetType;
  }
  return null;
}

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

export function formatTimestampForTitle(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

export function isEventActive(startDate: string, endDate: string): boolean {
  const now = new Date();
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  return now >= start && now < end;
}
