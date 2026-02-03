import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  console.log('[Test] Function called!', {
    method: req.method,
    url: req.url,
    query: req.query,
  });
  
  return res.status(200).json({
    message: 'API proxy is working',
    timestamp: new Date().toISOString(),
    query: req.query,
    url: req.url,
    environment: process.env.NODE_ENV || 'production',
  });
}
