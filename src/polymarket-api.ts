// Use proxy in both development and production to avoid CORS issues
const GAMMA_API_BASE = '/api/polymarket';

export interface PolymarketEvent {
  slug: string;
  title: string;
  description?: string;
  startDate: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  conditionId?: string;
  condition_id?: string;
  questionId?: string;
  questionID?: string; // Note: API uses capital ID
  question_id?: string;
  clobTokenIds?: string[] | string; // Can be array or stringified JSON
  clob_token_ids?: string[] | string;
  condition?: { id?: string };
  question?: { id?: string };
  tokens?: Array<{ token_id?: string; tokenId?: string; id?: string }>;
  markets?: Array<{
    conditionId?: string;
    condition_id?: string;
    questionId?: string;
    questionID?: string;
    question_id?: string;
    clobTokenIds?: string[] | string;
    clob_token_ids?: string[] | string;
    tokens?: Array<{ token_id?: string; tokenId?: string; id?: string; clobTokenId?: string }>;
  }>;
  liquidity?: number;
  volume?: number;
  [key: string]: any; // For other fields that might be present
}

export class PolymarketAPI {
  static async fetchEventBySlug(slug: string): Promise<PolymarketEvent | null> {
    try {
      const apiUrl = `${GAMMA_API_BASE}/markets/slug/${slug}`;
      console.log(`[PolymarketAPI] Fetching: ${apiUrl}`);
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
        // Add mode to handle CORS
        mode: 'cors',
        cache: 'no-cache',
      });
      
