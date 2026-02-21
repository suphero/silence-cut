import type {
  Settings,
  Status,
  AnalyzerMessage,
  RuntimeMessage,
} from '../types';
import { DEFAULT_SETTINGS } from '../settings';

(function () {
  'use strict';

  let currentSettings: Settings | null = null;
  let currentStatus: Status = {
    active: false,
    skippedCount: 0,
    timeSavedMs: 0,
    currentVolumeDB: -Infinity,
    isInSilence: false,
    skipReason: null,
    isMusic: false,
    isAtLiveEdge: false,
  };

  // --- Settings ---

  async function loadSettings(): Promise<Settings> {
    return new Promise((resolve) => {
      chrome.storage.sync.get('settings', (data) => {
        currentSettings = {
          ...DEFAULT_SETTINGS,
          ...((data.settings as Partial<Settings>) || {}),
        };
        resolve(currentSettings);
      });
    });
  }

  function sendToAnalyzer(data: AnalyzerMessage): void {
    window.postMessage(data, '*');
  }

  // --- Messages from MAIN world (audio-analyzer.js) ---

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;

    const msg = event.data as AnalyzerMessage;

    if (msg.type === 'SILENCE_CUT_VOLUME_UPDATE') {
      currentStatus = {
        active: currentSettings?.enabled ?? false,
        skippedCount: msg.skippedCount,
        timeSavedMs: msg.timeSavedMs,
        currentVolumeDB: msg.volumeDB,
        isInSilence: msg.isInSilence,
        skipReason: msg.skipReason,
        isMusic: msg.isMusic,
        isAtLiveEdge: msg.isAtLiveEdge ?? false,
      };
    }

    if (msg.type === 'SILENCE_CUT_ANALYZER_READY') {
      if (currentSettings) {
        sendToAnalyzer({
          type: 'SILENCE_CUT_INIT',
          settings: currentSettings,
        });
      }
    }
  });

  // --- Messages from popup / service worker ---

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as RuntimeMessage;

    if (msg.type === 'GET_STATUS') {
      sendResponse(currentStatus);
      return undefined;
    }

    if (msg.type === 'SETTINGS_CHANGED') {
      currentSettings = msg.settings;
      sendToAnalyzer({
        type: 'SILENCE_CUT_UPDATE_SETTINGS',
        settings: currentSettings,
      });
      updateBadge();
      sendResponse({ success: true });
      return undefined;
    }

    if (msg.type === 'TOGGLE_ENABLED') {
      if (currentSettings) {
        currentSettings.enabled = msg.enabled;
        chrome.storage.sync.set({ settings: currentSettings });
        sendToAnalyzer({
          type: 'SILENCE_CUT_UPDATE_SETTINGS',
          settings: currentSettings,
        });
        updateBadge();
      }
      sendResponse({ success: true });
      return undefined;
    }

    return undefined;
  });

  // --- Badge ---

  function updateBadge(): void {
    chrome.runtime
      .sendMessage({
        type: 'UPDATE_BADGE',
        enabled: currentSettings?.enabled ?? false,
      } satisfies RuntimeMessage)
      .catch(() => {});
  }

  // --- Storage changes (from popup) ---

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      currentSettings = changes.settings.newValue as Settings;
      sendToAnalyzer({
        type: 'SILENCE_CUT_UPDATE_SETTINGS',
        settings: currentSettings,
      });
      updateBadge();
    }
  });

  // --- Init ---

  async function initialize(): Promise<void> {
    const settings = await loadSettings();
    updateBadge();
    sendToAnalyzer({ type: 'SILENCE_CUT_INIT', settings });
  }

  initialize();
})();
