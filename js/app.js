/**
 * WebGate v1.2.2 — Virtual Browser
 *
 * KEY ARCHITECTURE: The iframe loads directly from /api/proxy?url=...
 * NOT from blob URLs. This means the browser naturally resolves all
 * sub-resources (CSS, JS, images, fonts) through the proxy server,
 * since they're rewritten to /api/proxy?url=... paths server-side.
 */
(function () {
  'use strict';

  const VERSION = '1.2.2';
  const STORAGE_KEY = 'webgate_settings';
  const defaults = { workerUrl: '' };

  let settings = loadSettings();
  let navHistory = [];
  let historyIndex = -1;
  let currentUrl = '';

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
    document.querySelectorAll('.version-badge').forEach(el => el.textContent = `v${VERSION}`);
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
    welcomeScreen.classList.remove('hidden');
    contentFrame.classList.add('hidden');
    errorScreen.classList.add('hidden');
    loadingBar.classList.add('hidden');
  }

  function showHome() {
    welcomeScreen.classList.remove('hidden');
    contentFrame.classList.add('hidden');
    errorScreen.classList.add('hidden');
    loadingBar.classList.add('hidden');
    urlInput.value = '';
    currentUrl = '';
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

  function showLoading() { loadingBar.classList.remove('hidden'); }
  function hideLoading() { loadingBar.classList.add('hidden'); }

  // ───── URL ─────
  function normalizeUrl(input) {
    input = input.trim();
    if (!input) return '';
    if (/^[\w-]+(\.[\w-]+)+/.test(input) && !input.includes(' ')) {
      if (!/^https?:\/\//i.test(input)) input = 'https://' + input;
      return input;
    }
    if (/^https?:\/\//i.test(input)) return input;
    return 'https://www.google.com/search?q=' + encodeURIComponent(input);
  }

  function buildProxyUrl(targetUrl) {
    const base = settings.workerUrl.replace(/\/+$/, '');
    return `${base}?url=${encodeURIComponent(targetUrl)}`;
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

  // ───── Navigation ─────
  async function navigate(rawInput) {
    rawInput = stripProxyPrefix(rawInput);
    const url = normalizeUrl(rawInput);
    if (!url) return;

    currentUrl = url;
    try { urlInput.value = decodeURI(url); } catch { urlInput.value = url; }

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
    errorRetry.addEventListener('click', () => { if (currentUrl) loadPage(currentUrl); });

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
      saveSettings();
      closeSettings();
      if (!settings.workerUrl) showSetup();
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
    settingsModal.classList.remove('hidden');
  }

  function closeSettings() { settingsModal.classList.add('hidden'); }

  init();
})();
