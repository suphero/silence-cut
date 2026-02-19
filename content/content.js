(function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    enabled: true,
    silenceEnabled: true,
    silenceThreshold: -40,
    minSilenceDuration: 0.5,
    musicEnabled: false,
    musicSensitivity: 0.5,
    minMusicDuration: 1.0,
    actionMode: 'skip',
    speedMultiplier: 4
  };

  let currentSettings = null;
  let currentStatus = {
    active: false,
    skippedCount: 0,
    timeSavedMs: 0,
    currentVolumeDB: -Infinity,
    isInSilence: false,
    skipReason: null,
    isMusic: false
  };

  // --- Settings ---

  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get('settings', (data) => {
        currentSettings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
        resolve(currentSettings);
      });
    });
  }

  function sendToAnalyzer(data) {
    window.postMessage(data, '*');
  }

  // --- Messages from MAIN world (audio-analyzer.js) ---

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data.type === 'SILENCE_CUT_VOLUME_UPDATE') {
      currentStatus = {
        active: currentSettings?.enabled ?? false,
        skippedCount: event.data.skippedCount,
        timeSavedMs: event.data.timeSavedMs,
        currentVolumeDB: event.data.volumeDB,
        isInSilence: event.data.isInSilence,
        skipReason: event.data.skipReason,
        isMusic: event.data.isMusic
      };
    }

    if (event.data.type === 'SILENCE_CUT_ANALYZER_READY') {
      if (currentSettings) {
        sendToAnalyzer({
          type: 'SILENCE_CUT_INIT',
          settings: currentSettings
        });
      }
    }
  });

  // --- Messages from popup / service worker ---

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_STATUS') {
      sendResponse(currentStatus);
      return;
    }

    if (message.type === 'SETTINGS_CHANGED') {
      currentSettings = message.settings;
      sendToAnalyzer({
        type: 'SILENCE_CUT_UPDATE_SETTINGS',
        settings: currentSettings
      });
      updateBadge();
      sendResponse({ success: true });
      return;
    }

    if (message.type === 'TOGGLE_ENABLED') {
      if (currentSettings) {
        currentSettings.enabled = message.enabled;
        chrome.storage.sync.set({ settings: currentSettings });
        sendToAnalyzer({
          type: 'SILENCE_CUT_UPDATE_SETTINGS',
          settings: currentSettings
        });
        updateBadge();
      }
      sendResponse({ success: true });
      return;
    }
  });

  // --- Badge ---

  function updateBadge() {
    chrome.runtime.sendMessage({
      type: 'UPDATE_BADGE',
      enabled: currentSettings?.enabled ?? false
    }).catch(() => {});
  }

  // --- Storage changes (from popup) ---

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      currentSettings = changes.settings.newValue;
      sendToAnalyzer({
        type: 'SILENCE_CUT_UPDATE_SETTINGS',
        settings: currentSettings
      });
      updateBadge();
    }
  });

  // --- Init ---

  async function initialize() {
    const settings = await loadSettings();
    updateBadge();
    sendToAnalyzer({ type: 'SILENCE_CUT_INIT', settings });
  }

  initialize();
})();
