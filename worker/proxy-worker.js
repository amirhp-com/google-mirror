/**
 * WebGate v1.1.0 — Cloudflare Workers Proxy
 *
 * Full-featured proxy with URL rewriting (same as Vercel backend).
 * Rewrites all HTML/CSS/JS URLs to route through the worker.
 *
 * Deploy: npx wrangler deploy worker/proxy-worker.js --name webgate-proxy
 */

const MAX_SIZE = 15 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return handleCors(request, new Response(null, { status: 204 }));
    }

    try {
      const url = new URL(request.url);
      const PROXY = url.origin + url.pathname;

      // Health check / no url param
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return handleCors(request, jsonResponse({ status: 'ok', version: '1.1.0' }));
      }

      let target;
      try {
        target = new URL(targetUrl);
      } catch {
        return handleCors(request, jsonResponse({ error: 'Invalid URL' }, 400));
      }

      if (!['http:', 'https:'].includes(target.protocol)) {
        return handleCors(request, jsonResponse({ error: 'Only HTTP/HTTPS' }, 400));
      }

      const fetchHeaders = new Headers();
      fetchHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
      fetchHeaders.set('Accept', '*/*');
      fetchHeaders.set('Accept-Language', 'en-US,en;q=0.9');
      fetchHeaders.set('Referer', target.origin + '/');

      // Forward cookies from client to target
      const clientCookies = request.headers.get('cookie');
      if (clientCookies) fetchHeaders.set('Cookie', clientCookies);

      const fetchOpts = {
        method: request.method === 'POST' ? 'POST' : 'GET',
        headers: fetchHeaders,
        redirect: 'follow',
      };

      if (request.method === 'POST') {
        fetchOpts.body = await request.text();
        fetchHeaders.set('Content-Type', request.headers.get('content-type') || 'application/x-www-form-urlencoded');
      }

      const resp = await fetch(target.toString(), fetchOpts);
      const ct = resp.headers.get('content-type') || 'application/octet-stream';
      const cc = resp.headers.get('cache-control');

      const respHeaders = new Headers();
      respHeaders.set('Content-Type', ct);
      if (cc) respHeaders.set('Cache-Control', cc);

      // Forward Set-Cookie headers from target (rewrite for proxy domain)
      const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
      setCookies.forEach(c => {
        respHeaders.append('Set-Cookie',
          c.replace(/;\s*domain=[^;]*/gi, '')
           .replace(/;\s*secure/gi, '')
           .replace(/;\s*samesite=[^;]*/gi, '')
          + '; SameSite=Lax; Path=/'
        );
      });

      const isHtml = ct.includes('text/html');
      const isCss = ct.includes('text/css');
      const isJs = ct.includes('javascript') || ct.includes('ecmascript');

      if (isHtml || isCss || isJs) {
        const buf = await resp.arrayBuffer();
        let text = new TextDecoder().decode(buf);

        if (isHtml) {
          text = rewriteHtml(text, target, PROXY);
        } else if (isCss) {
          text = rewriteCss(text, target, PROXY);
        } else {
          text = rewriteJsUrls(text, target, PROXY);
        }

        return handleCors(request, new Response(text, { status: resp.status, headers: respHeaders }));
      }

      // Binary pass-through
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > MAX_SIZE) {
        return handleCors(request, jsonResponse({ error: 'Response too large' }, 413));
      }
      return handleCors(request, new Response(buf, { status: resp.status, headers: respHeaders }));

    } catch (err) {
      return handleCors(request, jsonResponse({ error: `Proxy error: ${err.message}` }, 502));
    }
  },
};


// ═══════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function handleCors(request, response) {
  const origin = request.headers.get('Origin') || '*';
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, headers });
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
// HTML rewriting
// ═══════════════════════════════════════════

