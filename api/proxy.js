/**
 * WebGate v1.2.3 — Vercel Serverless Proxy
 *
 * This is the core of the virtual browser. Every request from the iframe
 * hits this endpoint. It fetches the real page, rewrites ALL URLs in HTML/CSS
 * to point back through this proxy, and returns the result.
 *
 * Flow: iframe loads /api/proxy?url=X → this fetches X → rewrites URLs → returns
 *       browser sees <link href="/api/proxy?url=Y"> → fetches Y through here too
 *       ... and so on for every sub-resource.
 */

const MAX_SIZE = 15 * 1024 * 1024;

export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Health / no-url
  if (!req.query.url) {
    return res.status(200).json({ status: 'ok', version: '1.2.3' });
  }

  const targetUrl = req.query.url;

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    return res.status(400).json({ error: 'Only HTTP/HTTPS' });
  }

  try {
    // Build proxy base from incoming request
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const PROXY = `${proto}://${host}/api/proxy`;

    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': target.origin + '/',
    };

    // Forward cookies from client to target
    if (req.headers.cookie) {
      fetchHeaders['Cookie'] = req.headers.cookie;
    }

    const fetchOpts = {
      method: req.method === 'POST' ? 'POST' : 'GET',
      headers: fetchHeaders,
      redirect: 'follow',
    };

    if (req.method === 'POST' && req.body) {
      fetchOpts.body = typeof req.body === 'string'
        ? req.body
        : new URLSearchParams(req.body).toString();
      fetchHeaders['Content-Type'] = req.headers['content-type'] || 'application/x-www-form-urlencoded';
    }

    const resp = await fetch(target.toString(), fetchOpts);

    const ct = resp.headers.get('content-type') || 'application/octet-stream';
    const cc = resp.headers.get('cache-control');
    if (cc) res.setHeader('Cache-Control', cc);

    // Forward Set-Cookie headers from target (rewrite for proxy domain)
    const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
    if (setCookies.length) {
      const rewritten = setCookies.map(c =>
        c.replace(/;\s*domain=[^;]*/gi, '')
         .replace(/;\s*secure/gi, '')
         .replace(/;\s*samesite=[^;]*/gi, '')
        + '; SameSite=Lax; Path=/'
      );
      res.setHeader('Set-Cookie', rewritten);
    }

    const isHtml = ct.includes('text/html');
    const isCss = ct.includes('text/css');

    // ── Text content that needs rewriting ──
    if (isHtml || isCss) {
      const buf = Buffer.from(await resp.arrayBuffer());
      let text = buf.toString('utf-8');

      if (isHtml) {
        text = rewriteHtml(text, target, PROXY);
      } else {
        text = rewriteCss(text, target, PROXY);
      }

      res.setHeader('Content-Type', ct);
      return res.status(resp.status).send(text);
    }

    // ── JavaScript: rewrite common URL patterns ──
    const isJs = ct.includes('javascript') || ct.includes('ecmascript');
    if (isJs) {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_SIZE) {
        return res.status(413).json({ error: 'Response too large' });
      }
      let js = buf.toString('utf-8');
      js = rewriteJsUrls(js, target, PROXY);
      res.setHeader('Content-Type', ct);
      return res.status(resp.status).send(js);
    }

    // ── m3u8/HLS playlists and manifests: rewrite URLs ──
    const isManifest = ct.includes('mpegurl') || ct.includes('m3u8') ||
      ct.includes('dash+xml') || targetUrl.match(/\.(m3u8|mpd)(\?|$)/i);
    if (isManifest) {
      const buf = Buffer.from(await resp.arrayBuffer());
      let text = buf.toString('utf-8');
      text = rewriteManifest(text, target, PROXY);
      res.setHeader('Content-Type', ct);
      return res.status(resp.status).send(text);
    }

    // ── Everything else: pass through binary (images, fonts, etc.) ──
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_SIZE) {
      return res.status(413).json({ error: 'Response too large' });
    }
    res.setHeader('Content-Type', ct);
    return res.status(resp.status).send(buf);

  } catch (err) {
    return res.status(502).json({ error: `Proxy error: ${err.message}` });
  }
}


// ═══════════════════════════════════════════
// URL helpers
// ═══════════════════════════════════════════

