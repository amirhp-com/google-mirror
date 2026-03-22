/**
 * WebGate — Client-side proxy browser
 * Communicates with a Cloudflare Worker to fetch and display blocked pages.
 */
(function () {
  'use strict';

  // ───── State ─────
  const STORAGE_KEY = 'webgate_settings';
  const defaults = {
    workerUrl: '',
    rewriteLinks: true,
    stripScripts: false,
  };

  let settings = loadSettings();
  let history = [];
  let historyIndex = -1;
  let currentUrl = '';

  // ───── DOM Refs ─────
  const $ = (s) => document.querySelector(s);
  const setupPanel    = $('#setup-panel');
  const toolbar       = $('#toolbar');
  const loadingBar    = $('#loading-bar');
  const welcomeScreen = $('#welcome-screen');
  const contentFrame  = $('#content-frame');
  const errorScreen   = $('#error-screen');
  const proxyFrame    = $('#proxy-frame');
  const urlInput      = $('#url-input');
  const welcomeInput  = $('#welcome-input');
  const urlForm       = $('#url-form');
  const welcomeForm   = $('#welcome-search-form');
  const btnBack       = $('#btn-back');
  const btnForward    = $('#btn-forward');
  const btnReload     = $('#btn-reload');
  const btnSettings   = $('#btn-settings');
  const settingsModal = $('#settings-modal');
  const errorMessage  = $('#error-message');
  const errorRetry    = $('#error-retry');

  // ───── Init ─────
  function init() {
    if (!settings.workerUrl) {
      showSetup();
    } else {
      showBrowser();
    }
    bindEvents();
  }

  // ───── Settings Persistence ─────
  function loadSettings() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? { ...defaults, ...JSON.parse(saved) } : { ...defaults };
    } catch {
      return { ...defaults };
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  // ───── View Management ─────
  function showSetup() {
    setupPanel.classList.remove('hidden');
    toolbar.classList.add('hidden');
    loadingBar.classList.add('hidden');
    welcomeScreen.classList.add('hidden');
    contentFrame.classList.add('hidden');
    errorScreen.classList.add('hidden');
  }

  function showBrowser() {
    setupPanel.classList.add('hidden');
    toolbar.classList.remove('hidden');
    welcomeScreen.classList.remove('hidden');
    contentFrame.classList.add('hidden');
    errorScreen.classList.add('hidden');
    loadingBar.classList.add('hidden');
  }

  function showContent() {
    welcomeScreen.classList.add('hidden');
    errorScreen.classList.add('hidden');
    contentFrame.classList.remove('hidden');
  }

  function showError(msg) {
    welcomeScreen.classList.add('hidden');
    contentFrame.classList.add('hidden');
    loadingBar.classList.add('hidden');
    errorScreen.classList.remove('hidden');
    errorMessage.textContent = msg;
  }

  function showLoading() {
    loadingBar.classList.remove('hidden');
  }

  function hideLoading() {
    loadingBar.classList.add('hidden');
  }

  // ───── URL Helpers ─────
  function normalizeUrl(input) {
    input = input.trim();
    if (!input) return '';

    // If it looks like a URL (has dot and no spaces), add protocol
    if (/^[\w-]+(\.[\w-]+)+/.test(input) && !input.includes(' ')) {
      if (!/^https?:\/\//i.test(input)) {
        input = 'https://' + input;
      }
      return input;
    }

    // If it already has a protocol
    if (/^https?:\/\//i.test(input)) {
      return input;
    }

    // Otherwise treat as Google search
    return 'https://www.google.com/search?q=' + encodeURIComponent(input);
  }

  // ───── Proxy Fetch ─────
  async function navigate(rawInput) {
    const url = normalizeUrl(rawInput);
    if (!url) return;

    currentUrl = url;
    urlInput.value = url;

    // Push to history
    if (historyIndex < history.length - 1) {
      history = history.slice(0, historyIndex + 1);
    }
    history.push(url);
    historyIndex = history.length - 1;
    updateNavButtons();

    showLoading();
    showContent();

    try {
      const proxyUrl = buildProxyUrl(url);
      const response = await fetch(proxyUrl);

      if (!response.ok) {
        throw new Error(`Proxy returned ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('text/html') || contentType.includes('text/plain')) {
        let html = await response.text();

        if (settings.rewriteLinks) {
          html = rewriteHtml(html, url);
        }

        if (settings.stripScripts) {
          html = stripScriptTags(html);
        }

        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        proxyFrame.src = blobUrl;

        // Clean up old blob URLs
        proxyFrame.addEventListener('load', () => URL.revokeObjectURL(blobUrl), { once: true });
      } else {
        // For non-HTML (images, PDFs, etc.), load directly via proxy
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        proxyFrame.src = blobUrl;
        proxyFrame.addEventListener('load', () => URL.revokeObjectURL(blobUrl), { once: true });
      }

      hideLoading();
    } catch (err) {
      hideLoading();
      showError(err.message || 'Failed to load page. Check your proxy worker URL.');
    }
  }

  function buildProxyUrl(targetUrl) {
    const base = settings.workerUrl.replace(/\/+$/, '');
    return `${base}/?url=${encodeURIComponent(targetUrl)}`;
  }

  // ───── HTML Rewriting ─────
  function rewriteHtml(html, baseUrl) {
    const base = new URL(baseUrl);
    const origin = base.origin;

    // Inject <base> tag so relative URLs resolve correctly
    if (!/<base\s/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${origin}/">`);
    }

    // Rewrite absolute links to go through our proxy
    // Replace href="/path" with onclick handlers
    html = html.replace(
      /(<a\s[^>]*?)href\s*=\s*"((?:https?:\/\/)[^"]+)"/gi,
      (match, prefix, href) => {
        return `${prefix}href="#" data-proxy-href="${escapeAttr(href)}" onclick="window.parent.postMessage({type:'navigate',url:'${escapeAttr(href)}'},'*');return false;"`;
      }
    );

    // Rewrite form actions
    html = html.replace(
      /(<form\s[^>]*?)action\s*=\s*"((?:https?:\/\/)[^"]+)"/gi,
      (match, prefix, action) => {
        return `${prefix}action="${escapeAttr(action)}" data-proxy-action="true"`;
      }
    );

    // Rewrite relative src attributes to absolute
    html = html.replace(
      /(src\s*=\s*")(?!https?:\/\/|data:|blob:|javascript:)(\/?)([^"]*)/gi,
      (match, prefix, slash, path) => {
        const absolute = slash ? `${origin}/${path}` : `${origin}${base.pathname.replace(/[^/]*$/, '')}${path}`;
        return `${prefix}${absolute}`;
      }
    );

    // Rewrite relative href for CSS/links (not anchor tags, those are handled above)
    html = html.replace(
      /(<link\s[^>]*?)href\s*=\s*"(?!https?:\/\/|data:|blob:|#)(\/?)([^"]*)/gi,
      (match, prefix, slash, path) => {
        const absolute = slash ? `${origin}/${path}` : `${origin}${base.pathname.replace(/[^/]*$/, '')}${path}`;
        return `${prefix}href="${absolute}`;
      }
    );

    // Inject a small script to capture link clicks and form submissions
    const interceptScript = `
    <script>
      document.addEventListener('click', function(e) {
        var a = e.target.closest('a[href]');
        if (a) {
          var href = a.getAttribute('data-proxy-href') || a.href;
          if (href && href !== '#' && !href.startsWith('javascript:') && !href.startsWith('blob:')) {
            e.preventDefault();
            window.parent.postMessage({ type: 'navigate', url: href }, '*');
          }
        }
      }, true);
      document.addEventListener('submit', function(e) {
        var form = e.target;
        if (form.tagName === 'FORM') {
          e.preventDefault();
          var action = form.action || window.location.href;
          var data = new FormData(form);
          var params = new URLSearchParams(data).toString();
          var method = (form.method || 'GET').toUpperCase();
          if (method === 'GET') {
            var url = action.split('?')[0] + '?' + params;
            window.parent.postMessage({ type: 'navigate', url: url }, '*');
          } else {
            window.parent.postMessage({ type: 'navigate', url: action, method: 'POST', body: params }, '*');
          }
        }
      }, true);
    </` + `script>`;

    html = html.replace(/<\/body>/i, interceptScript + '</body>');

    return html;
  }

  function stripScriptTags(html) {
    return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  }

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  }

  // ───── Navigation ─────
  function goBack() {
    if (historyIndex > 0) {
      historyIndex--;
      const url = history[historyIndex];
      currentUrl = url;
      urlInput.value = url;
      loadFromHistory(url);
      updateNavButtons();
    }
  }

  function goForward() {
    if (historyIndex < history.length - 1) {
      historyIndex++;
      const url = history[historyIndex];
      currentUrl = url;
      urlInput.value = url;
      loadFromHistory(url);
      updateNavButtons();
    }
  }

  async function loadFromHistory(url) {
    showLoading();
    showContent();
    try {
      const proxyUrl = buildProxyUrl(url);
      const response = await fetch(proxyUrl);
      if (!response.ok) throw new Error(`Proxy returned ${response.status}`);
      let html = await response.text();
      if (settings.rewriteLinks) html = rewriteHtml(html, url);
      if (settings.stripScripts) html = stripScriptTags(html);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      proxyFrame.src = blobUrl;
      proxyFrame.addEventListener('load', () => URL.revokeObjectURL(blobUrl), { once: true });
      hideLoading();
    } catch (err) {
      hideLoading();
      showError(err.message);
    }
  }

  function updateNavButtons() {
    btnBack.disabled = historyIndex <= 0;
    btnForward.disabled = historyIndex >= history.length - 1;
  }

  // ───── Event Binding ─────
  function bindEvents() {
    // Setup panel
    $('#save-worker-btn').addEventListener('click', () => {
      const url = $('#worker-url-input').value.trim();
      if (!url) return;
      settings.workerUrl = url;
      saveSettings();
      showBrowser();
    });

    // URL form submit
    urlForm.addEventListener('submit', (e) => {
      e.preventDefault();
      navigate(urlInput.value);
    });

    // Welcome search form
    welcomeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      navigate(welcomeInput.value);
      welcomeInput.value = '';
    });

    // Quick links
    document.querySelectorAll('.quick-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        navigate(link.dataset.url);
      });
    });

    // Navigation buttons
    btnBack.addEventListener('click', goBack);
    btnForward.addEventListener('click', goForward);
    btnReload.addEventListener('click', () => {
      if (currentUrl) navigate(currentUrl);
    });

    // Error retry
    errorRetry.addEventListener('click', () => {
      if (currentUrl) navigate(currentUrl);
    });

    // Settings modal
    btnSettings.addEventListener('click', openSettings);
    $('#settings-cancel').addEventListener('click', closeSettings);
    $('.modal-backdrop').addEventListener('click', closeSettings);
    $('#settings-save').addEventListener('click', () => {
      settings.workerUrl = $('#settings-worker-url').value.trim();
      settings.rewriteLinks = $('#settings-rewrite-links').checked;
      settings.stripScripts = $('#settings-strip-scripts').checked;
      saveSettings();
      closeSettings();
      if (!settings.workerUrl) showSetup();
    });

    // Listen for navigation messages from proxied iframe
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'navigate' && e.data.url) {
        navigate(e.data.url);
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'ArrowLeft') { goBack(); e.preventDefault(); }
      if (e.altKey && e.key === 'ArrowRight') { goForward(); e.preventDefault(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') { urlInput.focus(); urlInput.select(); e.preventDefault(); }
    });
  }

  function openSettings() {
    $('#settings-worker-url').value = settings.workerUrl;
    $('#settings-rewrite-links').checked = settings.rewriteLinks;
    $('#settings-strip-scripts').checked = settings.stripScripts;
    settingsModal.classList.remove('hidden');
  }

  function closeSettings() {
    settingsModal.classList.add('hidden');
  }

  // ───── Boot ─────
  init();
})();
