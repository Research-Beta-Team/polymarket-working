import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  console.log('[Hello] Function executed at:', new Date().toISOString());
  console.log('[Hello] Request details:', {
    method: req.method,
    url: req.url,
    query: req.query,
  });
  
  return res.status(200).json({
    message: 'Hello from Vercel serverless function!',
    timestamp: new Date().toISOString(),
    query: req.query,
    url: req.url,
  });
}
