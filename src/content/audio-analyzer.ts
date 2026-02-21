import type {
  Settings,
  SpectralFeatures,
  DebugFeatures,
  SkipReason,
  AnalyzerMessage,
  AudioNodeCacheEntry,
} from '../types';
import {
  computeTimeDomain,
  compensateVolume,
  computeSpectrum,
  computeSkipIntensity,
  computeZcrVariance,
  DEFAULT_SPECTRUM,
} from '../audio-math';

declare global {
  interface Window {
    __silenceCutVersion?: number;
  }
}

(function () {
  'use strict';

  // Version-gated init guard: allows re-init when extension is updated/reloaded
  const SCRIPT_VERSION = 3;
  if (window.__silenceCutVersion === SCRIPT_VERSION) return;
  window.__silenceCutVersion = SCRIPT_VERSION;

  const ANALYSIS_INTERVAL_MS = 50;
  const SKIP_INCREMENT = 0.5;
  const MUSIC_REENTRY_GRACE = 10; // seconds – trust music context for this long

  // Rolling buffer sizes
  const FLATNESS_BUFFER_SIZE = 8;
  const ZCR_BUFFER_SIZE = 16; // ~800ms of history at 50ms intervals

  // WeakMap: video element -> { audioContext, sourceNode }
  const audioNodeCache = new WeakMap<HTMLVideoElement, AudioNodeCacheEntry>();

  let settings: Settings = {
    enabled: true,
    silenceEnabled: true,
    silenceThreshold: -40,
    minSilenceDuration: 0.5,
    musicEnabled: false,
    musicSensitivity: 0.5,
    minMusicDuration: 1.0,
    actionMode: 'skip',
    speedMultiplier: 4,
  };

  let analyserNode: AnalyserNode | null = null;
  let videoElement: HTMLVideoElement | null = null;
  let analysisInterval: ReturnType<typeof setInterval> | null = null;

  // Silence state
  let silenceStartTime: number | null = null;
  let isInSilence = false;

  // Music state
  let musicStartTime: number | null = null;
  let isInMusic = false;

  // Shared
  let isSkipping = false; // currently taking action (silence or music)
  let skippedCount = 0;
  let skipReason: SkipReason = null;
  let timeSavedMs = 0; // total time saved in milliseconds
  let originalPlaybackRate = 1; // video's playback rate before speed-up
  let lastMusicSkipEnd = 0; // timestamp when last music-skip ended
  let musicBaselineSpeechRatio = -1; // adaptive baseline for speech detection in music context

  // Rolling buffers for temporal smoothing
  let flatnessBuffer: number[] = [];
  let zcrBuffer: number[] = [];
  let previousFreqData: Uint8Array<ArrayBuffer> | null = null; // for spectral flux calculation
  let lastFeatures: DebugFeatures | null = null; // debug: latest computed features

  // Pre-allocated buffers for hot-path analysis (avoid GC pressure at 20Hz)
  let timeDomainBuffer: Float32Array<ArrayBuffer> | null = null;
  let freqDataBuffer: Uint8Array<ArrayBuffer> | null = null;

  // --- Audio Setup ---

  function setupAudio(video: HTMLVideoElement): void {
    if (video === videoElement && analyserNode) return;

    stopAnalysis();
    videoElement = video;

    const cached = audioNodeCache.get(video);

    if (cached) {
      const { audioContext, sourceNode } = cached;
      if (audioContext.state === 'suspended') audioContext.resume();
      try {
        sourceNode.disconnect();
      } catch (_) {}

      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 2048;
      analyserNode.smoothingTimeConstant = 0.3;

      sourceNode.connect(analyserNode);
      analyserNode.connect(audioContext.destination);
      return;
    }

    try {
      const audioContext = new AudioContext();
      const sourceNode = audioContext.createMediaElementSource(video);

      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 2048;
      analyserNode.smoothingTimeConstant = 0.3;

      sourceNode.connect(analyserNode);
      analyserNode.connect(audioContext.destination);

      audioNodeCache.set(video, { audioContext, sourceNode });
    } catch (e) {
      console.warn('[Silence Cut] Audio setup failed:', (e as Error).message);
      analyserNode = null;
    }
  }

  function stopAnalysis(): void {
    if (analysisInterval) {
      clearInterval(analysisInterval);
      analysisInterval = null;
    }
    if (isSkipping) exitSkip();
    analyserNode = null;
    flatnessBuffer = [];
    zcrBuffer = [];
    previousFreqData = null;
    lastFeatures = null;
    timeDomainBuffer = null;
    freqDataBuffer = null;
    musicBaselineSpeechRatio = -1;
  }

  // --- Time-Domain Analysis (Volume + ZCR) ---

  function analyzeTimeDomain(): { volumeDB: number; zcr: number } {
    if (!analyserNode) return { volumeDB: -Infinity, zcr: 0 };

    const size = analyserNode.fftSize;
    if (!timeDomainBuffer || timeDomainBuffer.length !== size) {
      timeDomainBuffer = new Float32Array(size);
    }
    const buffer = timeDomainBuffer;
    analyserNode.getFloatTimeDomainData(buffer);

    const result = computeTimeDomain(buffer);
    let volumeDB = result.volumeDB;

    // Compensate for the video element's volume setting.
    if (videoElement) {
      volumeDB = compensateVolume(volumeDB, videoElement.volume);
    }

    return { volumeDB, zcr: result.zcr };
  }

  // --- Spectrum Analysis ---

  function analyzeSpectrum(): SpectralFeatures {
    if (!analyserNode) return DEFAULT_SPECTRUM;

    const freqBins = analyserNode.frequencyBinCount;
    if (!freqDataBuffer || freqDataBuffer.length !== freqBins) {
      freqDataBuffer = new Uint8Array(freqBins);
    }
    const freqData = freqDataBuffer;
    analyserNode.getByteFrequencyData(freqData);

    const cached = videoElement && audioNodeCache.get(videoElement);
    const sampleRate = cached?.audioContext.sampleRate ?? 44100;

    const result = computeSpectrum(
      freqData,
      sampleRate,
      analyserNode.fftSize,
      previousFreqData,
    );

    if (!previousFreqData) previousFreqData = new Uint8Array(freqBins);
    previousFreqData.set(freqData);

    return result;
  }

  // --- Music Detection (Hierarchical) ---

  function isMusicDetected(volumeDB: number, zcr: number): boolean {
    if (volumeDB < settings.silenceThreshold + 10) {
      lastFeatures = null;
      return false;
    }

    const spectrum = analyzeSpectrum();

    flatnessBuffer.push(spectrum.spectralFlatness);
    if (flatnessBuffer.length > FLATNESS_BUFFER_SIZE) flatnessBuffer.shift();

    zcrBuffer.push(zcr);
    if (zcrBuffer.length > ZCR_BUFFER_SIZE) zcrBuffer.shift();

    const zcrVariance = computeZcrVariance(zcrBuffer);

    const sens = settings.musicSensitivity;

    lastFeatures = {
      zcr,
      zcrVariance,
      spectralFlatness: spectrum.spectralFlatness,
      speechBandRatio: spectrum.speechBandRatio,
      spectralCentroid: spectrum.spectralCentroid,
      spectralSpread: spectrum.spectralSpread,
      spectralRolloff: spectrum.spectralRolloff,
      spectralFlux: spectrum.spectralFlux,
    };

    // --- Context mode ---
    const now = performance.now() / 1000;
    const inMusicContext =
      lastMusicSkipEnd > 0 && now - lastMusicSkipEnd < MUSIC_REENTRY_GRACE;

    if (inMusicContext && musicBaselineSpeechRatio >= 0) {
      const elevationThreshold = 1.15 + (1 - sens) * 0.2;
      const isElevated =
        spectrum.speechBandRatio >
        musicBaselineSpeechRatio * elevationThreshold;

      const zcrContextVeto =
        zcrBuffer.length >= 4 && zcrVariance > 0.008 - sens * 0.003;

      if (isElevated || zcrContextVeto) return false;

      musicBaselineSpeechRatio =
        0.95 * musicBaselineSpeechRatio + 0.05 * spectrum.speechBandRatio;
      return true;
    }

    // --- Full detection ---
    const avgFlatness =
      flatnessBuffer.reduce((a, b) => a + b, 0) / flatnessBuffer.length;

    const flatnessThreshold = 0.7 - sens * 0.4;
    const speechRatioThreshold = 0.25 + sens * 0.3;

    const zcrVarThreshold = 0.006 - sens * 0.003;
    const hasEnoughZCR = zcrBuffer.length >= 4;
    const zcrStable = !hasEnoughZCR || zcrVariance <= zcrVarThreshold;
    const zcrVeto = hasEnoughZCR && zcrVariance > zcrVarThreshold * 2;

    const spreadThreshold = 2500 - sens * 1000;
    const rolloffThreshold = 5000 - sens * 1500;
    const spectralBoost =
      spectrum.spectralSpread > spreadThreshold &&
      spectrum.spectralRolloff > rolloffThreshold;

    const flatnessPass = avgFlatness > flatnessThreshold;
    const speechRatioPass = spectrum.speechBandRatio < speechRatioThreshold;

    let isMusic: boolean;

    if (zcrVeto) {
      isMusic = false;
    } else if (flatnessPass && speechRatioPass) {
      isMusic = zcrStable;
    } else if (flatnessPass && spectralBoost && zcrStable) {
      isMusic = spectrum.speechBandRatio < speechRatioThreshold * 1.2;
    } else {
      isMusic = false;
    }

    if (isMusic) {
      if (musicBaselineSpeechRatio < 0) {
        musicBaselineSpeechRatio = spectrum.speechBandRatio;
      } else {
        musicBaselineSpeechRatio =
          0.95 * musicBaselineSpeechRatio + 0.05 * spectrum.speechBandRatio;
      }
    }

    return isMusic;
  }

  // --- Live Stream Detection ---

  function isAtLiveEdge(): boolean {
    if (!videoElement) return false;
    return !!document.querySelector('.ytp-live-badge-is-livehead');
  }

  // --- Analysis Loop ---

  function startAnalysis(): void {
    if (analysisInterval) return;

    analysisInterval = setInterval(() => {
      if (!settings.enabled || !videoElement || videoElement.paused) {
        if (isSkipping) exitSkip();
        return;
      }

      if (videoElement.muted || videoElement.volume === 0) {
        if (isSkipping) exitSkip();
        return;
      }

      const cached = videoElement && audioNodeCache.get(videoElement);
      if (cached?.audioContext.state === 'suspended') {
        cached.audioContext.resume();
      }

      const { volumeDB, zcr } = analyzeTimeDomain();
      const now = performance.now() / 1000;

      // --- Silence detection ---
      const isSilent =
        settings.silenceEnabled && volumeDB < settings.silenceThreshold;

      if (isSilent && !isInSilence) {
        silenceStartTime = now;
        isInSilence = true;
      } else if (!isSilent && isInSilence) {
        isInSilence = false;
        silenceStartTime = null;
      }

      const silenceReady =
        isInSilence &&
        silenceStartTime !== null &&
        now - silenceStartTime >= settings.minSilenceDuration;

      // --- Music detection ---
      const musicDetected =
        settings.musicEnabled && isMusicDetected(volumeDB, zcr);

      if (musicDetected && !isInMusic) {
        musicStartTime = now;
        isInMusic = true;
      } else if (!musicDetected && isInMusic) {
        isInMusic = false;
        musicStartTime = null;
      }

      const inMusicContext =
        lastMusicSkipEnd > 0 && now - lastMusicSkipEnd < MUSIC_REENTRY_GRACE;
      const effectiveMusicWait = inMusicContext
        ? settings.minSilenceDuration
        : settings.minMusicDuration;
      const musicReady =
        isInMusic &&
        musicStartTime !== null &&
        now - musicStartTime >= effectiveMusicWait;

      // --- Take action ---
      if (isAtLiveEdge()) {
        if (isSkipping) exitSkip();
        notify({
          type: 'SILENCE_CUT_VOLUME_UPDATE',
          volumeDB,
          isInSilence: false,
          skipReason: null,
          skippedCount,
          timeSavedMs,
          isMusic: isInMusic,
          isAtLiveEdge: true,
          features: lastFeatures,
        });
        return;
      }

      if (silenceReady || musicReady) {
        const reason: SkipReason = silenceReady ? 'silence' : 'music';
        if (!isSkipping) {
          if (settings.actionMode === 'speed') {
            originalPlaybackRate = videoElement.playbackRate;
          }
          skippedCount++;
        }
        if (!isSkipping || skipReason !== reason) {
          skipReason = reason;
        }
        isSkipping = true;
        handleSkip(volumeDB);
      } else if (isSkipping && !silenceReady && !musicReady) {
        exitSkip();
      }

      notify({
        type: 'SILENCE_CUT_VOLUME_UPDATE',
        volumeDB,
        isInSilence: isSkipping,
        skipReason,
        skippedCount,
        timeSavedMs,
        isMusic: isInMusic,
        isAtLiveEdge: false,
        features: lastFeatures,
      });
    }, ANALYSIS_INTERVAL_MS);
  }

  const RAMP_DB = 8;

  function handleSkip(volumeDB: number): void {
    if (!videoElement || videoElement.paused) return;

    const intensity = computeSkipIntensity(
      volumeDB,
      settings.silenceThreshold,
      RAMP_DB,
    );

    if (settings.actionMode === 'skip') {
      const increment = SKIP_INCREMENT * Math.max(0.05, intensity);
      videoElement.currentTime += increment;
      timeSavedMs += increment * 1000;
    } else if (settings.actionMode === 'speed') {
      const targetRate =
        originalPlaybackRate +
        (settings.speedMultiplier - originalPlaybackRate) * intensity;
      videoElement.playbackRate = Math.max(originalPlaybackRate, targetRate);
      const savedPerTick =
        ANALYSIS_INTERVAL_MS * (videoElement.playbackRate - 1);
      if (savedPerTick > 0) timeSavedMs += savedPerTick;
    }
  }

  function exitSkip(): void {
    if (skipReason === 'music') {
      lastMusicSkipEnd = performance.now() / 1000;
    }
    isSkipping = false;
    skipReason = null;
    isInSilence = false;
    silenceStartTime = null;
    isInMusic = false;
    musicStartTime = null;

    if (settings.actionMode === 'speed' && videoElement) {
      videoElement.playbackRate = originalPlaybackRate;
    }
  }

  // --- Communication ---

  function notify(data: AnalyzerMessage): void {
    window.postMessage(data, '*');
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;

    const msg = event.data as AnalyzerMessage;
    switch (msg.type) {
      case 'SILENCE_CUT_UPDATE_SETTINGS':
        Object.assign(settings, msg.settings);
        if (!settings.enabled && isSkipping) exitSkip();
        break;

      case 'SILENCE_CUT_INIT':
        Object.assign(settings, msg.settings);
        initializeOnVideo();
        break;

      case 'SILENCE_CUT_TEARDOWN':
        stopAnalysis();
        videoElement = null;
        break;
    }
  });

  // --- Video Detection ---

  function initializeOnVideo(): void {
    const video = document.querySelector('video');
    if (!video) return;
    setupAudio(video);
    startAnalysis();
  }

  document.addEventListener('yt-navigate-finish', () => {
    stopAnalysis();
    videoElement = null;
    setTimeout(() => {
      if (settings.enabled) initializeOnVideo();
    }, 1000);
  });

  const observer = new MutationObserver(() => {
    const video = document.querySelector('video');
    if (video && video !== videoElement && settings.enabled) {
      setupAudio(video);
      startAnalysis();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  notify({ type: 'SILENCE_CUT_ANALYZER_READY' });
})();
