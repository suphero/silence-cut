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
    isAtLiveEdge: false
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
    const s = msg('secondShort');
    const m = msg('minuteShort');
    const h = msg('hourShort');
    if (totalSec < 60) return totalSec + s;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60) return min + m + ' ' + sec + s;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return hr + h + ' ' + remMin + m;
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
    if (tagSil) tagSil.classList.toggle('hidden', !statusData.isInSilence || statusData.skipReason !== 'silence');
    if (tagMus) tagMus.classList.toggle('hidden', !statusData.isMusic);
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

  function inject() {
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
    panelHost.innerHTML = buildTemplate();

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
        isAtLiveEdge: event.data.isAtLiveEdge ?? false
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

  function buildTemplate() {
    return `<style>${PANEL_CSS}</style>
    <div class="sc-panel">

      <!-- ===== MAIN PAGE ===== -->
      <div class="sc-page active" id="sc-page-main">
        <div class="ytp-panel-menu" role="menu">
          <div class="ytp-menuitem" role="menuitemcheckbox" aria-checked="true" tabindex="0" id="sc-enabled-item">
            <div class="ytp-menuitem-icon"><svg fill="none" height="24" viewBox="0 0 24 24" width="24"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42A6.92 6.92 0 0 1 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.05.88-3.89 2.29-5.17L5.88 5.46A8.96 8.96 0 0 0 3 12a9 9 0 0 0 18 0c0-2.74-1.23-5.18-3.17-6.83z" fill="white"/></svg></div>
            <div class="ytp-menuitem-label">Silence Cut</div>
            <div class="ytp-menuitem-content"><div class="ytp-menuitem-toggle-checkbox"></div></div>
          </div>
          <div class="ytp-menuitem-separator"></div>
          <div class="ytp-menuitem" aria-haspopup="true" role="menuitem" tabindex="0" data-page="mode">
            <div class="ytp-menuitem-icon"><svg fill="none" height="24" viewBox="0 0 24 24" width="24"><path d="M12 1c1.44 0 2.87.28 4.21.83a11 11 0 0 1 3.45 2.27l-1.81 1.05A9 9 0 0 0 3 12a9 9 0 0 0 18-.00l-.01-.44a8.99 8.99 0 0 0-.14-1.20l1.81-1.05A11.00 11.00 0 0 1 10.51 22.9 11 11 0 0 1 12 1Zm7.08 6.25-7.96 3.25a1.74 1.74 0 1 0 1.73 2.99l6.8-5.26a.57.57 0 0 0-.56-.98Z" fill="white"/></svg></div>
            <div class="ytp-menuitem-label">${msg('mode')}</div>
            <div class="ytp-menuitem-content"><span id="sc-mode-val">${msg('speedUp')}</span></div>
          </div>
          <div class="ytp-menuitem" aria-haspopup="true" role="menuitem" tabindex="0" data-page="silence">
            <div class="ytp-menuitem-icon"><svg fill="none" height="24" viewBox="0 0 24 24" width="24"><path d="M4.34 2.93L2.93 4.34 7.29 8.7 7 9H3v6h4l5 5v-6.59l4.18 4.18c-.65.49-1.38.88-2.18 1.11v2.06a8.94 8.94 0 0 0 3.61-1.75l2.05 2.05 1.41-1.41L4.34 2.93zM10 15.17L7.83 13H5v-2h2.83l.88-.88L10 11.41v3.76zM19 12c0 .82-.15 1.61-.41 2.34l1.53 1.53c.56-1.17.88-2.48.88-3.87 0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zm-7-8l-1.88 1.88L12 7.76V4zm4.5 8A4.5 4.5 0 0 0 14 7.97v1.79l2.48 2.48c.01-.08.02-.16.02-.24z" fill="white"/></svg></div>
            <div class="ytp-menuitem-label">${msg('silenceDetection')}</div>
            <div class="ytp-menuitem-content"><span id="sc-sil-val">${msg('on')}</span></div>
          </div>
          <div class="ytp-menuitem" aria-haspopup="true" role="menuitem" tabindex="0" data-page="music">
            <div class="ytp-menuitem-icon"><svg fill="none" height="24" viewBox="0 0 24 24" width="24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zM10 19a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" fill="white"/></svg></div>
            <div class="ytp-menuitem-label">${msg('musicDetection')}</div>
            <div class="ytp-menuitem-content"><span id="sc-mus-val">${msg('off')}</span></div>
          </div>
        </div>
        <div class="sc-panel-footer">
          <div class="sc-info">
            <span class="sc-dot" id="sc-dot"></span>
            <span id="sc-status-text">${msg('waiting')}</span>
            <span class="sc-info-sep">&middot;</span>
            <span id="sc-skip-count">${msg('skipCount', ['0'])}</span>
            <span class="sc-info-time">&nbsp;&#9201; <span id="sc-time-saved">0s</span></span>
          </div>
          <div class="sc-meter-section">
            <div class="sc-meter-row">
              <span class="sc-meter-label">${msg('volumeLevel')}</span>
              <span class="sc-vol-db" id="sc-vol-db">-- dB</span>
            </div>
            <div class="sc-volume-meter">
              <div class="sc-volume-bar" id="sc-vol-bar"></div>
              <div class="sc-threshold-line" id="sc-thr-line"></div>
            </div>
            <div class="sc-tags">
              <span class="sc-tag sc-tag-silence hidden" id="sc-tag-sil">${msg('silence')}</span>
              <span class="sc-tag sc-tag-music hidden" id="sc-tag-mus">${msg('music')}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== MODE PAGE ===== -->
      <div class="sc-page" id="sc-page-mode">
        <div class="ytp-panel-header">
          <div class="ytp-panel-back-button-container"><button class="ytp-button ytp-panel-back-button sc-back" aria-label="${msg('mode')}"></button></div>
          <span class="ytp-panel-title" role="heading" aria-level="2">${msg('mode')}</span>
        </div>
        <div class="sc-options">
          <div class="sc-mode-opt" data-value="skip">
            <span class="sc-check">&#10003;</span>
            <span>${msg('skip')}</span>
          </div>
          <div class="sc-mode-opt" data-value="speed">
            <span class="sc-check">&#10003;</span>
            <span>${msg('speedUp')}</span>
          </div>
        </div>
        <div class="hidden" id="sc-speed-inline">
          <div class="ytp-menuitem-separator"></div>
          <div class="ytp-variable-speed-panel-content" tabindex="0">
            <div class="ytp-speed-display-container">
              <div class="ytp-variable-speed-panel-display" aria-live="polite"><span id="sc-speed-big">4x</span></div>
            </div>
            <div class="ytp-variable-speed-panel-slider-container">
              <button class="ytp-button ytp-variable-speed-panel-button ytp-variable-speed-panel-increment-button" data-target="sc-speed" data-step="-1"><span>-</span></button>
              <div class="ytp-input-slider-section">
                <input class="ytp-input-slider ytp-varispeed-input-slider" type="range" id="sc-speed" min="2" max="16" value="4" step="1">
              </div>
              <button class="ytp-button ytp-variable-speed-panel-button ytp-variable-speed-panel-increment-button" data-target="sc-speed" data-step="1"><span>+</span></button>
            </div>
            <div class="ytp-variable-speed-panel-chips">
              <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-speed" data-value="2"><span>2x</span></button></div>
              <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-speed" data-value="4"><span>4x</span></button></div>
              <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-speed" data-value="8"><span>8x</span></button></div>
              <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-speed" data-value="16"><span>16x</span></button></div>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== SILENCE MENU PAGE ===== -->
      <div class="sc-page" id="sc-page-silence">
        <div class="ytp-panel-header">
          <div class="ytp-panel-back-button-container"><button class="ytp-button ytp-panel-back-button sc-back" aria-label="${msg('silenceDetection')}"></button></div>
          <span class="ytp-panel-title" role="heading" aria-level="2">${msg('silenceDetection')}</span>
        </div>
        <div class="ytp-panel-menu" role="menu">
          <div class="ytp-menuitem" role="menuitemcheckbox" aria-checked="false" tabindex="0" id="sc-sil-toggle">
            <div class="ytp-menuitem-icon"><svg fill="none" height="24" viewBox="0 0 24 24" width="24"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42A6.92 6.92 0 0 1 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.05.88-3.89 2.29-5.17L5.88 5.46A8.96 8.96 0 0 0 3 12a9 9 0 0 0 18 0c0-2.74-1.23-5.18-3.17-6.83z" fill="white"/></svg></div>
            <div class="ytp-menuitem-label">${msg('enabled')}</div>
            <div class="ytp-menuitem-content"><div class="ytp-menuitem-toggle-checkbox"></div></div>
          </div>
          <div class="ytp-menuitem" aria-haspopup="true" role="menuitem" tabindex="0" data-page="sil-threshold">
            <div class="ytp-menuitem-icon"><svg fill="none" height="24" viewBox="0 0 24 24" width="24"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" fill="white"/></svg></div>
            <div class="ytp-menuitem-label">${msg('silenceThreshold')}</div>
            <div class="ytp-menuitem-content"><span id="sc-threshold-menu">-40 dB</span></div>
          </div>
          <div class="ytp-menuitem" aria-haspopup="true" role="menuitem" tabindex="0" data-page="sil-duration">
            <div class="ytp-menuitem-icon"><svg fill="none" height="24" viewBox="0 0 24 24" width="24"><path d="M15 1H9v2h6V1zm-4 13h2V8h-2v6zm8.03-6.61l1.42-1.42c-.43-.51-.9-.99-1.41-1.41l-1.42 1.42A8.962 8.962 0 0 0 12 4c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-2.12-.74-4.07-1.97-5.61zM12 20c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z" fill="white"/></svg></div>
            <div class="ytp-menuitem-label">${msg('minDuration')}</div>
            <div class="ytp-menuitem-content"><span id="sc-sil-dur-menu">0.1s</span></div>
          </div>
        </div>
      </div>

      <!-- ===== SILENCE THRESHOLD PAGE ===== -->
      <div class="sc-page" data-back="silence" id="sc-page-sil-threshold">
        <div class="ytp-panel-header">
          <div class="ytp-panel-back-button-container"><button class="ytp-button ytp-panel-back-button sc-back" aria-label="${msg('silenceThreshold')}"></button></div>
          <span class="ytp-panel-title" role="heading" aria-level="2">${msg('silenceThreshold')}</span>
        </div>
        <div class="ytp-variable-speed-panel-content" tabindex="0">
          <div class="ytp-speed-display-container">
            <div class="ytp-variable-speed-panel-display" aria-live="polite"><span id="sc-threshold-val">-40 dB</span></div>
          </div>
          <div class="ytp-variable-speed-panel-slider-container">
            <button class="ytp-button ytp-variable-speed-panel-button ytp-variable-speed-panel-increment-button" data-target="sc-threshold" data-step="-1"><span>-</span></button>
            <div class="ytp-input-slider-section">
              <input class="ytp-input-slider ytp-varispeed-input-slider" type="range" id="sc-threshold" min="-60" max="-10" value="-40" step="1">
            </div>
            <button class="ytp-button ytp-variable-speed-panel-button ytp-variable-speed-panel-increment-button" data-target="sc-threshold" data-step="1"><span>+</span></button>
          </div>
          <div class="ytp-variable-speed-panel-chips">
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-threshold" data-value="-50"><span>-50 dB</span></button></div>
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-threshold" data-value="-40"><span>-40 dB</span></button></div>
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-threshold" data-value="-30"><span>-30 dB</span></button></div>
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-threshold" data-value="-20"><span>-20 dB</span></button></div>
          </div>
        </div>
      </div>

      <!-- ===== SILENCE DURATION PAGE ===== -->
      <div class="sc-page" data-back="silence" id="sc-page-sil-duration">
        <div class="ytp-panel-header">
          <div class="ytp-panel-back-button-container"><button class="ytp-button ytp-panel-back-button sc-back" aria-label="${msg('minDuration')}"></button></div>
          <span class="ytp-panel-title" role="heading" aria-level="2">${msg('minDuration')}</span>
        </div>
        <div class="ytp-variable-speed-panel-content" tabindex="0">
          <div class="ytp-speed-display-container">
            <div class="ytp-variable-speed-panel-display" aria-live="polite"><span id="sc-sil-dur-val">0.1s</span></div>
          </div>
          <div class="ytp-variable-speed-panel-slider-container">
            <button class="ytp-button ytp-variable-speed-panel-button ytp-variable-speed-panel-increment-button" data-target="sc-sil-dur" data-step="-0.1"><span>-</span></button>
            <div class="ytp-input-slider-section">
              <input class="ytp-input-slider ytp-varispeed-input-slider" type="range" id="sc-sil-dur" min="0.1" max="3.0" value="0.1" step="0.1">
            </div>
            <button class="ytp-button ytp-variable-speed-panel-button ytp-variable-speed-panel-increment-button" data-target="sc-sil-dur" data-step="0.1"><span>+</span></button>
          </div>
          <div class="ytp-variable-speed-panel-chips">
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-sil-dur" data-value="0.1"><span>0.1s</span></button></div>
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-sil-dur" data-value="0.5"><span>0.5s</span></button></div>
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-sil-dur" data-value="1.0"><span>1.0s</span></button></div>
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-sil-dur" data-value="2.0"><span>2.0s</span></button></div>
          </div>
        </div>
      </div>

      <!-- ===== MUSIC MENU PAGE ===== -->
      <div class="sc-page" id="sc-page-music">
        <div class="ytp-panel-header">
          <div class="ytp-panel-back-button-container"><button class="ytp-button ytp-panel-back-button sc-back" aria-label="${msg('musicDetection')}"></button></div>
          <span class="ytp-panel-title" role="heading" aria-level="2">${msg('musicDetection')}</span>
        </div>
        <div class="ytp-panel-menu" role="menu">
          <div class="ytp-menuitem" role="menuitemcheckbox" aria-checked="false" tabindex="0" id="sc-mus-toggle">
            <div class="ytp-menuitem-icon"><svg fill="none" height="24" viewBox="0 0 24 24" width="24"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42A6.92 6.92 0 0 1 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.05.88-3.89 2.29-5.17L5.88 5.46A8.96 8.96 0 0 0 3 12a9 9 0 0 0 18 0c0-2.74-1.23-5.18-3.17-6.83z" fill="white"/></svg></div>
            <div class="ytp-menuitem-label">${msg('enabled')}</div>
            <div class="ytp-menuitem-content"><div class="ytp-menuitem-toggle-checkbox"></div></div>
          </div>
          <div class="ytp-menuitem" aria-haspopup="true" role="menuitem" tabindex="0" data-page="mus-sensitivity">
            <div class="ytp-menuitem-icon"><svg fill="none" height="24" viewBox="0 0 24 24" width="24"><path d="M10 20h4V4h-4v16zm-6 0h4v-8H4v8zM16 9v11h4V9h-4z" fill="white"/></svg></div>
            <div class="ytp-menuitem-label">${msg('sensitivity')}</div>
            <div class="ytp-menuitem-content"><span id="sc-mus-sens-menu">%50</span></div>
          </div>
          <div class="ytp-menuitem" aria-haspopup="true" role="menuitem" tabindex="0" data-page="mus-duration">
            <div class="ytp-menuitem-icon"><svg fill="none" height="24" viewBox="0 0 24 24" width="24"><path d="M15 1H9v2h6V1zm-4 13h2V8h-2v6zm8.03-6.61l1.42-1.42c-.43-.51-.9-.99-1.41-1.41l-1.42 1.42A8.962 8.962 0 0 0 12 4c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-2.12-.74-4.07-1.97-5.61zM12 20c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z" fill="white"/></svg></div>
            <div class="ytp-menuitem-label">${msg('minDuration')}</div>
            <div class="ytp-menuitem-content"><span id="sc-mus-dur-menu">1.0s</span></div>
          </div>
        </div>
      </div>

      <!-- ===== MUSIC SENSITIVITY PAGE ===== -->
      <div class="sc-page" data-back="music" id="sc-page-mus-sensitivity">
        <div class="ytp-panel-header">
          <div class="ytp-panel-back-button-container"><button class="ytp-button ytp-panel-back-button sc-back" aria-label="${msg('sensitivity')}"></button></div>
          <span class="ytp-panel-title" role="heading" aria-level="2">${msg('sensitivity')}</span>
        </div>
        <div class="ytp-variable-speed-panel-content" tabindex="0">
          <div class="ytp-speed-display-container">
            <div class="ytp-variable-speed-panel-display" aria-live="polite"><span id="sc-mus-sens-val">%50</span></div>
          </div>
          <div class="ytp-variable-speed-panel-slider-container">
            <button class="ytp-button ytp-variable-speed-panel-button ytp-variable-speed-panel-increment-button" data-target="sc-mus-sens" data-step="-0.05"><span>-</span></button>
            <div class="ytp-input-slider-section">
              <input class="ytp-input-slider ytp-varispeed-input-slider" type="range" id="sc-mus-sens" min="0" max="1" value="0.5" step="0.05">
            </div>
            <button class="ytp-button ytp-variable-speed-panel-button ytp-variable-speed-panel-increment-button" data-target="sc-mus-sens" data-step="0.05"><span>+</span></button>
          </div>
          <div class="ytp-variable-speed-panel-chips">
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-mus-sens" data-value="0.25"><span>%25</span></button></div>
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-mus-sens" data-value="0.5"><span>%50</span></button></div>
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-mus-sens" data-value="0.75"><span>%75</span></button></div>
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-mus-sens" data-value="1"><span>%100</span></button></div>
          </div>
        </div>
      </div>

      <!-- ===== MUSIC DURATION PAGE ===== -->
      <div class="sc-page" data-back="music" id="sc-page-mus-duration">
        <div class="ytp-panel-header">
          <div class="ytp-panel-back-button-container"><button class="ytp-button ytp-panel-back-button sc-back" aria-label="${msg('minDuration')}"></button></div>
          <span class="ytp-panel-title" role="heading" aria-level="2">${msg('minDuration')}</span>
        </div>
        <div class="ytp-variable-speed-panel-content" tabindex="0">
          <div class="ytp-speed-display-container">
            <div class="ytp-variable-speed-panel-display" aria-live="polite"><span id="sc-mus-dur-val">1.0s</span></div>
          </div>
          <div class="ytp-variable-speed-panel-slider-container">
            <button class="ytp-button ytp-variable-speed-panel-button ytp-variable-speed-panel-increment-button" data-target="sc-mus-dur" data-step="-0.5"><span>-</span></button>
            <div class="ytp-input-slider-section">
              <input class="ytp-input-slider ytp-varispeed-input-slider" type="range" id="sc-mus-dur" min="0.5" max="5.0" value="1.0" step="0.5">
            </div>
            <button class="ytp-button ytp-variable-speed-panel-button ytp-variable-speed-panel-increment-button" data-target="sc-mus-dur" data-step="0.5"><span>+</span></button>
          </div>
          <div class="ytp-variable-speed-panel-chips">
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-mus-dur" data-value="0.5"><span>0.5s</span></button></div>
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-mus-dur" data-value="1"><span>1.0s</span></button></div>
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-mus-dur" data-value="2"><span>2.0s</span></button></div>
            <div class="ytp-variable-speed-panel-preset-button-wrapper"><button class="ytp-button ytp-variable-speed-panel-preset-button ytp-variable-speed-panel-button" data-target="sc-mus-dur" data-value="3"><span>3.0s</span></button></div>
          </div>
        </div>
      </div>

    </div>`;
  }

  // ─── CSS (only custom components — YouTube handles ytp-* classes) ───

  const PANEL_CSS = `
    .silence-cut-panel-host *,
    .silence-cut-panel-host *::before,
    .silence-cut-panel-host *::after { box-sizing: border-box; }

    .sc-panel {
      width: 300px;
      overflow-y: auto;
      overflow-x: hidden;
      border-radius: 12px;
      color: #f1f1f1;
      font-family: 'Roboto', 'Arial', sans-serif;
      font-size: 14px;
      line-height: 1.4;
      -webkit-font-smoothing: antialiased;
    }

    .sc-panel::-webkit-scrollbar { width: 4px; }
    .sc-panel::-webkit-scrollbar-track { background: transparent; }
    .sc-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }

    /* ── Pages ── */
    .sc-page { display: none; padding: 8px 0; }
    .sc-page.active { display: flex; flex-direction: column; animation: scSlideIn 0.15s ease-out; }
    .sc-page > .ytp-panel-menu { flex: 1; min-height: 0; }
    .sc-panel-footer { flex-shrink: 0; border-top: 1px solid rgba(255,255,255,0.1); }
    .sc-page.active.back { animation: scSlideBack 0.15s ease-out; }
    @keyframes scSlideIn { from { opacity:0; transform:translateX(16px); } to { opacity:1; transform:translateX(0); } }
    @keyframes scSlideBack { from { opacity:0; transform:translateX(-16px); } to { opacity:1; transform:translateX(0); } }

    /* ── Separator (fallback if YouTube CSS doesn't style it) ── */
    .silence-cut-panel-host .ytp-menuitem-separator { border-top: 1px solid rgba(255,255,255,0.1); }

    /* ── Info Bar ── */
    .sc-info {
      display: flex; align-items: center; gap: 5px;
      padding: 10px 16px;
      font-size: 12px; color: #f1f1f1;
    }
    .sc-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: rgba(255,255,255,0.2); flex-shrink: 0;
    }
    .sc-dot.active { background: #2ba640; box-shadow: 0 0 6px #2ba640; }
    .sc-dot.live { background: #ff4e45; box-shadow: 0 0 6px #ff4e45; }
    .sc-info-time { margin-left: auto; font-weight: 500; color: rgba(255,255,255,0.7); white-space: nowrap; }

    /* ── Meter Section ── */
    .sc-meter-section {
      padding: 8px 16px 8px;
    }
    .sc-meter-row {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;
    }
    .sc-meter-label {
      font-size: 11px; color: #f1f1f1;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .sc-vol-db { font-size: 11px; color: #f1f1f1; }
    .sc-volume-meter {
      position: relative; height: 4px;
      background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;
    }
    .sc-volume-bar {
      height: 100%; width: 0%;
      background: linear-gradient(90deg, #2ba640, #ffc107, #ff4e45);
      border-radius: 2px; transition: width 80ms ease;
    }
    .sc-threshold-line {
      position: absolute; top: 0; bottom: 0; width: 2px;
      background: white; opacity: 0.5;
    }
    .sc-tags { display: flex; gap: 6px; margin-top: 6px; min-height: 18px; }
    .sc-tag {
      display: inline-flex; align-items: center;
      padding: 2px 6px; border-radius: 4px;
      font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .sc-tag-silence { background: rgba(43,166,64,0.15); color: #2ba640; border: 1px solid rgba(43,166,64,0.3); }
    .sc-tag-music { background: rgba(156,39,176,0.15); color: #9c27b0; border: 1px solid rgba(156,39,176,0.3); }

    /* ── Options List (Mode) ── */
    .sc-options { padding: 4px 0; }
    .sc-mode-opt {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 16px; cursor: pointer; transition: background 0.1s; font-size: 14px;
    }
    .sc-mode-opt:hover { background: rgba(255,255,255,0.1); }
    .sc-check {
      width: 20px; text-align: center; font-size: 16px;
      color: #3ea6ff; visibility: hidden;
    }
    .sc-mode-opt.selected .sc-check { visibility: visible; }

    /* ── Utility ── */
    .hidden { display: none !important; }
  `;

  // ─── Init ─────────────────────────────────────────────

  loadSettings().then(() => {
    observe();
    inject();
  });
})();