function rewriteHtml(html, base, PROXY) {
  // 1. Extract <base href>
  html = html.replace(/<base\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*\/?>/gi, (_, href) => {
    try { base = new URL(href, base.href); } catch {}
    return '';
  });

  // 1b. Inject <base href> pointing to the ORIGINAL site
  const baseTag = `<base href="${escapeHtml(base.href)}">`;
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, '$1' + baseTag);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/(<html[^>]*>)/i, '$1<head>' + baseTag + '</head>');
  } else {
    html = baseTag + html;
  }

  // 2. Rewrite attributes (double-quoted)
  html = html.replace(
    /(\b(?:src|href|srcset|poster|data|content|action|background|formaction)\s*=\s*")([^"]*?)(")/gi,
    (m, pre, val, post, offset) => rewriteAttr(m, pre, val, post, html, offset, base, PROXY)
  );

  // Single-quoted
  html = html.replace(
    /(\b(?:src|href|srcset|poster|data|content|action|background|formaction)\s*=\s*')([^]*?)(')/gi,
    (m, pre, val, post, offset) => rewriteAttr(m, pre, val, post, html, offset, base, PROXY)
  );

  // Unquoted attributes
  html = html.replace(
    /(\b(?:src|href|action|background|formaction)\s*=\s*)([^\s>"']+)/gi,
    (m, pre, val) => {
      if (!val || val.startsWith('data:') || val.startsWith('#') || val.includes('?url=') || val.startsWith('"') || val.startsWith("'")) return m;
      const p = px(val, base, PROXY);
      return p ? pre + '"' + p + '"' : m;
    }
  );

  // 3. Inline styles
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

  // 5. <a> tags for postMessage navigation
  html = html.replace(
    /(<a\s[^>]*?)href\s*=\s*"([^"]*\/api\/proxy\?url=([^"]*))"/gi,
    (m, pre, proxyHref, encoded) => {
      const original = decodeURIComponent(encoded);
      return `${pre}href="#" data-proxy-href="${escapeHtml(original)}" onclick="window.parent.postMessage({type:'navigate',url:this.dataset.proxyHref},'*');return false;"`;
    }
  );
  // Also match worker URLs for Cloudflare
  html = html.replace(
    /(<a\s[^>]*?)href\s*=\s*"([^"]*\?url=([^"]*))"/gi,
    (m, pre, proxyHref, encoded) => {
      if (!proxyHref.includes('?url=')) return m;
      if (pre.includes('data-proxy-href')) return m; // already handled
      const original = decodeURIComponent(encoded);
      return `${pre}href="#" data-proxy-href="${escapeHtml(original)}" onclick="window.parent.postMessage({type:'navigate',url:this.dataset.proxyHref},'*');return false;"`;
    }
  );

  // 6. Inject intercept script
  const script = `
<script>
(function(){
  var BASE = ${JSON.stringify(base.href)};
  var PROXY = ${JSON.stringify(PROXY)};

  function shouldProxy(u) {
    return u && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('javascript:') && u !== '#' && u.indexOf('/api/proxy') === -1 && u.indexOf('?url=') === -1;
  }

  function toProxy(u) {
    if (!shouldProxy(u)) return u;
    try {
      var abs = /^https?:\\/\\//.test(u) ? u : new URL(u, BASE).href;
      return PROXY + '?url=' + encodeURIComponent(abs);
    } catch(e) { return u; }
  }

  // Intercept fetch()
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      input = toProxy(input);
    } else if (input instanceof Request && shouldProxy(input.url)) {
      input = new Request(toProxy(input.url), input);
    }
    return _fetch.call(this, input, init);
  };

  // Intercept XMLHttpRequest
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string') url = toProxy(url);
    return _xhrOpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments, 2)));
  };

  // Intercept window.open()
  var _wopen = window.open;
  window.open = function(url) {
    if (url && shouldProxy(url)) {
      try { url = /^https?:\\/\\//.test(url) ? url : new URL(url, BASE).href; } catch(e) {}
      window.parent.postMessage({ type: 'navigate', url: url }, '*');
      return null;
    }
    return _wopen.apply(this, arguments);
  };

  // Intercept Element.src sets (catches relative URLs too)
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

  // Intercept HTMLLinkElement.href (stylesheets, preloads)
  var linkDesc = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href');
  if (linkDesc && linkDesc.set) {
    Object.defineProperty(HTMLLinkElement.prototype, 'href', {
      set: function(v) { if (typeof v === 'string') v = toProxy(v); linkDesc.set.call(this, v); },
      get: linkDesc.get,
      configurable: true
    });
  }

  // Intercept setAttribute for all dynamic attribute sets
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

  // MutationObserver: catch dynamically added elements
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

  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, script + '</body>');
  } else if (/<\/html>/i.test(html)) {
    html = html.replace(/<\/html>/i, script + '</html>');
  } else {
    html += script;
  }

  return html;
}


function rewriteAttr(match, pre, val, post, html, offset, base, PROXY) {
  if (!val || val.startsWith('data:') || val.startsWith('blob:') || val.startsWith('javascript:') || val.startsWith('#')) {
    return match;
  }
  if (val.includes('?url=')) return match;

  const attrMatch = pre.match(/(\w+)\s*=\s*["']?$/);
  if (!attrMatch) return match;
  const attr = attrMatch[1].toLowerCase();

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

  if (attr === 'content') {
    const refreshMatch = val.match(/^(\d+;\s*url\s*=\s*)(.+)$/i);
    if (refreshMatch) {
      const p = px(refreshMatch[2], base, PROXY);
      return p ? pre + refreshMatch[1] + p + post : match;
    }
    return match;
  }

  const p = px(val, base, PROXY);
  return p ? pre + p + post : match;
}


// ═══════════════════════════════════════════
// CSS rewriting
// ═══════════════════════════════════════════

function rewriteCss(css, base, PROXY) {
  css = css.replace(/@import\s+url\(\s*["']?([^"')]+?)["']?\s*\)/gi, (m, url) => {
    const p = px(url, base, PROXY);
    return p ? `@import url("${p}")` : m;
  });
  css = css.replace(/@import\s+["']([^"']+)["']/gi, (m, url) => {
    const p = px(url, base, PROXY);
    return p ? `@import "${p}"` : m;
  });
  css = rewriteCssUrls(css, base, PROXY);
  return css;
}

function rewriteCssUrls(css, base, PROXY) {
  return css.replace(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi, (m, url) => {
    if (/^data:/i.test(url) || url.includes('?url=')) return m;
    const p = px(url.trim(), base, PROXY);
    return p ? `url("${p}")` : m;
  });
}


// ═══════════════════════════════════════════
// JavaScript URL rewriting
// ═══════════════════════════════════════════

function rewriteJsUrls(js, base, PROXY) {
  js = js.replace(/(["'])(https?:\/\/[^"']+)\1/g, (m, q, url) => {
    if (url.includes('?url=') || url.includes('/proxy-worker')) return m;
    return q + PROXY + '?url=' + encodeURIComponent(url) + q;
  });
  return js;
}


function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