function resolve(raw, base) {
  if (!raw || /^(data:|blob:|javascript:|mailto:|tel:|#)/.test(raw)) return null;
  try {
    if (raw.startsWith('//')) return base.protocol + raw;
    if (/^https?:\/\//i.test(raw)) return raw;
    return new URL(raw, base.href).href;
  } catch { return null; }
}

function px(raw, base, PROXY) {
  const abs = resolve(raw, base);
  if (!abs) return null;
  return `${PROXY}?url=${encodeURIComponent(abs)}`;
}


// ═══════════════════════════════════════════
// HTML rewriting — comprehensive
// ═══════════════════════════════════════════

function rewriteHtml(html, base, PROXY) {

  // 1. Extract and consume <base href> if present
  html = html.replace(/<base\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*\/?>/gi, (_, href) => {
    try { base = new URL(href, base.href); } catch {}
    return '';
  });

  // 2. Rewrite ALL src/href/srcset/poster/action/data attributes
  //    This single regex handles both " and ' quoted values for any attribute.
  //    We match the attribute name, then capture the URL.

  // Double-quoted attributes
  html = html.replace(
    /(\b(?:src|href|srcset|poster|data|content|action|background|formaction)\s*=\s*")([^"]*?)(")/gi,
    (m, pre, val, post, offset) => rewriteAttr(m, pre, val, post, html, offset, base, PROXY)
  );

  // Single-quoted attributes
  html = html.replace(
    /(\b(?:src|href|srcset|poster|data|content|action|background|formaction)\s*=\s*')([^]*?)(')/gi,
    (m, pre, val, post, offset) => rewriteAttr(m, pre, val, post, html, offset, base, PROXY)
  );

  // Unquoted attributes (e.g., src=script.js)
  html = html.replace(
    /(\b(?:src|href|action|background|formaction)\s*=\s*)([^\s>"']+)/gi,
    (m, pre, val) => {
      if (!val || val.startsWith('data:') || val.startsWith('#') || val.includes('/api/proxy') || val.startsWith('"') || val.startsWith("'")) return m;
      const p = px(val, base, PROXY);
      return p ? pre + '"' + p + '"' : m;
    }
  );

  // 3. Inline style="..." — rewrite url() inside
  html = html.replace(/(style\s*=\s*")([^"]+)(")/gi, (m, pre, css, post) => {
    return pre + rewriteCssUrls(css, base, PROXY) + post;
  });
  html = html.replace(/(style\s*=\s*')([^']+)(')/gi, (m, pre, css, post) => {
    return pre + rewriteCssUrls(css, base, PROXY) + post;
  });

  // 4. <style> blocks
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => {
    return open + rewriteCss(css, base, PROXY) + close;
  });

  // 5. Rewrite <a> tags for navigation via postMessage
  //    (after the general href rewrite above, <a> hrefs now point to /api/proxy?url=...
  //     we need to override them to use postMessage instead for SPA navigation)
  html = html.replace(
    /(<a\s[^>]*?)href\s*=\s*"([^"]*\/api\/proxy\?url=([^"]*))"/gi,
    (m, pre, proxyHref, encoded) => {
      const original = decodeURIComponent(encoded);
      return `${pre}href="#" data-proxy-href="${escapeHtml(original)}" onclick="window.parent.postMessage({type:'navigate',url:this.dataset.proxyHref},'*');return false;"`;
    }
  );
  html = html.replace(
    /(<a\s[^>]*?)href\s*=\s*'([^']*\/api\/proxy\?url=([^']*))'/ ,
    (m, pre, proxyHref, encoded) => {
      const original = decodeURIComponent(encoded);
      return `${pre}href="#" data-proxy-href="${escapeHtml(original)}" onclick="window.parent.postMessage({type:'navigate',url:this.dataset.proxyHref},'*');return false;"`;
    }
  );

  // 6. Inject intercept script for navigation + JS runtime URL interception
  const script = `
<script>
(function(){
  var BASE = ${JSON.stringify(base.href)};
  var PROXY = ${JSON.stringify(PROXY)};
  var PROXY_ORIGIN = new URL(PROXY).origin;
  var BASE_ORIGIN = new URL(BASE).origin;

  function shouldProxy(u) {
    return u && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('javascript:') && u !== '#' && u.indexOf('?url=') === -1;
  }

  // Fix URLs that wrongly point to the proxy domain (from window.location usage)
  function fixProxyDomainUrl(u) {
    if (!u) return u;
    // If URL starts with proxy origin but is NOT a proxy API call, fix it
    if (u.startsWith(PROXY_ORIGIN) && u.indexOf('/api/proxy') === -1 && u.indexOf('?url=') === -1) {
      var path = u.slice(PROXY_ORIGIN.length);
      return BASE_ORIGIN + path;
    }
    return u;
  }

  function toProxy(u) {
    if (!shouldProxy(u)) return u;
    try {
      u = fixProxyDomainUrl(u);
      var abs = /^https?:\\/\\//.test(u) ? u : new URL(u, BASE).href;
      return PROXY + '?url=' + encodeURIComponent(abs);
    } catch(e) { return u; }
  }

  // ── Intercept fetch() ──
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      input = toProxy(input);
    } else if (input instanceof Request && shouldProxy(input.url)) {
      input = new Request(toProxy(input.url), input);
    }
    return _fetch.call(this, input, init);
  };

  // ── Intercept XMLHttpRequest.open() ──
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string') url = toProxy(url);
    return _xhrOpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments, 2)));
  };

  // ── Intercept window.open() ──
  var _wopen = window.open;
  window.open = function(url) {
    if (url && shouldProxy(url)) {
      try { url = /^https?:\\/\\//.test(url) ? url : new URL(url, BASE).href; } catch(e) {}
      window.parent.postMessage({ type: 'navigate', url: url }, '*');
      return null;
    }
    return _wopen.apply(this, arguments);
  };

  // ── Intercept Element.src property sets (catches relative URLs too) ──
  ['HTMLImageElement','HTMLScriptElement','HTMLIFrameElement','HTMLSourceElement','HTMLMediaElement','HTMLEmbedElement'].forEach(function(t) {
    var ctor = window[t];
    if (!ctor) return;
    var desc = Object.getOwnPropertyDescriptor(ctor.prototype, 'src');
    if (desc && desc.set) {
      Object.defineProperty(ctor.prototype, 'src', {
        set: function(v) { if (typeof v === 'string') v = toProxy(v); desc.set.call(this, v); },
        get: desc.get,
        configurable: true
      });
    }
  });

  // ── Intercept HTMLLinkElement.href (stylesheets, preloads) ──
  var linkDesc = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href');
  if (linkDesc && linkDesc.set) {
    Object.defineProperty(HTMLLinkElement.prototype, 'href', {
      set: function(v) { if (typeof v === 'string') v = toProxy(v); linkDesc.set.call(this, v); },
      get: linkDesc.get,
      configurable: true
    });
  }

  // ── Intercept setAttribute to catch all dynamic attribute sets ──
  var _setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    var n = name.toLowerCase();
    if ((n === 'src' || n === 'href' || n === 'action' || n === 'srcset' || n === 'poster' || n === 'background') && typeof value === 'string') {
      if (n === 'srcset') {
        value = value.split(',').map(function(entry) {
          var parts = entry.trim().split(/\\s+/);
          if (parts[0]) parts[0] = toProxy(parts[0]);
          return parts.join(' ');
        }).join(', ');
      } else {
        value = toProxy(value);
      }
    }
    return _setAttribute.call(this, name, value);
  };

  // ── MutationObserver: catch dynamically added elements ──
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mut) {
      mut.addedNodes.forEach(function(node) {
        if (node.nodeType !== 1) return;
        rewriteNode(node);
        if (node.querySelectorAll) {
          node.querySelectorAll('[src],[href],[srcset],[poster],[action],[background]').forEach(rewriteNode);
        }
      });
    });
  });
  function rewriteNode(el) {
    ['src','href','poster','action','background'].forEach(function(attr) {
      var v = el.getAttribute && el.getAttribute(attr);
      if (v && shouldProxy(v)) el.setAttribute(attr, toProxy(v));
    });
    var ss = el.getAttribute && el.getAttribute('srcset');
    if (ss && shouldProxy(ss)) {
      el.setAttribute('srcset', ss.split(',').map(function(entry) {
        var parts = entry.trim().split(/\\s+/);
        if (parts[0]) parts[0] = toProxy(parts[0]);
        return parts.join(' ');
      }).join(', '));
    }
  }
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true });

  document.addEventListener('click', function(e) {
    var a = e.target.closest('a');
    if (!a) return;

    var href = a.dataset.proxyHref;
    if (!href) {
      href = a.getAttribute('href');
      if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('blob:') || href.startsWith('data:')) return;
      // Resolve relative
      try { href = new URL(href, BASE).href; } catch(x) { return; }
    }

    e.preventDefault();
    e.stopPropagation();
    window.parent.postMessage({ type: 'navigate', url: href }, '*');
  }, true);

  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    e.preventDefault();
    var action = form.getAttribute('action') || BASE;
    try { action = new URL(action, BASE).href; } catch(x) {}
    var fd = new FormData(form);
    var params = new URLSearchParams(fd).toString();
    var method = (form.method || 'GET').toUpperCase();
    if (method === 'GET') {
      window.parent.postMessage({ type: 'navigate', url: action.split('?')[0] + '?' + params }, '*');
    } else {
      window.parent.postMessage({ type: 'navigate', url: action, method: 'POST', body: params }, '*');
    }
  }, true);
})();
</` + 'script>';

  // Inject at the TOP of <head> so interceptors are active before any resources load
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, '$1' + script);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/(<html[^>]*>)/i, '$1<head>' + script + '</head>');
  } else if (/<\!doctype[^>]*>/i.test(html)) {
    html = html.replace(/(<\!doctype[^>]*>)/i, '$1<head>' + script + '</head>');
  } else {
    html = '<head>' + script + '</head>' + html;
  }

  return html;
}


/**
 * Rewrite a single attribute value.
 * Handles src, href, srcset, poster, data, content (for meta refresh).
 * Skips <a> href here (those are rewritten separately for postMessage nav).
 */
function rewriteAttr(match, pre, val, post, html, offset, base, PROXY) {
  if (!val || val.startsWith('data:') || val.startsWith('blob:') || val.startsWith('javascript:') || val.startsWith('#')) {
    return match;
  }

  // Already proxied?
  if (val.includes('/api/proxy?url=')) return match;

  // Determine which attribute this is
  const attrMatch = pre.match(/(\w+)\s*=\s*["']?$/);
  if (!attrMatch) return match;
  const attr = attrMatch[1].toLowerCase();

  // srcset needs special handling (comma-separated list)
  if (attr === 'srcset') {
    const rewritten = val.split(',').map(entry => {
      const parts = entry.trim().split(/\s+/);
      if (parts[0]) {
        const p = px(parts[0], base, PROXY);
        if (p) parts[0] = p;
      }
      return parts.join(' ');
    }).join(', ');
    return pre + rewritten + post;
  }

  // content attr — only rewrite if it looks like a URL (meta refresh)
  if (attr === 'content') {
    const refreshMatch = val.match(/^(\d+;\s*url\s*=\s*)(.+)$/i);
    if (refreshMatch) {
      const p = px(refreshMatch[2], base, PROXY);
      return p ? pre + refreshMatch[1] + p + post : match;
    }
    return match;
  }

  // All other attrs: src, href, poster, data
  const p = px(val, base, PROXY);
  return p ? pre + p + post : match;
}


// ═══════════════════════════════════════════
// CSS rewriting
// ═══════════════════════════════════════════

function rewriteCss(css, base, PROXY) {
  // @import url("...")
  css = css.replace(/@import\s+url\(\s*["']?([^"')]+?)["']?\s*\)/gi, (m, url) => {
    const p = px(url, base, PROXY);
    return p ? `@import url("${p}")` : m;
  });

  // @import "..."
  css = css.replace(/@import\s+["']([^"']+)["']/gi, (m, url) => {
    const p = px(url, base, PROXY);
    return p ? `@import "${p}"` : m;
  });

  // url(...)
  css = rewriteCssUrls(css, base, PROXY);

  return css;
}

function rewriteCssUrls(css, base, PROXY) {
  return css.replace(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi, (m, url) => {
    if (/^data:/i.test(url) || url.includes('/api/proxy')) return m;
    const p = px(url.trim(), base, PROXY);
    return p ? `url("${p}")` : m;
  });
}


function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}


// ═══════════════════════════════════════════
// JavaScript URL rewriting
// ═══════════════════════════════════════════

function rewriteJsUrls(js, base, PROXY) {
  // Rewrite absolute URLs in string literals: "https://..." and 'https://...'
  js = js.replace(/(["'])(https?:\/\/[^"']+)\1/g, (m, q, url) => {
    // Skip if already proxied or is the proxy itself
    if (url.includes('/api/proxy') || url.includes('/proxy-worker') || url.includes('?url=')) return m;
    return q + PROXY + '?url=' + encodeURIComponent(url) + q;
  });
  return js;
}


// ═══════════════════════════════════════════
// HLS/DASH manifest rewriting
// ═══════════════════════════════════════════

function rewriteManifest(text, base, PROXY) {
  // Rewrite each non-comment, non-empty line that looks like a URL or path
  return text.split('\n').map(line => {
    const trimmed = line.trim();
    // Skip empty lines, comments (#EXT..., #...), and data URIs
    if (!trimmed || trimmed.startsWith('#')) {
      // But rewrite URI= inside #EXT tags (e.g., #EXT-X-MAP:URI="init.mp4")
      return line.replace(/URI="([^"]+)"/gi, (m, uri) => {
        const p = px(uri, base, PROXY);
        return p ? `URI="${p}"` : m;
      });
    }
    // This line is a URL/path — proxy it
    const p = px(trimmed, base, PROXY);
    return p || line;
  }).join('\n');
}
