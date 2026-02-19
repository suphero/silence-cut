document.addEventListener('DOMContentLoaded', async () => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // --- i18n ---

  const msg = chrome.i18n.getMessage;

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = msg(el.dataset.i18n);
  });

  document.documentElement.lang = chrome.i18n.getUILanguage().startsWith('tr') ? 'tr' : 'en';

  // --- DOM Elements ---

  const enabledToggle = $('#enabled-toggle');
  const actionModeRadios = $$('input[name="actionMode"]');
  const speedGroup = $('#speed-group');
  const speedSlider = $('#speed-slider');
  const speedValue = $('#speed-value');

  // Silence
  const silenceToggle = $('#silence-toggle');
  const silenceSettings = $('#silence-settings');
  const thresholdSlider = $('#threshold-slider');
  const thresholdValue = $('#threshold-value');
  const silenceDurationSlider = $('#silence-duration-slider');
  const silenceDurationValue = $('#silence-duration-value');

  // Music
  const musicToggle = $('#music-toggle');
  const musicSettings = $('#music-settings');
  const musicSensitivitySlider = $('#music-sensitivity-slider');
  const musicSensitivityValue = $('#music-sensitivity-value');
  const musicDurationSlider = $('#music-duration-slider');
  const musicDurationValue = $('#music-duration-value');

  // Status
  const statusDot = $('#status-dot');
  const statusText = $('#status-text');
  const skipCount = $('#skip-count');
  const timeSavedEl = $('#time-saved');
  const volumeBar = $('#volume-bar');
  const volumeDb = $('#volume-db');
  const thresholdLine = $('#threshold-line');
  const tagSilence = $('#tag-silence');
  const tagMusic = $('#tag-music');

  // Set initial status text
  statusText.textContent = msg('waiting');
  skipCount.textContent = msg('skipCount', ['0']);

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

  // --- Default Settings ---

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

  // --- Load Settings ---

  const { settings } = await chrome.storage.sync.get('settings');
  const st = { ...DEFAULT_SETTINGS, ...(settings || {}) };

  enabledToggle.checked = st.enabled;
  silenceToggle.checked = st.silenceEnabled;
  musicToggle.checked = st.musicEnabled;

  thresholdSlider.value = st.silenceThreshold;
  thresholdValue.textContent = st.silenceThreshold + ' dB';
  silenceDurationSlider.value = st.minSilenceDuration;
  silenceDurationValue.textContent = st.minSilenceDuration + 's';

  musicSensitivitySlider.value = st.musicSensitivity;
  musicSensitivityValue.textContent = '%' + Math.round(st.musicSensitivity * 100);
  musicDurationSlider.value = st.minMusicDuration;
  musicDurationValue.textContent = st.minMusicDuration + 's';

  speedSlider.value = st.speedMultiplier;
  speedValue.textContent = st.speedMultiplier + 'x';

  actionModeRadios.forEach((r) => {
    r.checked = r.value === st.actionMode;
  });

  speedGroup.classList.toggle('hidden', st.actionMode !== 'speed');
  silenceSettings.classList.toggle('collapsed', !st.silenceEnabled);
  musicSettings.classList.toggle('collapsed', !st.musicEnabled);
  updateThresholdLine();

  // --- Save Settings ---

  function getSettings() {
    let mode = 'skip';
    actionModeRadios.forEach((r) => {
      if (r.checked) mode = r.value;
    });

    return {
      enabled: enabledToggle.checked,
      silenceEnabled: silenceToggle.checked,
      silenceThreshold: parseInt(thresholdSlider.value),
      minSilenceDuration: parseFloat(silenceDurationSlider.value),
      musicEnabled: musicToggle.checked,
      musicSensitivity: parseFloat(musicSensitivitySlider.value),
      minMusicDuration: parseFloat(musicDurationSlider.value),
      actionMode: mode,
      speedMultiplier: parseInt(speedSlider.value)
    };
  }

  async function save() {
    const newSettings = getSettings();
    await chrome.storage.sync.set({ settings: newSettings });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'SETTINGS_CHANGED',
        settings: newSettings
      }).catch(() => {});
    }
  }

  // --- Event Bindings ---

  enabledToggle.addEventListener('change', save);

  // Silence controls
  silenceToggle.addEventListener('change', () => {
    silenceSettings.classList.toggle('collapsed', !silenceToggle.checked);
    save();
  });

  thresholdSlider.addEventListener('input', () => {
    thresholdValue.textContent = thresholdSlider.value + ' dB';
    updateThresholdLine();
    save();
  });

  silenceDurationSlider.addEventListener('input', () => {
    silenceDurationValue.textContent = parseFloat(silenceDurationSlider.value).toFixed(1) + 's';
    save();
  });

  // Music controls
  musicToggle.addEventListener('change', () => {
    musicSettings.classList.toggle('collapsed', !musicToggle.checked);
    save();
  });

  musicSensitivitySlider.addEventListener('input', () => {
    musicSensitivityValue.textContent = '%' + Math.round(parseFloat(musicSensitivitySlider.value) * 100);
    save();
  });

  musicDurationSlider.addEventListener('input', () => {
    musicDurationValue.textContent = parseFloat(musicDurationSlider.value).toFixed(1) + 's';
    save();
  });

  // Action mode
  speedSlider.addEventListener('input', () => {
    speedValue.textContent = speedSlider.value + 'x';
    save();
  });

  actionModeRadios.forEach((r) => {
    r.addEventListener('change', () => {
      speedGroup.classList.toggle('hidden', r.value !== 'speed');
      save();
    });
  });

  // --- Threshold Line ---

  function updateThresholdLine() {
    const val = parseInt(thresholdSlider.value);
    const pct = ((val - (-60)) / ((-10) - (-60))) * 100;
    thresholdLine.style.left = pct + '%';
  }

  // --- Status Polling ---

  async function pollStatus() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;

      const status = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
      if (!status) return;

      statusDot.className = 'status-dot' + (status.active ? ' active' : '');
      statusText.textContent = status.active ? msg('active') : msg('inactive');
      skipCount.textContent = msg('skipCount', [String(status.skippedCount || 0)]);
      timeSavedEl.textContent = formatTimeSaved(status.timeSavedMs || 0);

      // Volume meter
      const db = status.currentVolumeDB;
      if (db != null && db !== -Infinity) {
        const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
        volumeBar.style.width = pct + '%';
        volumeDb.textContent = db.toFixed(1) + ' dB';
      } else {
        volumeBar.style.width = '0%';
        volumeDb.textContent = '-- dB';
      }

      // Detection tags
      tagSilence.classList.toggle('hidden', !status.isInSilence || status.skipReason !== 'silence');
      tagMusic.classList.toggle('hidden', !status.isMusic);
    } catch {
      statusDot.className = 'status-dot';
      statusText.textContent = msg('notYoutube');
      skipCount.textContent = '';
      timeSavedEl.textContent = '0s';
      volumeBar.style.width = '0%';
      volumeDb.textContent = '-- dB';
      tagSilence.classList.add('hidden');
      tagMusic.classList.add('hidden');
    }
  }

  setInterval(pollStatus, 250);
  pollStatus();
});
