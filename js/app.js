/**
 * WebGate v1.3.4 — Virtual Browser
 *
 * KEY ARCHITECTURE: The iframe loads directly from /api/proxy?url=...
 * NOT from blob URLs. This means the browser naturally resolves all
 * sub-resources (CSS, JS, images, fonts) through the proxy server,
 * since they're rewritten to /api/proxy?url=... paths server-side.
 */
(function () {
  'use strict';

  const VERSION = '1.3.4';
  const STORAGE_KEY = 'webgate_settings';
  const defaults = { workerUrl: '', cfWorkerUrl: '', useCf: false };
  const HISTORY_KEY = 'webgate_history';

  let settings = loadSettings();
  let navHistory = [];
  let historyIndex = -1;
  let currentUrl = '';
  let browsingHistory = loadHistory();

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
  const btnHome       = $('#btn-home');
  const btnBack       = $('#btn-back');
  const btnForward    = $('#btn-forward');
  const btnReload     = $('#btn-reload');
  const btnStop       = $('#btn-stop');
  const btnSettings   = $('#btn-settings');
  const settingsModal = $('#settings-modal');
  const errorMessage  = $('#error-message');
  const errorRetry    = $('#error-retry');

  // ───── Init ─────
  function init() {
    if (!settings.workerUrl) {
      const sameOriginProxy = window.location.origin + '/api/proxy';
      fetch(sameOriginProxy)
        .then(res => {
          if (res.ok) {
            settings.workerUrl = sameOriginProxy;
            saveSettings();
            showBrowser();
          } else {
            showSetup();
          }
        })
        .catch(() => showSetup());
    } else {
      showBrowser();
    }
    bindEvents();
    // Populate version strings in DOM
    document.title = `WebGate v${VERSION} — Virtual Browser`;
    document.querySelectorAll('.version').forEach(el => el.textContent = `WebGate v${VERSION}`);
    document.querySelectorAll('.version-info').forEach(el => el.textContent = `WebGate v${VERSION}`);
  }

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

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    } catch { return []; }
  }

  function saveHistory() {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(browsingHistory.slice(0, 200)));
  }

  function addToHistory(url) {
    browsingHistory.unshift({ url, time: Date.now() });
    if (browsingHistory.length > 200) browsingHistory.length = 200;
    saveHistory();
  }

  function clearHistory() {
    browsingHistory = [];
    saveHistory();
    renderHistoryPanel();
  }

  // ───── Views ─────
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
    errorScreen.classList.add('hidden');
    loadingBar.classList.add('hidden');

    // Restore URL from hash on load/refresh
    const hashUrl = decodeHashUrl();
    if (hashUrl) {
      welcomeScreen.classList.add('hidden');
      contentFrame.classList.add('hidden');
      navigate(hashUrl);
    } else {
      welcomeScreen.classList.remove('hidden');
      contentFrame.classList.add('hidden');
    }
  }

  function showHome() {
    welcomeScreen.classList.remove('hidden');
    contentFrame.classList.add('hidden');
    errorScreen.classList.add('hidden');
    loadingBar.classList.add('hidden');
    urlInput.value = '';
    currentUrl = '';
    // Clear hash so refresh shows home
    if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
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
    btnReload.classList.add('hidden');
    btnStop.classList.remove('hidden');
  }
  function hideLoading() {
    loadingBar.classList.add('hidden');
    btnStop.classList.add('hidden');
    btnReload.classList.remove('hidden');
  }

  // ───── URL ─────
  function normalizeUrl(input) {
    input = input.trim();
    if (!input) return '';
    if (/^[\w-]+(\.[\w-]+)+/.test(input) && !input.includes(' ')) {
      if (!/^https?:\/\//i.test(input)) input = 'https://' + input;
      return input;
    }
    if (/^https?:\/\//i.test(input)) return input;
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(input);
  }

  function buildProxyUrl(targetUrl) {
    const proxyBase = (settings.useCf && settings.cfWorkerUrl)
      ? settings.cfWorkerUrl.replace(/\/+$/, '')
      : settings.workerUrl.replace(/\/+$/, '');
    return `${proxyBase}?url=${encodeURIComponent(targetUrl)}`;
  }

  // Strip proxy prefix from URL to get the clean original URL
  function stripProxyPrefix(url) {
    if (!url) return url;
    // Match patterns like: https://proxy.vercel.app/api/proxy?url=ENCODED_URL
    // or any ?url= pattern from Cloudflare workers
    const match = url.match(/[?&]url=([^&]+)/);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch { return url; }
    }
    return url;
  }

  // ───── Hash persistence ─────
  function setHashUrl(url) {
    history.replaceState(null, '', '#' + encodeURIComponent(url));
  }

  function decodeHashUrl() {
    const hash = window.location.hash.slice(1);
    if (!hash) return null;
    try { return decodeURIComponent(hash); } catch { return null; }
  }

  // ───── Navigation ─────
  async function navigate(rawInput) {
    rawInput = stripProxyPrefix(rawInput);
    const url = normalizeUrl(rawInput);
    if (!url) return;

    currentUrl = url;
    try { urlInput.value = decodeURI(url); } catch { urlInput.value = url; }
    setHashUrl(url);
    addToHistory(url);

    if (historyIndex < navHistory.length - 1) {
      navHistory = navHistory.slice(0, historyIndex + 1);
    }
    navHistory.push(url);
    historyIndex = navHistory.length - 1;
    updateNavButtons();

    loadPage(url);
  }

  function loadPage(url) {
    showLoading();
    showContent();

    // Load the page directly through the proxy in the iframe.
    // The server rewrites all URLs to go through /api/proxy,
    // so the browser fetches CSS/JS/images through the proxy automatically.
    const proxyUrl = buildProxyUrl(url);
    proxyFrame.src = proxyUrl;
  }

  function goBack() {
    if (historyIndex > 0) {
      historyIndex--;
      currentUrl = navHistory[historyIndex];
      try { urlInput.value = decodeURI(currentUrl); } catch { urlInput.value = currentUrl; }
      loadPage(currentUrl);
      updateNavButtons();
    }
  }

  function goForward() {
    if (historyIndex < navHistory.length - 1) {
      historyIndex++;
      currentUrl = navHistory[historyIndex];
      try { urlInput.value = decodeURI(currentUrl); } catch { urlInput.value = currentUrl; }
      loadPage(currentUrl);
      updateNavButtons();
    }
  }

  function updateNavButtons() {
    btnBack.disabled = historyIndex <= 0;
    btnForward.disabled = historyIndex >= navHistory.length - 1;
  }

  // ───── Events ─────
  function bindEvents() {
    // Setup
    $('#save-worker-btn').addEventListener('click', () => {
      const url = $('#worker-url-input').value.trim();
      if (!url) return;
      settings.workerUrl = url;
      saveSettings();
      showBrowser();
    });

    // URL bar
    urlForm.addEventListener('submit', (e) => { e.preventDefault(); navigate(urlInput.value); });

    // Welcome search
    welcomeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      navigate(welcomeInput.value);
      welcomeInput.value = '';
    });

    // Quick links
    document.querySelectorAll('.quick-link').forEach((link) => {
      link.addEventListener('click', (e) => { e.preventDefault(); navigate(link.dataset.url); });
    });

    // Nav buttons
    btnHome.addEventListener('click', showHome);
    btnBack.addEventListener('click', goBack);
    btnForward.addEventListener('click', goForward);
    btnReload.addEventListener('click', () => { if (currentUrl) loadPage(currentUrl); });
    btnStop.addEventListener('click', () => {
      try { proxyFrame.contentWindow.stop(); } catch(e) {}
      hideLoading();
    });
    errorRetry.addEventListener('click', () => { if (currentUrl) loadPage(currentUrl); });

    // Copy URL
    $('#btn-copy-url').addEventListener('click', () => {
      const url = currentUrl || urlInput.value;
      if (!url) return;
      navigator.clipboard.writeText(url).then(() => {
        const btn = $('#btn-copy-url');
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1500);
      });
    });

    // Iframe load/error events
    proxyFrame.addEventListener('load', () => {
      hideLoading();
    });

    proxyFrame.addEventListener('error', () => {
      hideLoading();
      showError('Failed to load page.');
    });

    // Listen for navigation messages from proxied pages (injected by server)
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'navigate' && e.data.url) {
        navigate(e.data.url);
      }
    });

    // Settings
    btnSettings.addEventListener('click', openSettings);
    $('#settings-cancel').addEventListener('click', closeSettings);
    $('.modal-backdrop').addEventListener('click', closeSettings);
    $('#settings-save').addEventListener('click', () => {
      settings.workerUrl = $('#settings-worker-url').value.trim();
      settings.cfWorkerUrl = $('#settings-cf-worker-url').value.trim();
      settings.useCf = $('#settings-use-cf').checked;
      saveSettings();
      closeSettings();
      if (!settings.workerUrl && !settings.cfWorkerUrl) showSetup();
    });

    // History
    $('#btn-history').addEventListener('click', toggleHistory);
    $('#history-clear').addEventListener('click', clearHistory);
    document.addEventListener('click', (e) => {
      // Delete single history entry
      const delBtn = e.target.closest('.history-delete');
      if (delBtn) {
        e.stopPropagation();
        const idx = parseInt(delBtn.dataset.delidx);
        if (!isNaN(idx) && idx >= 0 && idx < browsingHistory.length) {
          browsingHistory.splice(idx, 1);
          saveHistory();
          renderHistoryPanel();
        }
        return;
      }
      const item = e.target.closest('.history-item');
      if (item) {
        const idx = parseInt(item.dataset.idx);
        if (browsingHistory[idx]) {
          navigate(browsingHistory[idx].url);
          $('#history-panel').classList.add('hidden');
        }
      }
      // Close history panel when clicking outside
      if (!e.target.closest('#history-panel') && !e.target.closest('#btn-history')) {
        const panel = $('#history-panel');
        if (panel && !panel.classList.contains('hidden')) {
          panel.classList.add('hidden');
        }
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
    $('#settings-cf-worker-url').value = settings.cfWorkerUrl || '';
    $('#settings-use-cf').checked = settings.useCf || false;
    settingsModal.classList.remove('hidden');
  }

  function closeSettings() { settingsModal.classList.add('hidden'); }

  // ───── History Panel ─────
  function toggleHistory() {
    const panel = $('#history-panel');
    if (panel.classList.contains('hidden')) {
      renderHistoryPanel();
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  }

  function renderHistoryPanel() {
    const list = $('#history-list');
    if (!list) return;
    if (browsingHistory.length === 0) {
      list.innerHTML = '<li class="history-empty">No browsing history</li>';
      return;
    }
    list.innerHTML = browsingHistory.map((entry, i) => {
      let displayUrl;
      try { displayUrl = decodeURI(entry.url); } catch { displayUrl = entry.url; }
      const time = new Date(entry.time);
      const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = time.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return `<li class="history-item" data-idx="${i}">
        <span class="history-url" title="${displayUrl}">${displayUrl}</span>
        <span class="history-time">${dateStr} ${timeStr}</span>
        <button class="history-delete" data-delidx="${i}" title="Remove">&times;</button>
      </li>`;
    }).join('');
  }

  init();
})();
