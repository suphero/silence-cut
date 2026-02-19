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

// Merge stored settings with defaults so new fields always have values
function mergeSettings(stored) {
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get('settings', (data) => {
    chrome.storage.sync.set({ settings: mergeSettings(data.settings) });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_SETTINGS') {
    chrome.storage.sync.get('settings', (data) => {
      sendResponse(mergeSettings(data.settings));
    });
    return true;
  }

  if (message.type === 'UPDATE_BADGE') {
    const tabId = message.tabId || sender.tab?.id;
    if (!tabId) return;

    chrome.action.setBadgeText({
      text: message.enabled ? 'ON' : 'OFF',
      tabId
    });
    chrome.action.setBadgeBackgroundColor({
      color: message.enabled ? '#4CAF50' : '#9E9E9E',
      tabId
    });
  }
});
