/**
 * WebGate — Client-side proxy browser
 * The server (api/proxy.js) handles all URL rewriting.
 * This client just manages navigation, history, and the UI.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'webgate_settings';
  const defaults = {
    workerUrl: '',
    stripScripts: false,
  };

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

  // ───── Navigation ─────
  async function navigate(rawInput) {
    const url = normalizeUrl(rawInput);
    if (!url) return;

    currentUrl = url;
    urlInput.value = url;

    if (historyIndex < navHistory.length - 1) {
      navHistory = navHistory.slice(0, historyIndex + 1);
    }
    navHistory.push(url);
    historyIndex = navHistory.length - 1;
    updateNavButtons();

    await loadPage(url);
  }

  async function loadPage(url) {
    showLoading();
    showContent();

    try {
      const base = settings.workerUrl.replace(/\/+$/, '');
      const proxyUrl = `${base}?url=${encodeURIComponent(url)}`;
      const response = await fetch(proxyUrl);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let errMsg = `Proxy returned ${response.status}: ${response.statusText}`;
        try {
          const json = JSON.parse(text);
          if (json.error) errMsg = json.error;
        } catch {}
        throw new Error(errMsg);
      }

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('text/html') || contentType.includes('text/plain')) {
        let html = await response.text();

        if (settings.stripScripts) {
          html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
        }

        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        proxyFrame.src = blobUrl;
        proxyFrame.addEventListener('load', () => URL.revokeObjectURL(blobUrl), { once: true });
      } else {
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        proxyFrame.src = blobUrl;
        proxyFrame.addEventListener('load', () => URL.revokeObjectURL(blobUrl), { once: true });
      }

      hideLoading();
    } catch (err) {
      hideLoading();
      showError(err.message || 'Failed to load page.');
    }
  }

  function goBack() {
    if (historyIndex > 0) {
      historyIndex--;
      currentUrl = navHistory[historyIndex];
      urlInput.value = currentUrl;
      loadPage(currentUrl);
      updateNavButtons();
    }
  }

  function goForward() {
    if (historyIndex < navHistory.length - 1) {
      historyIndex++;
      currentUrl = navHistory[historyIndex];
      urlInput.value = currentUrl;
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
    $('#save-worker-btn').addEventListener('click', () => {
      const url = $('#worker-url-input').value.trim();
      if (!url) return;
      settings.workerUrl = url;
      saveSettings();
      showBrowser();
    });

    urlForm.addEventListener('submit', (e) => { e.preventDefault(); navigate(urlInput.value); });

    welcomeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      navigate(welcomeInput.value);
      welcomeInput.value = '';
    });

    document.querySelectorAll('.quick-link').forEach((link) => {
      link.addEventListener('click', (e) => { e.preventDefault(); navigate(link.dataset.url); });
    });

    btnBack.addEventListener('click', goBack);
    btnForward.addEventListener('click', goForward);
    btnReload.addEventListener('click', () => { if (currentUrl) loadPage(currentUrl); });
    errorRetry.addEventListener('click', () => { if (currentUrl) loadPage(currentUrl); });

    btnSettings.addEventListener('click', openSettings);
    $('#settings-cancel').addEventListener('click', closeSettings);
    $('.modal-backdrop').addEventListener('click', closeSettings);
    $('#settings-save').addEventListener('click', () => {
      settings.workerUrl = $('#settings-worker-url').value.trim();
      settings.stripScripts = $('#settings-strip-scripts').checked;
      saveSettings();
      closeSettings();
      if (!settings.workerUrl) showSetup();
    });

    // Listen for navigation from proxied pages
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
    $('#settings-strip-scripts').checked = settings.stripScripts;
    settingsModal.classList.remove('hidden');
  }

  function closeSettings() { settingsModal.classList.add('hidden'); }

  init();
})();
