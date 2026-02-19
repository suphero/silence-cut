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
  let shadow = null;
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

  function $(sel) { return shadow?.querySelector(sel); }
  function $$(sel) { return shadow?.querySelectorAll(sel); }

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
    if (!shadow) return settings;
    return {
      enabled: $('#sc-enabled')?.checked ?? settings.enabled,
      silenceEnabled: $('#sc-sil-toggle')?.checked ?? settings.silenceEnabled,
      silenceThreshold: parseInt($('#sc-threshold')?.value ?? settings.silenceThreshold),
      minSilenceDuration: parseFloat($('#sc-sil-dur')?.value ?? settings.minSilenceDuration),
      musicEnabled: $('#sc-mus-toggle')?.checked ?? settings.musicEnabled,
      musicSensitivity: parseFloat($('#sc-mus-sens')?.value ?? settings.musicSensitivity),
      minMusicDuration: parseFloat($('#sc-mus-dur')?.value ?? settings.minMusicDuration),
      actionMode: settings.actionMode,
      speedMultiplier: parseInt($('#sc-speed')?.value ?? settings.speedMultiplier)
    };
  }

  // ─── Navigation ───────────────────────────────────────

  function showPage(pageId, isBack) {
    if (!shadow) return;
    $$('.sc-page').forEach((p) => p.classList.remove('active', 'back'));
    const target = $('#sc-page-' + pageId);
    if (target) {
      if (isBack) target.classList.add('back');
      target.classList.add('active');
    }
  }

  // ─── UI Sync ──────────────────────────────────────────

  function applySettingsToUI() {
    if (!shadow || !settings) return;

    // Header
    $('#sc-title').textContent = settings.actionMode === 'skip' ? msg('titleSkip') : msg('titleSpeed');
    $('#sc-enabled').checked = settings.enabled;
    $('#sc-enabled-label').textContent = settings.enabled ? msg('on') : msg('off');

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

    // Silence page
    $('#sc-sil-toggle').checked = settings.silenceEnabled;
    $('#sc-threshold').value = settings.silenceThreshold;
    $('#sc-threshold-val').textContent = settings.silenceThreshold + ' dB';
    $('#sc-sil-dur').value = settings.minSilenceDuration;
    $('#sc-sil-dur-val').textContent = settings.minSilenceDuration + 's';

    // Music page
    $('#sc-mus-toggle').checked = settings.musicEnabled;
    $('#sc-mus-sens').value = settings.musicSensitivity;
    $('#sc-mus-sens-val').textContent = '%' + Math.round(settings.musicSensitivity * 100);
    $('#sc-mus-dur').value = settings.minMusicDuration;
    $('#sc-mus-dur-val').textContent = settings.minMusicDuration + 's';

    updateThresholdLine();
    updateButtonState();
  }

  function updateThresholdLine() {
    if (!shadow) return;
    const val = parseInt($('#sc-threshold')?.value ?? -40);
    const pct = ((val + 60) / 50) * 100;
    const line = $('#sc-thr-line');
    if (line) line.style.left = pct + '%';
  }

  function updateStatus() {
    if (!shadow || !isOpen) return;

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
    buttonEl.style.opacity = settings?.enabled ? '1' : '0.5';
  }

  // ─── Panel Events ────────────────────────────────────

  function bindPanelEvents() {
    if (!shadow) return;

    // Stop YouTube keyboard shortcuts
    shadow.querySelector('.sc-panel').addEventListener('keydown', (e) => e.stopPropagation());

    // Header enable toggle
    $('#sc-enabled').addEventListener('change', saveSettings);

    // Menu items → navigate to sub-pages
    $$('.sc-menu-item[data-page]').forEach((item) => {
      item.addEventListener('click', () => showPage(item.dataset.page, false));
    });

    // Back buttons
    $$('.sc-back').forEach((btn) => {
      btn.addEventListener('click', () => {
        applySettingsToUI();
        showPage('main', true);
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
      saveSettings();
      $('#sc-mode-val').textContent = msg('speedUp') + ' · ' + $('#sc-speed').value + 'x';
    });

    // Silence page
    $('#sc-sil-toggle').addEventListener('change', () => {
      saveSettings();
      applySettingsToUI();
    });

    $('#sc-threshold').addEventListener('input', () => {
      $('#sc-threshold-val').textContent = $('#sc-threshold').value + ' dB';
      updateThresholdLine();
      saveSettings();
    });

    $('#sc-sil-dur').addEventListener('input', () => {
      $('#sc-sil-dur-val').textContent = parseFloat($('#sc-sil-dur').value).toFixed(1) + 's';
      saveSettings();
    });

    // Music page
    $('#sc-mus-toggle').addEventListener('change', () => {
      saveSettings();
      applySettingsToUI();
    });

    $('#sc-mus-sens').addEventListener('input', () => {
      $('#sc-mus-sens-val').textContent = '%' + Math.round(parseFloat($('#sc-mus-sens').value) * 100);
      saveSettings();
    });

    $('#sc-mus-dur').addEventListener('input', () => {
      $('#sc-mus-dur-val').textContent = parseFloat($('#sc-mus-dur').value).toFixed(1) + 's';
      saveSettings();
    });
  }

  // ─── Button ───────────────────────────────────────────

  function createButton() {
    const btn = document.createElement('button');
    btn.className = 'ytp-button silence-cut-btn';
    btn.title = 'Silence Cut';
    btn.style.cssText = 'cursor:pointer;border:none;background:none;padding:0;';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="white" stroke-width="1.5"/>
        <rect x="8.5" y="7" width="2" height="10" rx="0.5" fill="white"/>
        <rect x="13.5" y="7" width="2" height="10" rx="0.5" fill="white"/>
        <line x1="5" y1="19" x2="19" y2="5" stroke="white" stroke-width="2" stroke-linecap="round"/>
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
        const panel = shadow?.querySelector('.sc-panel');
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
    panelHost.className = 'silence-cut-panel-host';
    panelHost.style.cssText = 'position:absolute;bottom:60px;right:12px;z-index:69;display:none;';

    shadow = panelHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = buildTemplate();

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
        <div class="sc-header">
          <span class="sc-title" id="sc-title">${msg('titleSpeed')}</span>
          <div class="sc-toggle-group">
            <span class="sc-enabled-label" id="sc-enabled-label">${msg('off')}</span>
            <label class="sc-switch">
              <input type="checkbox" id="sc-enabled">
              <span class="sc-toggle"></span>
            </label>
          </div>
        </div>

        <div class="sc-menu">
          <div class="sc-menu-item" data-page="mode">
            <span class="sc-menu-label">${msg('mode')}</span>
            <span class="sc-menu-val" id="sc-mode-val">${msg('speedUp')}</span>
            <span class="sc-arrow">&#8250;</span>
          </div>
          <div class="sc-menu-item" data-page="silence">
            <span class="sc-menu-label">${msg('silenceDetection')}</span>
            <span class="sc-menu-val" id="sc-sil-val">${msg('on')}</span>
            <span class="sc-arrow">&#8250;</span>
          </div>
          <div class="sc-menu-item" data-page="music">
            <span class="sc-menu-label">${msg('musicDetection')}</span>
            <span class="sc-menu-val" id="sc-mus-val">${msg('off')}</span>
            <span class="sc-arrow">&#8250;</span>
          </div>
        </div>

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

      <!-- ===== MODE PAGE ===== -->
      <div class="sc-page" id="sc-page-mode">
        <div class="sc-page-header">
          <button class="sc-back" type="button">&#8249;</button>
          <span>${msg('mode')}</span>
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
        <div class="sc-speed-inline hidden" id="sc-speed-inline">
          <div class="sc-slider-page">
            <div class="sc-big-value" id="sc-speed-big">4x</div>
            <input type="range" id="sc-speed" min="2" max="16" value="4" step="1">
            <div class="sc-range-labels"><span>2x</span><span>16x</span></div>
          </div>
        </div>
      </div>

      <!-- ===== SILENCE PAGE ===== -->
      <div class="sc-page" id="sc-page-silence">
        <div class="sc-page-header">
          <button class="sc-back" type="button">&#8249;</button>
          <span>${msg('silenceDetection')}</span>
          <label class="sc-switch sc-hdr-toggle">
            <input type="checkbox" id="sc-sil-toggle">
            <span class="sc-toggle"></span>
          </label>
        </div>
        <div class="sc-slider-page">
          <div class="sc-slider-row">
            <span>${msg('silenceThreshold')}</span>
            <span class="sc-slider-val" id="sc-threshold-val">-40 dB</span>
          </div>
          <input type="range" id="sc-threshold" min="-60" max="-10" value="-40" step="1">
          <div class="sc-range-labels"><span>-60 dB</span><span>-10 dB</span></div>

          <div class="sc-slider-row sc-mt">
            <span>${msg('minDuration')}</span>
            <span class="sc-slider-val" id="sc-sil-dur-val">0.1s</span>
          </div>
          <input type="range" id="sc-sil-dur" min="0.1" max="3.0" value="0.1" step="0.1">
          <div class="sc-range-labels"><span>0.1s</span><span>3.0s</span></div>
        </div>
      </div>

      <!-- ===== MUSIC PAGE ===== -->
      <div class="sc-page" id="sc-page-music">
        <div class="sc-page-header">
          <button class="sc-back" type="button">&#8249;</button>
          <span>${msg('musicDetection')}</span>
          <label class="sc-switch sc-hdr-toggle">
            <input type="checkbox" id="sc-mus-toggle">
            <span class="sc-toggle"></span>
          </label>
        </div>
        <div class="sc-slider-page">
          <div class="sc-slider-row">
            <span>${msg('sensitivity')}</span>
            <span class="sc-slider-val" id="sc-mus-sens-val">%50</span>
          </div>
          <input type="range" id="sc-mus-sens" min="0" max="1" value="0.5" step="0.05">
          <div class="sc-range-labels"><span>${msg('low')}</span><span>${msg('high')}</span></div>

          <div class="sc-slider-row sc-mt">
            <span>${msg('minDuration')}</span>
            <span class="sc-slider-val" id="sc-mus-dur-val">1.0s</span>
          </div>
          <input type="range" id="sc-mus-dur" min="0.5" max="5.0" value="1.0" step="0.5">
          <div class="sc-range-labels"><span>0.5s</span><span>5.0s</span></div>
        </div>
      </div>

    </div>`;
  }

  // ─── CSS ──────────────────────────────────────────────

  const PANEL_CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    .sc-panel {
      width: 300px;
      overflow-y: auto;
      overflow-x: hidden;
      background: rgba(28, 28, 28, 0.94);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border-radius: 12px;
      color: #f1f1f1;
      font-family: 'Roboto', Arial, sans-serif;
      font-size: 14px;
      line-height: 1.4;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      -webkit-font-smoothing: antialiased;
    }

    .sc-panel::-webkit-scrollbar { width: 4px; }
    .sc-panel::-webkit-scrollbar-track { background: transparent; }
    .sc-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }

    /* ── Pages ── */
    .sc-page { display: none; padding: 12px 0; }
    .sc-page.active { display: block; animation: scSlideIn 0.12s ease-out; }
    .sc-page.active.back { animation: scSlideBack 0.12s ease-out; }
    @keyframes scSlideIn { from { opacity:0; transform:translateX(16px); } to { opacity:1; transform:translateX(0); } }
    @keyframes scSlideBack { from { opacity:0; transform:translateX(-16px); } to { opacity:1; transform:translateX(0); } }

    /* ── Header ── */
    .sc-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 16px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .sc-title { font-size: 14px; font-weight: 500; }
    .sc-toggle-group { display: flex; align-items: center; gap: 8px; }
    .sc-enabled-label { font-size: 12px; color: rgba(255,255,255,0.4); }

    /* ── Toggle Switch ── */
    .sc-switch {
      position: relative; display: inline-block;
      width: 36px; height: 20px; flex-shrink: 0; cursor: pointer;
    }
    .sc-switch input { opacity:0; width:0; height:0; position:absolute; }
    .sc-toggle {
      position: absolute; cursor: pointer; inset: 0;
      background: rgba(255,255,255,0.2); border-radius: 20px; transition: background 0.2s;
    }
    .sc-toggle::before {
      content: ''; position: absolute;
      width: 16px; height: 16px; left: 2px; bottom: 2px;
      background: white; border-radius: 50%; transition: transform 0.2s;
    }
    .sc-switch input:checked + .sc-toggle { background: #3ea6ff; }
    .sc-switch input:checked + .sc-toggle::before { transform: translateX(16px); }

    /* ── Info Bar ── */
    .sc-info {
      display: flex; align-items: center; gap: 5px;
      padding: 10px 16px;
      font-size: 12px; color: rgba(255,255,255,0.5);
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .sc-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: rgba(255,255,255,0.2); flex-shrink: 0;
    }
    .sc-dot.active { background: #2ba640; box-shadow: 0 0 6px #2ba640; }
    .sc-dot.live { background: #ff4e45; box-shadow: 0 0 6px #ff4e45; }
    .sc-info-time { margin-left: auto; font-weight: 500; color: rgba(255,255,255,0.7); white-space: nowrap; }

    /* ── Menu ── */
    .sc-menu { padding: 4px 0; }
    .sc-menu-item {
      display: flex; align-items: center; padding: 10px 16px;
      cursor: pointer; transition: background 0.1s;
    }
    .sc-menu-item:hover { background: rgba(255,255,255,0.1); }
    .sc-menu-label { flex: 1; font-size: 14px; }
    .sc-menu-val { font-size: 14px; color: rgba(255,255,255,0.5); margin-right: 4px; }
    .sc-arrow { font-size: 20px; color: rgba(255,255,255,0.3); line-height: 1; }

    /* ── Meter Section ── */
    .sc-meter-section {
      padding: 8px 16px 4px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .sc-meter-row {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;
    }
    .sc-meter-label {
      font-size: 11px; color: rgba(255,255,255,0.4);
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .sc-vol-db { font-size: 11px; color: rgba(255,255,255,0.4); }
    .sc-volume-meter {
      position: relative; height: 6px;
      background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden;
    }
    .sc-volume-bar {
      height: 100%; width: 0%;
      background: linear-gradient(90deg, #2ba640, #ffc107, #ff4e45);
      border-radius: 3px; transition: width 80ms ease;
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

    /* ── Sub-page Header ── */
    .sc-page-header {
      display: flex; align-items: center; gap: 8px;
      padding: 0 16px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      font-size: 14px; font-weight: 500;
    }
    .sc-hdr-toggle { margin-left: auto; }
    .sc-back {
      background: none; border: none; color: #f1f1f1;
      font-size: 28px; cursor: pointer; padding: 0;
      line-height: 1; width: 24px;
      display: flex; align-items: center; justify-content: center;
    }
    .sc-back:hover { color: #3ea6ff; }

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

    /* ── Inline Speed (inside mode page) ── */
    .sc-speed-inline { border-top: 1px solid rgba(255,255,255,0.06); }

    /* ── Slider Pages ── */
    .sc-slider-page { padding: 16px; }
    .sc-slider-row {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 8px; font-size: 13px;
    }
    .sc-slider-val { color: rgba(255,255,255,0.5); font-weight: 500; }
    .sc-mt { margin-top: 20px; }
    .sc-big-value {
      text-align: center; font-size: 24px; font-weight: 500;
      margin-bottom: 16px; color: #f1f1f1;
    }
    input[type='range'] {
      -webkit-appearance: none; appearance: none;
      width: 100%; height: 4px;
      background: rgba(255,255,255,0.2); border-radius: 2px;
      outline: none; cursor: pointer;
    }
    input[type='range']::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 14px; height: 14px; border-radius: 50%;
      background: #3ea6ff; cursor: pointer; border: none;
    }
    .sc-range-labels {
      display: flex; justify-content: space-between;
      margin-top: 6px; font-size: 11px; color: rgba(255,255,255,0.3);
    }

    /* ── Utility ── */
    .hidden { display: none !important; }
  `;

  // ─── Init ─────────────────────────────────────────────

  loadSettings().then(() => {
    observe();
    inject();
  });
})();
