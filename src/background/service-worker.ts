import type { Settings, RuntimeMessage } from '../types';

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

function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get('settings', (data) => {
    chrome.storage.sync.set({
      settings: mergeSettings(data.settings as Partial<Settings> | undefined),
    });
  });
});

// Toggle enabled on toolbar icon click
chrome.action.onClicked.addListener(async (tab) => {
  const data = await chrome.storage.sync.get('settings');
  const current = mergeSettings(data.settings as Partial<Settings> | undefined);
  current.enabled = !current.enabled;
  await chrome.storage.sync.set({ settings: current });

  if (tab?.id) {
    chrome.tabs
      .sendMessage(tab.id, {
        type: 'TOGGLE_ENABLED',
        enabled: current.enabled,
      } satisfies RuntimeMessage)
      .catch(() => {});
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: RuntimeMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (message.type === 'GET_SETTINGS') {
      chrome.storage.sync.get('settings', (data) => {
        sendResponse(
          mergeSettings(data.settings as Partial<Settings> | undefined),
        );
      });
      return true; // keep channel open for async response
    }

    if (message.type === 'UPDATE_BADGE') {
      const tabId = message.tabId ?? sender.tab?.id;
      if (!tabId) return;

      chrome.action.setBadgeText({
        text: message.enabled ? 'ON' : 'OFF',
        tabId,
      });
      chrome.action.setBadgeBackgroundColor({
        color: message.enabled ? '#4CAF50' : '#9E9E9E',
        tabId,
      });
    }
  },
);
