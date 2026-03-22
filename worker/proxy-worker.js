/**
 * WebGate Proxy Worker — Deploy to Cloudflare Workers (free tier)
 *
 * This worker receives requests from the GitHub Pages frontend,
 * fetches the target URL, and returns the response with proper CORS headers.
 *
 * Deploy: npx wrangler deploy worker/proxy-worker.js --name webgate-proxy
 */

// Allowed origins — add your GitHub Pages URL here
const ALLOWED_ORIGINS = [
  'https://amirhp-com.github.io',  // Replace with your actual GitHub Pages URL
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:5500',                   // VS Code Live Server
  'null',                                      // For local file:// testing
];

// Optional: block certain target domains
const BLOCKED_DOMAINS = [];

// Max response size (10 MB)
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCors(request, new Response(null, { status: 204 }));
    }

    try {
      const url = new URL(request.url);

      // Health check
      if (url.pathname === '/health') {
        return handleCors(request, new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      // Get target URL from query parameter
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return handleCors(request, new Response(
          JSON.stringify({ error: 'Missing ?url= parameter' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        ));
      }

      // Validate target URL
      let target;
      try {
        target = new URL(targetUrl);
      } catch {
        return handleCors(request, new Response(
          JSON.stringify({ error: 'Invalid URL' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        ));
      }

      // Only allow http/https
      if (!['http:', 'https:'].includes(target.protocol)) {
        return handleCors(request, new Response(
          JSON.stringify({ error: 'Only HTTP/HTTPS URLs are supported' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        ));
      }

      // Check blocked domains
      if (BLOCKED_DOMAINS.some(d => target.hostname.endsWith(d))) {
        return handleCors(request, new Response(
          JSON.stringify({ error: 'This domain is blocked' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        ));
      }

      // Fetch the target page
      const fetchHeaders = new Headers();
      fetchHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      fetchHeaders.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8');
      fetchHeaders.set('Accept-Language', 'en-US,en;q=0.9');
      fetchHeaders.set('Accept-Encoding', 'gzip');

      // Forward POST body if present
      let fetchOptions = {
        method: request.method === 'POST' ? 'POST' : 'GET',
        headers: fetchHeaders,
        redirect: 'follow',
      };

      if (request.method === 'POST') {
        fetchOptions.body = await request.text();
        fetchHeaders.set('Content-Type', request.headers.get('content-type') || 'application/x-www-form-urlencoded');
      }

      const response = await fetch(target.toString(), fetchOptions);

      // Check response size
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
        return handleCors(request, new Response(
          JSON.stringify({ error: 'Response too large' }),
          { status: 413, headers: { 'Content-Type': 'application/json' } }
        ));
      }

      // Build response headers
      const responseHeaders = new Headers();
      const contentType = response.headers.get('content-type');
      if (contentType) responseHeaders.set('Content-Type', contentType);

      // Pass through cache headers
      const cacheControl = response.headers.get('cache-control');
      if (cacheControl) responseHeaders.set('Cache-Control', cacheControl);

      const body = await response.arrayBuffer();

      return handleCors(request, new Response(body, {
        status: response.status,
        headers: responseHeaders,
      }));
    } catch (err) {
      return handleCors(request, new Response(
        JSON.stringify({ error: `Proxy error: ${err.message}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      ));
    }
  },
};

function handleCors(request, response) {
  const origin = request.headers.get('Origin') || '*';
  const headers = new Headers(response.headers);

  // In production, validate against ALLOWED_ORIGINS
  // For ease of setup, we allow all origins here — tighten this for production
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}