      console.log(`[PolymarketAPI] Response status: ${response.status} for ${slug}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          return null; // Event not found
        }
        const errorText = await response.text().catch(() => '');
        console.error(`[PolymarketAPI] Error ${response.status}:`, errorText);
        throw new Error(`Failed to fetch event: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Log the raw response structure for debugging
      const market0 = data.markets?.[0];
      console.log(`[PolymarketAPI] Response for ${slug}:`, {
        hasConditionId: !!data.conditionId || !!data.condition_id,
        hasQuestionId: !!data.questionID || !!data.questionId,
        hasClobTokenIds: !!data.clobTokenIds || !!data.clob_token_ids,
        marketsCount: data.markets?.length || 0,
        market0Structure: market0 ? {
          hasClobTokenIds: !!market0.clobTokenIds,
          clobTokenIdsValue: market0.clobTokenIds,
          clobTokenIdsType: typeof market0.clobTokenIds,
          hasTokens: !!market0.tokens,
          tokensCount: market0.tokens?.length || 0,
          tokenIds: market0.tokens?.map((t: any) => t.token_id || t.tokenId || t.id).filter(Boolean) || [],
          hasConditionId: !!market0.conditionId || !!market0.condition_id,
          conditionIdValue: market0.conditionId || market0.condition_id,
          hasQuestionId: !!market0.questionID || !!market0.questionId || !!market0.question_id,
          questionIdValue: market0.questionID || market0.questionId || market0.question_id,
          allKeys: Object.keys(market0),
        } : 'no markets',
        fullDataKeys: Object.keys(data),
      });
      
      // Log full response in development or if extraction fails
      if (process.env.NODE_ENV === 'development' || !market0?.clobTokenIds) {
        console.log(`[PolymarketAPI] Full response for ${slug}:`, JSON.stringify(data, null, 2).substring(0, 3000));
      }
      
      // Log full response for debugging (commented out in production)
      if (process.env.NODE_ENV === 'development') {
        console.log(`[PolymarketAPI] Full response for ${slug}:`, JSON.stringify(data, null, 2).substring(0, 2000));
      }
      
      // Polymarket API returns nested structure, extract the fields we need
      // Try multiple possible locations for these fields
      const extractConditionId = (d: any): string | undefined => {
        return d.conditionId || d.condition_id || d.condition?.id || 
               d.markets?.[0]?.conditionId || d.markets?.[0]?.condition_id ||
               d.conditionId || d.conditions?.[0]?.id;
      };
      
      const extractQuestionId = (d: any): string | undefined => {
        return d.questionID || d.questionId || d.question_id || d.question?.id || 
               d.markets?.[0]?.questionID || d.markets?.[0]?.questionId || d.markets?.[0]?.question_id ||
               d.questions?.[0]?.id;
      };
      
      const extractClobTokenIds = (d: any): string[] | undefined => {
        console.log('[extractClobTokenIds] Starting extraction. Data structure:', {
          hasMarkets: !!d.markets,
          marketsLength: d.markets?.length || 0,
          hasTopLevelClobTokenIds: !!d.clobTokenIds,
          hasTopLevelTokens: !!d.tokens,
        });
        
        // Try top-level clobTokenIds first (for /markets/slug/ endpoint)
        if (d.clobTokenIds) {
          if (typeof d.clobTokenIds === 'string') {
            try {
              const parsed = JSON.parse(d.clobTokenIds);
              if (Array.isArray(parsed)) {
                console.log('[extractClobTokenIds] ✓ Found in top-level clobTokenIds (parsed):', parsed);
                return parsed;
              }
            } catch (e) {
              console.warn('[extractClobTokenIds] Failed to parse clobTokenIds as JSON:', e);
            }
          } else if (Array.isArray(d.clobTokenIds)) {
            console.log('[extractClobTokenIds] ✓ Found in top-level clobTokenIds (array):', d.clobTokenIds);
            return d.clobTokenIds;
          }
        }
        
        // Check markets array (for other endpoints that return nested structure)
        if (d.markets && Array.isArray(d.markets) && d.markets.length > 0) {
          const market = d.markets[0];
          console.log('[extractClobTokenIds] Market[0] keys:', Object.keys(market));
          console.log('[extractClobTokenIds] Market[0] structure:', {
            hasClobTokenIds: !!market.clobTokenIds,
            clobTokenIdsType: typeof market.clobTokenIds,
            hasTokens: !!market.tokens,
            tokensLength: market.tokens?.length || 0,
            tokensStructure: market.tokens?.[0] ? Object.keys(market.tokens[0]) : [],
          });
          
          // Try clobTokenIds in market
          if (market.clobTokenIds) {
            if (typeof market.clobTokenIds === 'string') {
              try {
                const parsed = JSON.parse(market.clobTokenIds);
                if (Array.isArray(parsed)) {
                  console.log('[extractClobTokenIds] ✓ Found in markets[0].clobTokenIds (parsed):', parsed);
                  return parsed;
                }
              } catch (e) {
                console.warn('[extractClobTokenIds] Failed to parse markets[0].clobTokenIds as JSON:', e);
              }
            } else if (Array.isArray(market.clobTokenIds)) {
              console.log('[extractClobTokenIds] ✓ Found in markets[0].clobTokenIds (array):', market.clobTokenIds);
              return market.clobTokenIds;
            }
          }
          
          // Try tokens array in market (most reliable source)
          if (market.tokens && Array.isArray(market.tokens) && market.tokens.length > 0) {
            const tokenIds = market.tokens
              .map((t: any) => {
                const id = t.token_id || t.tokenId || t.id || t.clobTokenId;
                console.log('[extractClobTokenIds] Token structure:', { id, allKeys: Object.keys(t) });
                return id;
              })
              .filter(Boolean);
            if (tokenIds.length > 0) {
              console.log('[extractClobTokenIds] ✓ Found in markets[0].tokens:', tokenIds);
              return tokenIds;
            }
          }
        }
        
        // Try other possible locations (clob_token_ids, tokens, outcomes)
        if (d.clob_token_ids) {
          if (typeof d.clob_token_ids === 'string') {
            try {
              const parsed = JSON.parse(d.clob_token_ids);
              if (Array.isArray(parsed)) {
                console.log('[extractClobTokenIds] ✓ Found in clob_token_ids (parsed):', parsed);
                return parsed;
              }
            } catch (e) {
              // Ignore parse errors
            }
          } else if (Array.isArray(d.clob_token_ids)) {
            console.log('[extractClobTokenIds] ✓ Found in clob_token_ids (array):', d.clob_token_ids);
            return d.clob_token_ids;
          }
        }
        
        // Try extracting from tokens/outcomes arrays
        if (d.tokens && Array.isArray(d.tokens)) {
          const tokenIds = d.tokens.map((t: any) => t.token_id || t.tokenId || t.id).filter(Boolean);
          if (tokenIds.length > 0) {
            console.log('[extractClobTokenIds] ✓ Found in top-level tokens:', tokenIds);
            return tokenIds;
          }
        }
        if (d.outcomes && Array.isArray(d.outcomes)) {
          const tokenIds = d.outcomes.map((o: any) => o.token_id || o.tokenId || o.id).filter(Boolean);
          if (tokenIds.length > 0) {
            console.log('[extractClobTokenIds] ✓ Found in outcomes:', tokenIds);
            return tokenIds;
          }
        }
        
        console.warn('[extractClobTokenIds] ✗ Could not find clobTokenIds. Full data keys:', Object.keys(d));
        if (d.markets?.[0]) {
          console.warn('[extractClobTokenIds] Market[0] full structure:', JSON.stringify(d.markets[0], null, 2).substring(0, 1000));
        }
        return undefined;
      };
      
      // Extract the fields first
      const extractedClobTokenIds = extractClobTokenIds(data);
      const extractedConditionId = extractConditionId(data);
      const extractedQuestionId = extractQuestionId(data);
      
      // Log extraction results
      console.log(`[PolymarketAPI] Extraction results for ${slug}:`, {
        conditionId: extractedConditionId || 'NOT FOUND',
        questionId: extractedQuestionId || 'NOT FOUND',
        clobTokenIds: extractedClobTokenIds || 'NOT FOUND',
        clobTokenIdsCount: extractedClobTokenIds?.length || 0,
      });
      
      // If extraction failed, log warning and try to find alternative locations
      if (!extractedClobTokenIds || !extractedConditionId || !extractedQuestionId) {
        console.warn(`[PolymarketAPI] ⚠️ Missing data for ${slug}:`, {
          missingClobTokenIds: !extractedClobTokenIds,
          missingConditionId: !extractedConditionId,
          missingQuestionId: !extractedQuestionId,
        });
        
        // Try to extract from alternative locations as last resort
        if (!extractedClobTokenIds && data.markets?.[0]?.tokens) {
          const altTokenIds = data.markets[0].tokens
            .map((t: any) => t.token_id || t.tokenId || t.id || t.clobTokenId)
            .filter(Boolean);
          if (altTokenIds.length > 0) {
            console.log(`[PolymarketAPI] Found alternative token IDs:`, altTokenIds);
          }
        }
      }
      
      const event: PolymarketEvent = {
        slug: data.slug || '',
        title: data.title || data.question || '',
        description: data.description,
        startDate: data.startDate || data.start_date || '',
        endDate: data.endDate || data.end_date || '',
        active: data.active || false,
        closed: data.closed || false,
        conditionId: extractedConditionId,
        questionId: extractedQuestionId,
        questionID: extractedQuestionId, // Also set questionID for compatibility
        clobTokenIds: extractedClobTokenIds as string[], // Ensure it's an array, not string
        liquidity: data.liquidity,
        volume: data.volume,
        markets: data.markets, // IMPORTANT: Preserve markets data for fallback extraction
        ...data // Include any other fields for debugging
      };
      
      // Override with extracted values to ensure they're not overwritten by spread
      event.conditionId = extractedConditionId;
      event.questionId = extractedQuestionId;
      event.questionID = extractedQuestionId;
      event.clobTokenIds = extractedClobTokenIds as string[];
      // Ensure markets is preserved (spread might overwrite it)
      if (data.markets) {
        event.markets = data.markets;
      }
      
      console.log(`[PolymarketAPI] Final event data for ${slug}:`, {
        conditionId: event.conditionId || 'MISSING',
        questionId: event.questionId || 'MISSING',
        questionID: event.questionID || 'MISSING',
        clobTokenIds: event.clobTokenIds || 'MISSING',
        clobTokenIdsType: typeof event.clobTokenIds,
        clobTokenIdsIsArray: Array.isArray(event.clobTokenIds),
        clobTokenIdsLength: Array.isArray(event.clobTokenIds) ? event.clobTokenIds.length : 0,
        // Also check if markets data is preserved
        hasMarkets: !!event.markets,
        marketsLength: event.markets?.length || 0,
        market0ClobTokenIds: event.markets?.[0]?.clobTokenIds || 'MISSING',
        market0Tokens: event.markets?.[0]?.tokens?.length || 0,
      });
      
      // Ensure markets data is preserved in the event object for fallback extraction
      if (data.markets && !event.markets) {
        event.markets = data.markets;
        console.log(`[PolymarketAPI] Preserved markets data in event object for ${slug}`);
      }
      
      return event;
    } catch (error) {
      console.error(`Error fetching event ${slug}:`, error);
      
      // Provide more specific error messages
      if (error instanceof TypeError && error.message.includes('fetch')) {
        // This is likely a CORS or network error
        throw new Error('Network error: Unable to connect to Polymarket API. This may be due to CORS restrictions. Please check your network connection or use a CORS proxy.');
      }
      
      throw error;
    }
  }

  static async fetchMultipleEvents(slugs: string[]): Promise<Array<PolymarketEvent | null>> {
    const promises = slugs.map(slug => this.fetchEventBySlug(slug));
    return Promise.all(promises);
  }
}

