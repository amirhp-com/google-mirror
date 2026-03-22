/**
 * WebGate Proxy — Vercel Serverless Function
 * Fetches blocked URLs, rewrites ALL sub-resource URLs (HTML, CSS, JS)
 * to route back through this proxy so everything loads correctly.
 */

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10 MB

export default async function handler(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Health check
  if (!req.query.url) {
    return res.status(200).json({ status: 'ok', timestamp: Date.now() });
  }

  const targetUrl = req.query.url;

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
      'Referer': target.origin,
    };

    const fetchOptions = {
      method: req.method === 'POST' ? 'POST' : 'GET',
      headers: fetchHeaders,
      redirect: 'follow',
    };

    if (req.method === 'POST' && req.body) {
      fetchOptions.body = typeof req.body === 'string' ? req.body : new URLSearchParams(req.body).toString();
      fetchHeaders['Content-Type'] = req.headers['content-type'] || 'application/x-www-form-urlencoded';
    }

    const response = await fetch(target.toString(), fetchOptions);

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
      return res.status(413).json({ error: 'Response too large' });
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const cacheControl = response.headers.get('cache-control');
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);

    // Determine the proxy base URL from the incoming request
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proxyBase = `${proto}://${host}/api/proxy`;

    const isHtml = contentType.includes('text/html');
    const isCss = contentType.includes('text/css');
    const isJs = contentType.includes('javascript');

    if (isHtml || isCss || isJs) {
      const buffer = Buffer.from(await response.arrayBuffer());
      let text = buffer.toString('utf-8');

      if (isHtml) {
        text = rewriteHtml(text, target, proxyBase);
      } else if (isCss) {
        text = rewriteCss(text, target, proxyBase);
      } else if (isJs) {
        // Minimal JS rewriting — only rewrite fetch/XMLHttpRequest URLs would be too complex
        // Just pass through JS as-is; most JS resources are CDN-hosted and load fine
      }

      res.setHeader('Content-Type', contentType);
      return res.status(response.status).send(text);
    }

    // Binary content (images, fonts, videos, etc.) — pass through as-is
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    return res.status(response.status).send(buffer);

  } catch (err) {
    return res.status(502).json({ error: `Proxy error: ${err.message}` });
  }
}


// ────────────────────────────────────────
// URL Resolution
// ────────────────────────────────────────

