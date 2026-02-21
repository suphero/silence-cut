(function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    enabled: true,
    silenceEnabled: true,
    silenceThreshold: -40,
    minSilenceDuration: 0.1,
    musicEnabled: false,
    musicSensitivity: 0.5,
    minMusicDuration: 1.0,
    actionMode: 'speed',
    speedMultiplier: 4
  };

  const msg = (...args) => {
    try { return chrome.i18n.getMessage(...args) || ''; } catch { return ''; }
  };
  let settings = null;
  let isOpen = false;
  let buttonEl = null;
  let panelHost = null;
  let globalEventsRegistered = false;

  let statusData = {
    active: false,
    skippedCount: 0,
    timeSavedMs: 0,
    currentVolumeDB: -Infinity,
    isInSilence: false,
    skipReason: null,
    isMusic: false,
    isAtLiveEdge: false,
    features: null
  };

  // ─── Helpers ──────────────────────────────────────────

  function $(sel) { return panelHost?.querySelector(sel); }
  function $$(sel) { return panelHost?.querySelectorAll(sel); }

  function updateSliderFill(slider) {
    if (!slider) return;
    const pct = ((parseFloat(slider.value) - parseFloat(slider.min)) / (parseFloat(slider.max) - parseFloat(slider.min))) * 100;
    slider.style.setProperty('--yt-slider-shape-gradient-percent', pct + '%');
  }

  function formatTimeSaved(ms) {
    const totalSec = Math.floor(ms / 1000);
    const hr = Math.floor(totalSec / 3600);
    const min = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return pad(hr) + ':' + pad(min) + ':' + pad(sec);
  }

  // ─── Settings ─────────────────────────────────────────

  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get('settings', (data) => {
        settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
        resolve(settings);
      });
    });
  }

  async function saveSettings() {
    settings = readSettingsFromUI();
    await chrome.storage.sync.set({ settings });
    updateButtonState();
  }

  function readSettingsFromUI() {
    if (!panelHost) return settings;
    return {
      enabled: $('#sc-enabled-item')?.getAttribute('aria-checked') === 'true',
      silenceEnabled: $('#sc-sil-toggle')?.getAttribute('aria-checked') === 'true',
      silenceThreshold: parseInt($('#sc-threshold')?.value ?? settings.silenceThreshold),
      minSilenceDuration: parseFloat($('#sc-sil-dur')?.value ?? settings.minSilenceDuration),
      musicEnabled: $('#sc-mus-toggle')?.getAttribute('aria-checked') === 'true',
      musicSensitivity: parseFloat($('#sc-mus-sens')?.value ?? settings.musicSensitivity),
      minMusicDuration: parseFloat($('#sc-mus-dur')?.value ?? settings.minMusicDuration),
      actionMode: settings.actionMode,
      speedMultiplier: parseInt($('#sc-speed')?.value ?? settings.speedMultiplier)
    };
  }

  // ─── Navigation ───────────────────────────────────────

  function showPage(pageId, isBack) {
    if (!panelHost) return;
    $$('.sc-page').forEach((p) => p.classList.remove('active', 'back'));
    const target = $('#sc-page-' + pageId);
    if (target) {
      if (isBack) target.classList.add('back');
      target.classList.add('active');
    }
  }

  // ─── UI Sync ──────────────────────────────────────────

  function applySettingsToUI() {
    if (!panelHost || !settings) return;

    // Enable toggle
    $('#sc-enabled-item')?.setAttribute('aria-checked', settings.enabled ? 'true' : 'false');

    // Main page menu values
    const isSpeed = settings.actionMode === 'speed';
    const modeText = isSpeed ? msg('speedUp') + ' · ' + settings.speedMultiplier + 'x' : msg('skip');
    $('#sc-mode-val').textContent = modeText;
    $('#sc-sil-val').textContent = settings.silenceEnabled ? msg('on') : msg('off');
    $('#sc-mus-val').textContent = settings.musicEnabled ? msg('on') : msg('off');

    // Mode page checkmarks + inline speed
    $$('.sc-mode-opt').forEach((opt) => {
      opt.classList.toggle('selected', opt.dataset.value === settings.actionMode);
    });
    $('#sc-speed-inline').classList.toggle('hidden', !isSpeed);
    $('#sc-speed').value = settings.speedMultiplier;
    $('#sc-speed-big').textContent = settings.speedMultiplier + 'x';

    // Silence page (menu + slider pages)
    $('#sc-sil-toggle')?.setAttribute('aria-checked', settings.silenceEnabled ? 'true' : 'false');
    const thresholdText = settings.silenceThreshold + ' dB';
    $('#sc-threshold').value = settings.silenceThreshold;
    $('#sc-threshold-val').textContent = thresholdText;
    $('#sc-threshold-menu').textContent = thresholdText;
    const silDurText = settings.minSilenceDuration + 's';
    $('#sc-sil-dur').value = settings.minSilenceDuration;
    $('#sc-sil-dur-val').textContent = silDurText;
    $('#sc-sil-dur-menu').textContent = silDurText;

    // Music page (menu + slider pages)
    $('#sc-mus-toggle')?.setAttribute('aria-checked', settings.musicEnabled ? 'true' : 'false');
    const sensText = '%' + Math.round(settings.musicSensitivity * 100);
    $('#sc-mus-sens').value = settings.musicSensitivity;
    $('#sc-mus-sens-val').textContent = sensText;
    $('#sc-mus-sens-menu').textContent = sensText;
    const musDurText = settings.minMusicDuration + 's';
    $('#sc-mus-dur').value = settings.minMusicDuration;
    $('#sc-mus-dur-val').textContent = musDurText;
    $('#sc-mus-dur-menu').textContent = musDurText;

    // Update all slider fills
    ['#sc-speed', '#sc-threshold', '#sc-sil-dur', '#sc-mus-sens', '#sc-mus-dur'].forEach((id) => updateSliderFill($(id)));

    updateThresholdLine();
    updateButtonState();
  }

  function updateThresholdLine() {
    if (!panelHost) return;
    const val = parseInt($('#sc-threshold')?.value ?? -40);
    const pct = ((val + 60) / 50) * 100;
    const line = $('#sc-thr-line');
    if (line) line.style.left = pct + '%';
  }

  function updateStatus() {
    if (!panelHost || !isOpen) return;

    const isLive = statusData.active && statusData.isAtLiveEdge;
    const dot = $('#sc-dot');
    if (dot) dot.className = 'sc-dot' + (statusData.active ? (isLive ? ' live' : ' active') : '');

    const el = $('#sc-status-text');
    if (el) el.textContent = isLive ? msg('liveEdge') : (statusData.active ? msg('active') : msg('inactive'));

    const skipEl = $('#sc-skip-count');
    if (skipEl) skipEl.textContent = msg('skipCount', [String(statusData.skippedCount || 0)]);

    const tsEl = $('#sc-time-saved');
    if (tsEl) tsEl.textContent = formatTimeSaved(statusData.timeSavedMs || 0);

    const db = statusData.currentVolumeDB;
    const volBar = $('#sc-vol-bar');
    const volDb = $('#sc-vol-db');
    if (volBar && volDb) {
      if (db != null && db !== -Infinity) {
        const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
        volBar.style.width = pct + '%';
        volDb.textContent = db.toFixed(1) + ' dB';
      } else {
        volBar.style.width = '0%';
        volDb.textContent = '-- dB';
      }
    }

    const tagSil = $('#sc-tag-sil');
    const tagMus = $('#sc-tag-mus');
    const tagSpeech = $('#sc-tag-speech');
    if (tagSil) tagSil.classList.toggle('hidden', !statusData.isInSilence || statusData.skipReason !== 'silence');
    if (tagMus) tagMus.classList.toggle('hidden', !statusData.isMusic);
    // Show speech tag when audio is active, not silence, and not music
    const isSpeech = statusData.active && !statusData.isInSilence && !statusData.isMusic &&
      statusData.currentVolumeDB > -Infinity && statusData.currentVolumeDB > (settings?.silenceThreshold ?? -40);
    if (tagSpeech) tagSpeech.classList.toggle('hidden', !isSpeech);

    // Debug features panel (on music page, inside collapsible)
    const f = statusData.features;
    if (f) {
      const s = (id, val) => { const el = $('#' + id); if (el) el.textContent = val; };
      s('sc-dbg-zcr', f.zcr?.toFixed(4) ?? '--');
      s('sc-dbg-zcrvar', f.zcrVariance?.toFixed(6) ?? '--');
      s('sc-dbg-flat', f.spectralFlatness?.toFixed(4) ?? '--');
      s('sc-dbg-speech', f.speechBandRatio?.toFixed(4) ?? '--');
      s('sc-dbg-centroid', f.spectralCentroid ? Math.round(f.spectralCentroid) + ' Hz' : '--');
      s('sc-dbg-spread', f.spectralSpread ? Math.round(f.spectralSpread) + ' Hz' : '--');
      s('sc-dbg-rolloff', f.spectralRolloff ? Math.round(f.spectralRolloff) + ' Hz' : '--');
      s('sc-dbg-flux', f.spectralFlux?.toFixed(2) ?? '--');
    }
  }

  function updateButtonState() {
    if (!buttonEl) return;
    buttonEl.setAttribute('aria-pressed', settings?.enabled ? 'true' : 'false');
    const svg = buttonEl.querySelector('svg path');
    if (svg) svg.setAttribute('fill-opacity', settings?.enabled ? '1' : '0.5');
  }

  // ─── Panel Events ────────────────────────────────────

  function bindPanelEvents() {
    if (!panelHost) return;

    // Stop YouTube keyboard shortcuts
    panelHost.querySelector('.sc-panel').addEventListener('keydown', (e) => e.stopPropagation());

    // Enable toggle
    $('#sc-enabled-item').addEventListener('click', () => {
      const item = $('#sc-enabled-item');
      const checked = item.getAttribute('aria-checked') !== 'true';
      item.setAttribute('aria-checked', checked ? 'true' : 'false');
      saveSettings();
    });

    // Menu items → navigate to sub-pages
    $$('.ytp-menuitem[data-page]').forEach((item) => {
      item.addEventListener('click', () => showPage(item.dataset.page, false));
    });

    // Back buttons (multi-level: use data-back on page, fallback to main)
    $$('.sc-back').forEach((btn) => {
      btn.addEventListener('click', () => {
        const page = btn.closest('.sc-page');
        const backTarget = page?.dataset.back || 'main';
        applySettingsToUI();
        showPage(backTarget, true);
      });
    });

    // Mode page options
    $$('.sc-mode-opt').forEach((opt) => {
      opt.addEventListener('click', () => {
        settings.actionMode = opt.dataset.value;
        saveSettings();
        applySettingsToUI();
      });
    });

    // Speed slider (inline in mode page)
    $('#sc-speed').addEventListener('input', () => {
      $('#sc-speed-big').textContent = $('#sc-speed').value + 'x';
      updateSliderFill($('#sc-speed'));
      saveSettings();
      $('#sc-mode-val').textContent = msg('speedUp') + ' · ' + $('#sc-speed').value + 'x';
    });

    // Silence page
    $('#sc-sil-toggle').addEventListener('click', () => {
      const el = $('#sc-sil-toggle');
      const checked = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', checked ? 'true' : 'false');
      saveSettings();
      applySettingsToUI();
    });

    $('#sc-threshold').addEventListener('input', () => {
      const text = $('#sc-threshold').value + ' dB';
      $('#sc-threshold-val').textContent = text;
      $('#sc-threshold-menu').textContent = text;
      updateSliderFill($('#sc-threshold'));
      updateThresholdLine();
      saveSettings();
    });

    $('#sc-sil-dur').addEventListener('input', () => {
      const text = parseFloat($('#sc-sil-dur').value).toFixed(1) + 's';
      $('#sc-sil-dur-val').textContent = text;
      $('#sc-sil-dur-menu').textContent = text;
      updateSliderFill($('#sc-sil-dur'));
      saveSettings();
    });

    // Music page
    $('#sc-mus-toggle').addEventListener('click', () => {
      const el = $('#sc-mus-toggle');
      const checked = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', checked ? 'true' : 'false');
      saveSettings();
      applySettingsToUI();
    });

    $('#sc-mus-sens').addEventListener('input', () => {
      const text = '%' + Math.round(parseFloat($('#sc-mus-sens').value) * 100);
      $('#sc-mus-sens-val').textContent = text;
      $('#sc-mus-sens-menu').textContent = text;
      updateSliderFill($('#sc-mus-sens'));
      saveSettings();
    });

    $('#sc-mus-dur').addEventListener('input', () => {
      const text = parseFloat($('#sc-mus-dur').value).toFixed(1) + 's';
      $('#sc-mus-dur-val').textContent = text;
      $('#sc-mus-dur-menu').textContent = text;
      updateSliderFill($('#sc-mus-dur'));
      saveSettings();
    });

    // Generic +/- increment buttons
    $$('.ytp-variable-speed-panel-increment-button[data-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const slider = $('#' + btn.dataset.target);
        if (!slider) return;
        const step = parseFloat(btn.dataset.step);
        const val = Math.round((parseFloat(slider.value) + step) * 1000) / 1000;
        slider.value = Math.min(parseFloat(slider.max), Math.max(parseFloat(slider.min), val));
        slider.dispatchEvent(new Event('input'));
      });
    });

    // Generic preset buttons
    $$('.ytp-variable-speed-panel-preset-button[data-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const slider = $('#' + btn.dataset.target);
        if (!slider) return;
        slider.value = btn.dataset.value;
        slider.dispatchEvent(new Event('input'));
      });
    });

    // Collapsible sections
    $$('.sc-collapsible-header').forEach((header) => {
      header.addEventListener('click', () => {
        header.classList.toggle('open');
        const body = header.nextElementSibling;
        if (body) body.classList.toggle('hidden');
      });
    });
  }

  // ─── Button ───────────────────────────────────────────

  function createButton() {
    const btn = document.createElement('button');
    btn.className = 'ytp-button silence-cut-btn';
    btn.title = '';
    btn.setAttribute('aria-label', 'Silence Cut');
    btn.setAttribute('data-tooltip-target-id', 'silence-cut-btn');
    btn.setAttribute('data-title-no-tooltip', 'Silence Cut');
    btn.setAttribute('data-tooltip-title', 'Silence Cut');
    btn.innerHTML = `
      <svg fill="none" height="24" viewBox="0 0 24 24" width="24">
        <path d="M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z" fill="white" fill-opacity="1"></path>
      </svg>`;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });
    return btn;
  }

  // ─── Panel ────────────────────────────────────────────

  function togglePanel() {
    isOpen = !isOpen;
    if (panelHost) {
      panelHost.style.display = isOpen ? '' : 'none';
      if (isOpen) {
        showPage('main', false);
        const player = document.querySelector('#movie_player');
        const panel = panelHost.querySelector('.sc-panel');
        if (player && panel) {
          const availableHeight = player.clientHeight - 72;
          panel.style.maxHeight = availableHeight + 'px';
        }
        applySettingsToUI();
        updateStatus();
      }
    }
  }

  function closePanel() {
    if (!isOpen) return;
    isOpen = false;
    if (panelHost) panelHost.style.display = 'none';
  }

  // ─── Injection ────────────────────────────────────────

  async function inject() {
    const rightControls = document.querySelector('.ytp-right-controls');
    const player = document.querySelector('#movie_player');
    if (!rightControls || !player) return;
    if (rightControls.querySelector('.silence-cut-btn')) return;

    player.querySelectorAll('.silence-cut-panel-host').forEach((el) => el.remove());

    buttonEl = createButton();
    const settingsBtn = rightControls.querySelector('.ytp-settings-button');
    if (settingsBtn) {
      settingsBtn.parentNode.insertBefore(buttonEl, settingsBtn);
    } else {
      rightControls.appendChild(buttonEl);
    }

    panelHost = document.createElement('div');
    panelHost.className = 'ytp-popup silence-cut-panel-host';
    panelHost.style.cssText = 'position:absolute;bottom:60px;right:12px;z-index:69;display:none;';
    panelHost.innerHTML = await loadTemplate();
    hydrateI18n(panelHost);

    player.appendChild(panelHost);

    bindPanelEvents();
    applySettingsToUI();
    registerGlobalEvents();
  }

  function registerGlobalEvents() {
    if (globalEventsRegistered) return;
    globalEventsRegistered = true;

    document.addEventListener('click', (e) => {
      if (!isOpen) return;
      const path = e.composedPath();
      if (path.includes(panelHost) || path.includes(buttonEl)) return;
      closePanel();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) closePanel();
    });
  }

  // ─── Status from audio-analyzer (MAIN world) ─────────

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    try { if (!chrome.runtime?.id) return; } catch { return; }
    if (event.data.type === 'SILENCE_CUT_VOLUME_UPDATE') {
      statusData = {
        active: settings?.enabled ?? false,
        skippedCount: event.data.skippedCount,
        timeSavedMs: event.data.timeSavedMs,
        currentVolumeDB: event.data.volumeDB,
        isInSilence: event.data.isInSilence,
        skipReason: event.data.skipReason,
        isMusic: event.data.isMusic,
        isAtLiveEdge: event.data.isAtLiveEdge ?? false,
        features: event.data.features ?? null
      };
      if (isOpen) updateStatus();
      updateButtonState();
    }
  });

  // ─── External settings changes (from popup) ──────────

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      settings = changes.settings.newValue;
      if (isOpen) applySettingsToUI();
      updateButtonState();
    }
  });

  // ─── YouTube SPA navigation ───────────────────────────

  function observe() {
    document.addEventListener('yt-navigate-finish', () => {
      setTimeout(inject, 500);
    });

    const observer = new MutationObserver(() => {
      const rightControls = document.querySelector('.ytp-right-controls');
      if (rightControls && !rightControls.querySelector('.silence-cut-btn')) {
        inject();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Template ─────────────────────────────────────────

  let templateCache = null;

  async function loadTemplate() {
    if (templateCache) return templateCache;
    const [html, css] = await Promise.all([
      fetch(chrome.runtime.getURL('content/panel.html')).then(r => r.text()),
      fetch(chrome.runtime.getURL('content/panel.css')).then(r => r.text()),
    ]);
    templateCache = `<style>${css}</style>${html}`;
    return templateCache;
  }

  function hydrateI18n(root) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      const args = el.dataset.i18nArgs ? JSON.parse(el.dataset.i18nArgs) : undefined;
      el.textContent = msg(key, args);
    });
    root.querySelectorAll('[data-i18n-aria]').forEach(el => {
      el.setAttribute('aria-label', msg(el.dataset.i18nAria));
    });
  }

  // ─── Init ─────────────────────────────────────────────

  loadSettings().then(() => {
    observe();
    inject();
  });
})();
