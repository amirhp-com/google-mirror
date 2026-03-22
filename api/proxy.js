/**
 * WebGate Proxy — Vercel Serverless Function
 * Fetches blocked URLs and returns them with CORS headers.
 */

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10 MB

export default async function handler(req, res) {
  // CORS headers for all responses
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Health check
  if (req.url === '/api/proxy' && !req.query.url) {
    return res.status(200).json({ status: 'ok', timestamp: Date.now() });
  }

  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  // Validate URL
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    return res.status(400).json({ error: 'Only HTTP/HTTPS URLs are supported' });
  }

  try {
    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    };

    const fetchOptions = {
      method: req.method === 'POST' ? 'POST' : 'GET',
      headers: fetchHeaders,
      redirect: 'follow',
    };

    // Forward POST body
    if (req.method === 'POST' && req.body) {
      fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      fetchHeaders['Content-Type'] = req.headers['content-type'] || 'application/x-www-form-urlencoded';
    }

    const response = await fetch(target.toString(), fetchOptions);

    // Check size
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
      return res.status(413).json({ error: 'Response too large' });
    }

    const contentType = response.headers.get('content-type') || 'text/html';
    res.setHeader('Content-Type', contentType);

    // Pass through cache headers
    const cacheControl = response.headers.get('cache-control');
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);

    const buffer = Buffer.from(await response.arrayBuffer());
    return res.status(response.status).send(buffer);
  } catch (err) {
    return res.status(502).json({ error: `Proxy error: ${err.message}` });
  }
}