function resolveUrl(raw, baseUrl) {
  try {
    // Already absolute
    if (/^https?:\/\//i.test(raw)) return raw;
    // Protocol-relative
    if (raw.startsWith('//')) return baseUrl.protocol + raw;
    // Data/blob/javascript — leave alone
    if (/^(data:|blob:|javascript:|#|mailto:)/i.test(raw)) return null;
    // Resolve relative
    return new URL(raw, baseUrl.href).href;
  } catch {
    return null;
  }
}

function proxyUrl(raw, baseUrl, proxyBase) {
  const resolved = resolveUrl(raw, baseUrl);
  if (!resolved) return null;
  return `${proxyBase}?url=${encodeURIComponent(resolved)}`;
}


// ────────────────────────────────────────
// HTML Rewriting
// ────────────────────────────────────────

function rewriteHtml(html, baseUrl, proxyBase) {
  // Rewrite <base href> if present, and capture it for resolving
  html = html.replace(/<base\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi, (match, href) => {
    try {
      baseUrl = new URL(href, baseUrl.href);
    } catch {}
    return ''; // Remove <base> — we handle resolution ourselves
  });

  // ── Rewrite attributes with double quotes ──

  // src="..." (img, script, iframe, video, audio, source, embed)
  html = html.replace(/(src\s*=\s*")([^"]+)(")/gi, (m, pre, url, post) => {
    const p = proxyUrl(url, baseUrl, proxyBase);
    return p ? pre + p + post : m;
  });

  // src='...'
  html = html.replace(/(src\s*=\s*')([^']+)(')/gi, (m, pre, url, post) => {
    const p = proxyUrl(url, baseUrl, proxyBase);
    return p ? pre + p + post : m;
  });

  // href="..." on <link> tags (CSS, icons, preload)
  html = html.replace(/(<link\s[^>]*?href\s*=\s*")([^"]+)(")/gi, (m, pre, url, post) => {
    const p = proxyUrl(url, baseUrl, proxyBase);
    return p ? pre + p + post : m;
  });

  // href='...' on <link> tags
  html = html.replace(/(<link\s[^>]*?href\s*=\s*')([^']+)(')/gi, (m, pre, url, post) => {
    const p = proxyUrl(url, baseUrl, proxyBase);
    return p ? pre + p + post : m;
  });

  // srcset="..." (responsive images)
  html = html.replace(/(srcset\s*=\s*")([^"]+)(")/gi, (m, pre, srcset, post) => {
    const rewritten = srcset.split(',').map(entry => {
      const parts = entry.trim().split(/\s+/);
      const p = proxyUrl(parts[0], baseUrl, proxyBase);
      if (p) parts[0] = p;
      return parts.join(' ');
    }).join(', ');
    return pre + rewritten + post;
  });

  // srcset='...'
  html = html.replace(/(srcset\s*=\s*')([^']+)(')/gi, (m, pre, srcset, post) => {
    const rewritten = srcset.split(',').map(entry => {
      const parts = entry.trim().split(/\s+/);
      const p = proxyUrl(parts[0], baseUrl, proxyBase);
      if (p) parts[0] = p;
      return parts.join(' ');
    }).join(', ');
    return pre + rewritten + post;
  });

  // poster="..."
  html = html.replace(/(poster\s*=\s*")([^"]+)(")/gi, (m, pre, url, post) => {
    const p = proxyUrl(url, baseUrl, proxyBase);
    return p ? pre + p + post : m;
  });

  // action="..." on forms — rewrite to proxy
  html = html.replace(/(<form\s[^>]*?action\s*=\s*")([^"]+)(")/gi, (m, pre, url, post) => {
    const p = proxyUrl(url, baseUrl, proxyBase);
    return p ? pre + p + post : m;
  });

  // Inline style="...url(...)..."
  html = html.replace(/(style\s*=\s*")([^"]+)(")/gi, (m, pre, css, post) => {
    return pre + rewriteCssUrls(css, baseUrl, proxyBase) + post;
  });

  html = html.replace(/(style\s*=\s*')([^']+)(')/gi, (m, pre, css, post) => {
    return pre + rewriteCssUrls(css, baseUrl, proxyBase) + post;
  });

  // <style> blocks
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => {
    return open + rewriteCss(css, baseUrl, proxyBase) + close;
  });

  // ── Rewrite <a href> to use postMessage for navigation ──
  // Double quotes
  html = html.replace(/(<a\s[^>]*?)href\s*=\s*"([^"]+)"([^>]*>)/gi, (m, pre, href, post) => {
    const resolved = resolveUrl(href, baseUrl);
    if (!resolved) return m;
    return `${pre}href="#" data-proxy-href="${escapeHtml(resolved)}" onclick="window.parent.postMessage({type:'navigate',url:this.dataset.proxyHref},'*');return false;"${post}`;
  });

  // Single quotes
  html = html.replace(/(<a\s[^>]*?)href\s*=\s*'([^']+)'([^>]*>)/gi, (m, pre, href, post) => {
    const resolved = resolveUrl(href, baseUrl);
    if (!resolved) return m;
    return `${pre}href="#" data-proxy-href="${escapeHtml(resolved)}" onclick="window.parent.postMessage({type:'navigate',url:this.dataset.proxyHref},'*');return false;"${post}`;
  });

  // ── Inject navigation intercept script ──
  const interceptScript = `
<script>
document.addEventListener('click', function(e) {
  var a = e.target.closest('a');
  if (!a) return;
  var href = a.dataset.proxyHref || a.getAttribute('href');
  if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('blob:')) return;
  // If it's a relative URL inside the iframe, resolve against original page
  if (href.startsWith('/') || (!href.startsWith('http') && !href.startsWith('//'))) {
    href = new URL(href, '${escapeHtml(baseUrl.href)}').href;
  }
  e.preventDefault();
  window.parent.postMessage({ type: 'navigate', url: href }, '*');
}, true);

document.addEventListener('submit', function(e) {
  var form = e.target;
  if (form.tagName !== 'FORM') return;
  e.preventDefault();
  var action = form.getAttribute('action') || '${escapeHtml(baseUrl.href)}';
  if (action.startsWith('/') || (!action.startsWith('http') && !action.startsWith('//'))) {
    action = new URL(action, '${escapeHtml(baseUrl.href)}').href;
  }
  var data = new FormData(form);
  var params = new URLSearchParams(data).toString();
  var method = (form.method || 'GET').toUpperCase();
  if (method === 'GET') {
    window.parent.postMessage({ type: 'navigate', url: action.split('?')[0] + '?' + params }, '*');
  } else {
    window.parent.postMessage({ type: 'navigate', url: action, method: 'POST', body: params }, '*');
  }
}, true);
</` + 'script>';

  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, interceptScript + '</body>');
  } else {
    html += interceptScript;
  }

  return html;
}


// ────────────────────────────────────────
// CSS Rewriting
// ────────────────────────────────────────

function rewriteCss(css, baseUrl, proxyBase) {
  // @import url("...")
  css = css.replace(/@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, url) => {
    const p = proxyUrl(url, baseUrl, proxyBase);
    return p ? `@import url("${p}")` : m;
  });

  // @import "..."
  css = css.replace(/@import\s+["']([^"']+)["']/gi, (m, url) => {
    const p = proxyUrl(url, baseUrl, proxyBase);
    return p ? `@import "${p}"` : m;
  });

  // url(...) in properties
  css = rewriteCssUrls(css, baseUrl, proxyBase);

  return css;
}

function rewriteCssUrls(css, baseUrl, proxyBase) {
  return css.replace(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi, (m, url) => {
    if (/^data:/i.test(url)) return m;
    const p = proxyUrl(url.trim(), baseUrl, proxyBase);
    return p ? `url("${p}")` : m;
  });
}


// ────────────────────────────────────────
// Helpers
// ────────────────────────────────────────

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
