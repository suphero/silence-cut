import type {
  Settings,
  SkipReason,
  DebugFeatures,
  AnalyzerMessage,
} from '../types';

(function () {
  'use strict';

  const DEFAULT_SETTINGS: Settings = {
    enabled: true,
    silenceEnabled: true,
    silenceThreshold: -40,
    minSilenceDuration: 0.1,
    musicEnabled: false,
    musicSensitivity: 0.5,
    minMusicDuration: 1.0,
    actionMode: 'speed',
    speedMultiplier: 4,
  };

  const msg = (...args: Parameters<typeof chrome.i18n.getMessage>): string => {
    try {
      return chrome.i18n.getMessage(...args) || '';
    } catch {
      return '';
    }
  };

  let settings: Settings | null = null;
  let isOpen = false;
  let buttonEl: HTMLButtonElement | null = null;
  let panelHost: HTMLDivElement | null = null;
  let globalEventsRegistered = false;

  interface StatusData {
    active: boolean;
    skippedCount: number;
    timeSavedMs: number;
    currentVolumeDB: number;
    isInSilence: boolean;
    skipReason: SkipReason;
    isMusic: boolean;
    isAtLiveEdge: boolean;
    features: DebugFeatures | null;
  }

  let statusData: StatusData = {
    active: false,
    skippedCount: 0,
    timeSavedMs: 0,
    currentVolumeDB: -Infinity,
    isInSilence: false,
    skipReason: null,
    isMusic: false,
    isAtLiveEdge: false,
    features: null,
  };

  // --- Helpers ---

  function $<T extends Element = Element>(sel: string): T | null {
    return panelHost?.querySelector<T>(sel) ?? null;
  }

  function $$<T extends Element = Element>(sel: string): NodeListOf<T> {
    return (
      panelHost?.querySelectorAll<T>(sel) ?? document.querySelectorAll<T>('#__never__')
    );
  }

  function updateSliderFill(slider: HTMLInputElement | null): void {
    if (!slider) return;
    const pct =
      ((parseFloat(slider.value) - parseFloat(slider.min)) /
        (parseFloat(slider.max) - parseFloat(slider.min))) *
      100;
    slider.style.setProperty(
      '--yt-slider-shape-gradient-percent',
      pct + '%',
    );
  }

  function formatTimeSaved(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const hr = Math.floor(totalSec / 3600);
    const min = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    const pad = (n: number): string => String(n).padStart(2, '0');
    return pad(hr) + ':' + pad(min) + ':' + pad(sec);
  }

  // --- Settings ---

  async function loadSettings(): Promise<Settings> {
    return new Promise((resolve) => {
      chrome.storage.sync.get('settings', (data) => {
        settings = {
          ...DEFAULT_SETTINGS,
          ...((data.settings as Partial<Settings>) || {}),
        };
        resolve(settings);
      });
    });
  }

  async function saveSettings(): Promise<void> {
    settings = readSettingsFromUI();
    await chrome.storage.sync.set({ settings });
    updateButtonState();
  }

  function readSettingsFromUI(): Settings {
    if (!panelHost) return settings!;
    return {
      enabled:
        $('[id="sc-enabled-item"]')?.getAttribute('aria-checked') === 'true',
      silenceEnabled:
        $('[id="sc-sil-toggle"]')?.getAttribute('aria-checked') === 'true',
      silenceThreshold: parseInt(
        ($<HTMLInputElement>('#sc-threshold')?.value ??
          String(settings!.silenceThreshold)),
      ),
      minSilenceDuration: parseFloat(
        ($<HTMLInputElement>('#sc-sil-dur')?.value ??
          String(settings!.minSilenceDuration)),
      ),
      musicEnabled:
        $('[id="sc-mus-toggle"]')?.getAttribute('aria-checked') === 'true',
      musicSensitivity: parseFloat(
        ($<HTMLInputElement>('#sc-mus-sens')?.value ??
          String(settings!.musicSensitivity)),
      ),
      minMusicDuration: parseFloat(
        ($<HTMLInputElement>('#sc-mus-dur')?.value ??
          String(settings!.minMusicDuration)),
      ),
      actionMode: settings!.actionMode,
      speedMultiplier: parseInt(
        ($<HTMLInputElement>('#sc-speed')?.value ??
          String(settings!.speedMultiplier)),
      ),
    };
  }

  // --- Navigation ---

  function showPage(pageId: string, isBack: boolean): void {
    if (!panelHost) return;
    $$('.sc-page').forEach((p) => p.classList.remove('active', 'back'));
    const target = $(`#sc-page-${pageId}`);
    if (target) {
      if (isBack) target.classList.add('back');
      target.classList.add('active');
    }
  }

  // --- UI Sync ---

  function applySettingsToUI(): void {
    if (!panelHost || !settings) return;

    $('#sc-enabled-item')?.setAttribute(
      'aria-checked',
      settings.enabled ? 'true' : 'false',
    );

    const isSpeed = settings.actionMode === 'speed';
    const modeText = isSpeed
      ? msg('speedUp') + ' \u00B7 ' + settings.speedMultiplier + 'x'
      : msg('skip');
    const modeVal = $('#sc-mode-val');
    if (modeVal) modeVal.textContent = modeText;

    const silVal = $('#sc-sil-val');
    if (silVal) silVal.textContent = settings.silenceEnabled ? msg('on') : msg('off');

    const musVal = $('#sc-mus-val');
    if (musVal) musVal.textContent = settings.musicEnabled ? msg('on') : msg('off');

    $$<HTMLElement>('.sc-mode-opt').forEach((opt) => {
      opt.classList.toggle('selected', opt.dataset.value === settings!.actionMode);
    });

    $('#sc-speed-inline')?.classList.toggle('hidden', !isSpeed);
    const speedSlider = $<HTMLInputElement>('#sc-speed');
    if (speedSlider) speedSlider.value = String(settings.speedMultiplier);
    const speedBig = $('#sc-speed-big');
    if (speedBig) speedBig.textContent = settings.speedMultiplier + 'x';

    // Silence page
    $('#sc-sil-toggle')?.setAttribute(
      'aria-checked',
      settings.silenceEnabled ? 'true' : 'false',
    );
    const thresholdText = settings.silenceThreshold + ' dB';
    const thresholdSlider = $<HTMLInputElement>('#sc-threshold');
    if (thresholdSlider) thresholdSlider.value = String(settings.silenceThreshold);
    const thresholdVal = $('#sc-threshold-val');
    if (thresholdVal) thresholdVal.textContent = thresholdText;
    const thresholdMenu = $('#sc-threshold-menu');
    if (thresholdMenu) thresholdMenu.textContent = thresholdText;

    const silDurText = settings.minSilenceDuration + 's';
    const silDurSlider = $<HTMLInputElement>('#sc-sil-dur');
    if (silDurSlider) silDurSlider.value = String(settings.minSilenceDuration);
    const silDurVal = $('#sc-sil-dur-val');
    if (silDurVal) silDurVal.textContent = silDurText;
    const silDurMenu = $('#sc-sil-dur-menu');
    if (silDurMenu) silDurMenu.textContent = silDurText;

    // Music page
    $('#sc-mus-toggle')?.setAttribute(
      'aria-checked',
      settings.musicEnabled ? 'true' : 'false',
    );
    const sensText = '%' + Math.round(settings.musicSensitivity * 100);
    const musSensSlider = $<HTMLInputElement>('#sc-mus-sens');
    if (musSensSlider) musSensSlider.value = String(settings.musicSensitivity);
    const musSensVal = $('#sc-mus-sens-val');
    if (musSensVal) musSensVal.textContent = sensText;
    const musSensMenu = $('#sc-mus-sens-menu');
    if (musSensMenu) musSensMenu.textContent = sensText;

    const musDurText = settings.minMusicDuration + 's';
    const musDurSlider = $<HTMLInputElement>('#sc-mus-dur');
    if (musDurSlider) musDurSlider.value = String(settings.minMusicDuration);
    const musDurVal = $('#sc-mus-dur-val');
    if (musDurVal) musDurVal.textContent = musDurText;
    const musDurMenu = $('#sc-mus-dur-menu');
    if (musDurMenu) musDurMenu.textContent = musDurText;

    // Update all slider fills
    (
      ['#sc-speed', '#sc-threshold', '#sc-sil-dur', '#sc-mus-sens', '#sc-mus-dur'] as const
    ).forEach((id) => updateSliderFill($<HTMLInputElement>(id)));

    updateThresholdLine();
    updateButtonState();
  }

  function updateThresholdLine(): void {
    if (!panelHost) return;
    const val = parseInt(
      $<HTMLInputElement>('#sc-threshold')?.value ?? '-40',
    );
    const pct = ((val + 60) / 50) * 100;
    const line = $<HTMLElement>('#sc-thr-line');
    if (line) line.style.left = pct + '%';
  }

  function updateStatus(): void {
    if (!panelHost || !isOpen) return;

    const isLive = statusData.active && statusData.isAtLiveEdge;
    const dot = $<HTMLElement>('#sc-dot');
    if (dot)
      dot.className =
        'sc-dot' +
        (statusData.active ? (isLive ? ' live' : ' active') : '');

    const el = $('#sc-status-text');
    if (el)
      el.textContent = isLive
        ? msg('liveEdge')
        : statusData.active
          ? msg('active')
          : msg('inactive');

    const skipEl = $('#sc-skip-count');
    if (skipEl)
      skipEl.textContent = msg('skipCount', [
        String(statusData.skippedCount || 0),
      ]);

    const tsEl = $('#sc-time-saved');
    if (tsEl) tsEl.textContent = formatTimeSaved(statusData.timeSavedMs || 0);

    const db = statusData.currentVolumeDB;
    const volBar = $<HTMLElement>('#sc-vol-bar');
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

    const tagSil = $<HTMLElement>('#sc-tag-sil');
    const tagMus = $<HTMLElement>('#sc-tag-mus');
    const tagSpeech = $<HTMLElement>('#sc-tag-speech');
    if (tagSil)
      tagSil.classList.toggle(
        'hidden',
        !statusData.isInSilence || statusData.skipReason !== 'silence',
      );
    if (tagMus) tagMus.classList.toggle('hidden', !statusData.isMusic);
    const isSpeech =
      statusData.active &&
      !statusData.isInSilence &&
      !statusData.isMusic &&
      statusData.currentVolumeDB > -Infinity &&
      statusData.currentVolumeDB > (settings?.silenceThreshold ?? -40);
    if (tagSpeech) tagSpeech.classList.toggle('hidden', !isSpeech);

    // Debug features panel
    const f = statusData.features;
    if (f) {
      const s = (id: string, val: string): void => {
        const el = $(`#${id}`);
        if (el) el.textContent = val;
      };
      s('sc-dbg-zcr', f.zcr?.toFixed(4) ?? '--');
      s('sc-dbg-zcrvar', f.zcrVariance?.toFixed(6) ?? '--');
      s('sc-dbg-flat', f.spectralFlatness?.toFixed(4) ?? '--');
      s('sc-dbg-speech', f.speechBandRatio?.toFixed(4) ?? '--');
      s(
        'sc-dbg-centroid',
        f.spectralCentroid ? Math.round(f.spectralCentroid) + ' Hz' : '--',
      );
      s(
        'sc-dbg-spread',
        f.spectralSpread ? Math.round(f.spectralSpread) + ' Hz' : '--',
      );
      s(
        'sc-dbg-rolloff',
        f.spectralRolloff ? Math.round(f.spectralRolloff) + ' Hz' : '--',
      );
      s('sc-dbg-flux', f.spectralFlux?.toFixed(2) ?? '--');
    }
  }

  function updateButtonState(): void {
    if (!buttonEl) return;
    buttonEl.setAttribute(
      'aria-pressed',
      settings?.enabled ? 'true' : 'false',
    );
    const svg = buttonEl.querySelector('svg path');
    if (svg)
      svg.setAttribute('fill-opacity', settings?.enabled ? '1' : '0.5');
  }

  // --- Panel Events ---

  function bindPanelEvents(): void {
    if (!panelHost) return;

    panelHost
      .querySelector('.sc-panel')
      ?.addEventListener('keydown', (e) => e.stopPropagation());

    $('#sc-enabled-item')?.addEventListener('click', () => {
      const item = $('#sc-enabled-item')!;
      const checked = item.getAttribute('aria-checked') !== 'true';
      item.setAttribute('aria-checked', checked ? 'true' : 'false');
      saveSettings();
    });

    $$<HTMLElement>('.ytp-menuitem[data-page]').forEach((item) => {
      item.addEventListener('click', () =>
        showPage(item.dataset.page!, false),
      );
    });

    $$('.sc-back').forEach((btn) => {
      btn.addEventListener('click', () => {
        const page = btn.closest<HTMLElement>('.sc-page');
        const backTarget = page?.dataset.back || 'main';
        applySettingsToUI();
        showPage(backTarget, true);
      });
    });

    $$<HTMLElement>('.sc-mode-opt').forEach((opt) => {
      opt.addEventListener('click', () => {
        settings!.actionMode = opt.dataset.value as Settings['actionMode'];
        saveSettings();
        applySettingsToUI();
      });
    });

    $<HTMLInputElement>('#sc-speed')?.addEventListener('input', () => {
      const speedSlider = $<HTMLInputElement>('#sc-speed')!;
      const speedBig = $('#sc-speed-big')!;
      speedBig.textContent = speedSlider.value + 'x';
      updateSliderFill(speedSlider);
      saveSettings();
      const modeVal = $('#sc-mode-val')!;
      modeVal.textContent =
        msg('speedUp') + ' \u00B7 ' + speedSlider.value + 'x';
    });

    // Silence page
    $('#sc-sil-toggle')?.addEventListener('click', () => {
      const el = $('#sc-sil-toggle')!;
      const checked = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', checked ? 'true' : 'false');
      saveSettings();
      applySettingsToUI();
    });

    $<HTMLInputElement>('#sc-threshold')?.addEventListener('input', () => {
      const slider = $<HTMLInputElement>('#sc-threshold')!;
      const text = slider.value + ' dB';
      $('#sc-threshold-val')!.textContent = text;
      $('#sc-threshold-menu')!.textContent = text;
      updateSliderFill(slider);
      updateThresholdLine();
      saveSettings();
    });

    $<HTMLInputElement>('#sc-sil-dur')?.addEventListener('input', () => {
      const slider = $<HTMLInputElement>('#sc-sil-dur')!;
      const text = parseFloat(slider.value).toFixed(1) + 's';
      $('#sc-sil-dur-val')!.textContent = text;
      $('#sc-sil-dur-menu')!.textContent = text;
      updateSliderFill(slider);
      saveSettings();
    });

    // Music page
    $('#sc-mus-toggle')?.addEventListener('click', () => {
      const el = $('#sc-mus-toggle')!;
      const checked = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', checked ? 'true' : 'false');
      saveSettings();
      applySettingsToUI();
    });

    $<HTMLInputElement>('#sc-mus-sens')?.addEventListener('input', () => {
      const slider = $<HTMLInputElement>('#sc-mus-sens')!;
      const text =
        '%' + Math.round(parseFloat(slider.value) * 100);
      $('#sc-mus-sens-val')!.textContent = text;
      $('#sc-mus-sens-menu')!.textContent = text;
      updateSliderFill(slider);
      saveSettings();
    });

    $<HTMLInputElement>('#sc-mus-dur')?.addEventListener('input', () => {
      const slider = $<HTMLInputElement>('#sc-mus-dur')!;
      const text = parseFloat(slider.value).toFixed(1) + 's';
      $('#sc-mus-dur-val')!.textContent = text;
      $('#sc-mus-dur-menu')!.textContent = text;
      updateSliderFill(slider);
      saveSettings();
    });

    // Generic +/- increment buttons
    $$<HTMLElement>(
      '.ytp-variable-speed-panel-increment-button[data-target]',
    ).forEach((btn) => {
      btn.addEventListener('click', () => {
        const slider = $<HTMLInputElement>('#' + btn.dataset.target!);
        if (!slider) return;
        const step = parseFloat(btn.dataset.step!);
        const val =
          Math.round((parseFloat(slider.value) + step) * 1000) / 1000;
        slider.value = String(
          Math.min(
            parseFloat(slider.max),
            Math.max(parseFloat(slider.min), val),
          ),
        );
        slider.dispatchEvent(new Event('input'));
      });
    });

    // Generic preset buttons
    $$<HTMLElement>(
      '.ytp-variable-speed-panel-preset-button[data-target]',
    ).forEach((btn) => {
      btn.addEventListener('click', () => {
        const slider = $<HTMLInputElement>('#' + btn.dataset.target!);
        if (!slider) return;
        slider.value = btn.dataset.value!;
        slider.dispatchEvent(new Event('input'));
      });
    });

    // Collapsible sections
    $$<HTMLElement>('.sc-collapsible-header').forEach((header) => {
      header.addEventListener('click', () => {
        header.classList.toggle('open');
        const body = header.nextElementSibling as HTMLElement | null;
        if (body) body.classList.toggle('hidden');
      });
    });
  }

  // --- Button ---

  function createButton(): HTMLButtonElement {
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

  // --- Panel ---

  function togglePanel(): void {
    isOpen = !isOpen;
    if (panelHost) {
      panelHost.style.display = isOpen ? '' : 'none';
      if (isOpen) {
        showPage('main', false);
        const player = document.querySelector<HTMLElement>('#movie_player');
        const panel = panelHost.querySelector<HTMLElement>('.sc-panel');
        if (player && panel) {
          const availableHeight = player.clientHeight - 72;
          panel.style.maxHeight = availableHeight + 'px';
        }
        applySettingsToUI();
        updateStatus();
      }
    }
  }

  function closePanel(): void {
    if (!isOpen) return;
    isOpen = false;
    if (panelHost) panelHost.style.display = 'none';
  }

  // --- Injection ---

  async function inject(): Promise<void> {
    const rightControls = document.querySelector('.ytp-right-controls');
    const player = document.querySelector('#movie_player');
    if (!rightControls || !player) return;
    if (rightControls.querySelector('.silence-cut-btn')) return;

    player
      .querySelectorAll('.silence-cut-panel-host')
      .forEach((el) => el.remove());

    buttonEl = createButton();
    const settingsBtn = rightControls.querySelector('.ytp-settings-button');
    if (settingsBtn) {
      settingsBtn.parentNode!.insertBefore(buttonEl, settingsBtn);
    } else {
      rightControls.appendChild(buttonEl);
    }

    panelHost = document.createElement('div');
    panelHost.className = 'ytp-popup silence-cut-panel-host';
    panelHost.style.cssText =
      'position:absolute;bottom:60px;right:12px;z-index:69;display:none;';
    panelHost.innerHTML = await loadTemplate();
    hydrateI18n(panelHost);

    player.appendChild(panelHost);

    bindPanelEvents();
    applySettingsToUI();
    registerGlobalEvents();
  }

  function registerGlobalEvents(): void {
    if (globalEventsRegistered) return;
    globalEventsRegistered = true;

    document.addEventListener('click', (e) => {
      if (!isOpen) return;
      const path = e.composedPath();
      if (
        (panelHost && path.includes(panelHost)) ||
        (buttonEl && path.includes(buttonEl))
      )
        return;
      closePanel();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) closePanel();
    });
  }

  // --- Status from audio-analyzer (MAIN world) ---

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    try {
      if (!chrome.runtime?.id) return;
    } catch {
      return;
    }

    const msg = event.data as AnalyzerMessage;
    if (msg.type === 'SILENCE_CUT_VOLUME_UPDATE') {
      statusData = {
        active: settings?.enabled ?? false,
        skippedCount: msg.skippedCount,
        timeSavedMs: msg.timeSavedMs,
        currentVolumeDB: msg.volumeDB,
        isInSilence: msg.isInSilence,
        skipReason: msg.skipReason,
        isMusic: msg.isMusic,
        isAtLiveEdge: msg.isAtLiveEdge ?? false,
        features: msg.features ?? null,
      };
      if (isOpen) updateStatus();
      updateButtonState();
    }
  });

  // --- External settings changes (from popup) ---

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      settings = changes.settings.newValue as Settings;
      if (isOpen) applySettingsToUI();
      updateButtonState();
    }
  });

  // --- YouTube SPA navigation ---

  function observe(): void {
    document.addEventListener('yt-navigate-finish', () => {
      setTimeout(inject, 500);
    });

    const observer = new MutationObserver(() => {
      const rightControls = document.querySelector('.ytp-right-controls');
      if (
        rightControls &&
        !rightControls.querySelector('.silence-cut-btn')
      ) {
        inject();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- Template ---

  let templateCache: string | null = null;

  async function loadTemplate(): Promise<string> {
    if (templateCache) return templateCache;
    const [html, css] = await Promise.all([
      fetch(chrome.runtime.getURL('content/panel.html')).then((r) =>
        r.text(),
      ),
      fetch(chrome.runtime.getURL('content/panel.css')).then((r) =>
        r.text(),
      ),
    ]);
    templateCache = `<style>${css}</style>${html}`;
    return templateCache;
  }

  function hydrateI18n(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n!;
      const args = el.dataset.i18nArgs
        ? JSON.parse(el.dataset.i18nArgs)
        : undefined;
      el.textContent = msg(key, args);
    });
    root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
      el.setAttribute('aria-label', msg(el.dataset.i18nAria!));
    });
  }

  // --- Init ---

  loadSettings().then(() => {
    observe();
    inject();
  });
})();
