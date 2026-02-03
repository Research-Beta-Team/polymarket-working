import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Log immediately to verify function is being called
  console.log('[Proxy] Function called!', {
    method: req.method,
    url: req.url,
    query: req.query,
    headers: Object.keys(req.headers),
  });
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  // Get the path segments from the catch-all route
  // In Vercel, catch-all routes put path segments in req.query.path as an array
  const pathSegments = req.query.path;
  
  // Convert to array and join
  let apiPath = '';
  if (pathSegments) {
    if (Array.isArray(pathSegments)) {
      apiPath = pathSegments.join('/');
    } else if (typeof pathSegments === 'string') {
      apiPath = pathSegments;
    }
  }
  
  // Fallback: Extract from URL if path is not in query
  // This handles cases where Vercel routing doesn't populate req.query.path
  if (!apiPath && req.url) {
    // Try multiple patterns to extract the path
    const patterns = [
      /\/api\/polymarket\/(.+?)(?:\?|$)/,  // Standard pattern
      /\/api\/polymarket\/(.*)/,            // More permissive
    ];
    
    for (const pattern of patterns) {
      const urlMatch = req.url.match(pattern);
      if (urlMatch && urlMatch[1]) {
        apiPath = urlMatch[1];
        break;
      }
    }
  }
  
  // Additional fallback: Check if path is in the URL pathname
  if (!apiPath && req.url) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathParts = url.pathname.split('/');
      const polymarketIndex = pathParts.indexOf('polymarket');
      if (polymarketIndex >= 0 && pathParts.length > polymarketIndex + 1) {
        apiPath = pathParts.slice(polymarketIndex + 1).join('/');
      }
    } catch (e) {
      // URL parsing failed, continue with other methods
    }
  }
  
  // Log for debugging
  console.log('[Proxy] Path extraction:', {
    queryPath: req.query.path,
    extractedPath: apiPath,
    url: req.url,
    query: req.query,
  });
  
  if (!apiPath) {
    return res.status(400).json({
      error: 'No API path provided',
      query: req.query,
      url: req.url,
    });
  }
  
  // Construct the full URL
  const baseUrl = `https://gamma-api.polymarket.com/${apiPath}`;
  
  // Forward query parameters (excluding 'path')
  const queryParams = new URLSearchParams();
  Object.entries(req.query).forEach(([key, value]) => {
    if (key !== 'path' && value) {
      if (Array.isArray(value)) {
        value.forEach(v => queryParams.append(key, String(v)));
      } else {
        queryParams.append(key, String(value));
      }
    }
  });
  
  const fullUrl = queryParams.toString() 
    ? `${baseUrl}?${queryParams.toString()}`
    : baseUrl;
  
  console.log(`[Proxy] Requesting: ${fullUrl}`);

  try {
    const response = await fetch(fullUrl, {
      method: req.method || 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error(`[Proxy] API error: ${response.status} - ${errorText}`);
      return res.status(response.status).json({
        error: `API returned ${response.status}`,
        status: response.status,
        details: errorText,
      });
    }

    const data = await response.json();
    
    // Log response structure for debugging (only for markets endpoints)
    if (apiPath.includes('markets/slug')) {
      const market0 = data.markets?.[0];
      console.log(`[Proxy] Response structure for ${apiPath}:`, {
        hasMarkets: !!data.markets,
        marketsLength: data.markets?.length || 0,
        hasClobTokenIds: !!data.clobTokenIds || !!data.clob_token_ids,
        hasConditionId: !!data.conditionId || !!data.condition_id,
        hasQuestionId: !!data.questionID || !!data.questionId,
        market0ClobTokenIds: market0?.clobTokenIds ? 'exists' : 'missing',
        market0Tokens: market0?.tokens?.length || 0,
        market0ConditionId: market0?.conditionId || market0?.condition_id || 'missing',
        market0QuestionId: market0?.questionID || market0?.questionId || market0?.question_id || 'missing',
        market0TokenIds: market0?.tokens?.map((t: any) => t.token_id || t.tokenId || t.id).filter(Boolean) || [],
        // Log first 500 chars of full response for debugging
        fullResponseSample: JSON.stringify(data).substring(0, 500),
      });
      
      // Also log the full market structure if available
      if (market0) {
        console.log(`[Proxy] Market[0] full structure:`, JSON.stringify(market0, null, 2).substring(0, 2000));
      }
    }
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    return res.status(200).json(data);
  } catch (error) {
    console.error('[Proxy] Error:', error);
    return res.status(500).json({
      error: 'Failed to fetch from Polymarket API',
      message: error instanceof Error ? error.message : 'Unknown error',
      url: fullUrl,
    });
  }
}
