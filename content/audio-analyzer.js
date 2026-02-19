(function () {
  'use strict';

  // Version-gated init guard: allows re-init when extension is updated/reloaded
  const SCRIPT_VERSION = 2;
  if (window.__silenceCutVersion === SCRIPT_VERSION) return;
  window.__silenceCutVersion = SCRIPT_VERSION;

  const ANALYSIS_INTERVAL_MS = 50;
  const SKIP_INCREMENT = 0.5;
  const MUSIC_REENTRY_GRACE = 10; // seconds – trust music context for this long

  // WeakMap: video element -> { audioContext, sourceNode }
  const audioNodeCache = new WeakMap();

  let settings = {
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

  let analyserNode = null;
  let videoElement = null;
  let analysisInterval = null;

  // Silence state
  let silenceStartTime = null;
  let isInSilence = false;

  // Music state
  let musicStartTime = null;
  let isInMusic = false;

  // Shared
  let isSkipping = false; // currently taking action (silence or music)
  let skippedCount = 0;
  let skipReason = null; // 'silence' | 'music' | null
  let timeSavedMs = 0; // total time saved in milliseconds
  let originalPlaybackRate = 1; // video's playback rate before speed-up
  let lastMusicSkipEnd = 0; // timestamp when last music-skip ended
  let musicBaselineSpeechRatio = -1; // adaptive baseline for speech detection in music context

  // Music detection: rolling buffer for spectral flatness smoothing
  const FLATNESS_BUFFER_SIZE = 8;
  let flatnessBuffer = [];

  // --- Audio Setup ---

  function setupAudio(video) {
    if (video === videoElement && analyserNode) return;

    stopAnalysis();
    videoElement = video;

    let cached = audioNodeCache.get(video);

    if (cached) {
      const { audioContext, sourceNode } = cached;
      if (audioContext.state === 'suspended') audioContext.resume();
      try { sourceNode.disconnect(); } catch (_) {}

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
      console.warn('[Silence Cut] Audio setup failed:', e.message);
      analyserNode = null;
    }
  }

  function stopAnalysis() {
    if (analysisInterval) {
      clearInterval(analysisInterval);
      analysisInterval = null;
    }
    if (isSkipping) exitSkip();
    analyserNode = null;
    flatnessBuffer = [];
    musicBaselineSpeechRatio = -1;
  }

  // --- Volume Calculation ---

  function calculateVolumeDB() {
    if (!analyserNode) return -Infinity;

    const buffer = new Float32Array(analyserNode.fftSize);
    analyserNode.getFloatTimeDomainData(buffer);

    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) {
      sumSquares += buffer[i] * buffer[i];
    }
    const rms = Math.sqrt(sumSquares / buffer.length);

    let db = rms === 0 ? -Infinity : 20 * Math.log10(rms);

    // Compensate for the video element's volume setting.
    // createMediaElementSource() captures audio AFTER the element's volume
    // is applied, so lowering the player volume reduces the signal level.
    // Undo that attenuation so silence detection works on the true content level.
    if (videoElement && videoElement.volume > 0 && videoElement.volume < 1) {
      db -= 20 * Math.log10(videoElement.volume);
    }

    return db;
  }

  // --- Music Detection ---
  // Uses spectral flatness + speech band energy ratio.
  // Spectral flatness: geometric_mean / arithmetic_mean of frequency magnitudes.
  //   High (~1) = flat/noisy spectrum = music or noise
  //   Low (~0)  = tonal/peaky spectrum = speech
  // Speech band ratio: energy in 300Hz–3kHz / total energy.
  //   High = speech dominant, Low = music or effects.

  function analyzeSpectrum() {
    if (!analyserNode) return { spectralFlatness: 0, speechBandRatio: 1 };

    const freqBins = analyserNode.frequencyBinCount; // fftSize / 2
    const freqData = new Uint8Array(freqBins);
    analyserNode.getByteFrequencyData(freqData);

    const cached = videoElement && audioNodeCache.get(videoElement);
    const sampleRate = cached?.audioContext.sampleRate || 44100;
    const binHz = sampleRate / analyserNode.fftSize;

    // Skip DC and very low bins
    const startBin = Math.max(1, Math.floor(20 / binHz));
    const endBin = Math.min(freqBins, Math.floor(16000 / binHz));

    // Speech band: 300Hz – 3kHz
    const speechStart = Math.floor(300 / binHz);
    const speechEnd = Math.floor(3000 / binHz);

    let sumLog = 0;
    let sumLinear = 0;
    let speechEnergy = 0;
    let totalEnergy = 0;
    let count = 0;

    for (let i = startBin; i < endBin; i++) {
      const val = freqData[i] + 1; // +1 to avoid log(0)
      sumLog += Math.log(val);
      sumLinear += val;
      count++;

      const energy = val * val;
      totalEnergy += energy;
      if (i >= speechStart && i < speechEnd) {
        speechEnergy += energy;
      }
    }

    if (count === 0 || sumLinear === 0) {
      return { spectralFlatness: 0, speechBandRatio: 1 };
    }

    const geometricMean = Math.exp(sumLog / count);
    const arithmeticMean = sumLinear / count;
    const spectralFlatness = geometricMean / arithmeticMean;

    const speechBandRatio = totalEnergy > 0 ? speechEnergy / totalEnergy : 1;

    return { spectralFlatness, speechBandRatio };
  }

  function isMusicDetected(volumeDB) {
    // If too quiet, it's silence not music
    if (volumeDB < settings.silenceThreshold + 10) return false;

    const { spectralFlatness, speechBandRatio } = analyzeSpectrum();

    // Smooth spectral flatness over recent frames
    flatnessBuffer.push(spectralFlatness);
    if (flatnessBuffer.length > FLATNESS_BUFFER_SIZE) {
      flatnessBuffer.shift();
    }

    const sens = settings.musicSensitivity;

    // --- Music context with calibrated baseline: use relative comparison ---
    // Compare current speechBandRatio to the music-only baseline.
    // Speech raises the ratio above baseline; music-only stays near it.
    const now = performance.now() / 1000;
    const inMusicContext = lastMusicSkipEnd > 0 &&
      (now - lastMusicSkipEnd < MUSIC_REENTRY_GRACE);

    if (inMusicContext && musicBaselineSpeechRatio >= 0) {
      // Elevation threshold: how much speechBandRatio must rise above
      // the music-only baseline to count as "speech present"
      // sens 0 → 1.35 (strict), sens 0.5 → 1.25, sens 1.0 → 1.15 (sensitive)
      const elevationThreshold = 1.15 + (1 - sens) * 0.2;
      const isElevated = speechBandRatio >
        musicBaselineSpeechRatio * elevationThreshold;

      if (isElevated) return false; // speech detected above music baseline

      // Still music-only — keep baseline fresh
      musicBaselineSpeechRatio =
        0.95 * musicBaselineSpeechRatio + 0.05 * speechBandRatio;
      return true;
    }

    // --- Full detection (first time / no baseline) ---
    const speechRatioThreshold = 0.25 + sens * 0.3;
    const avgFlatness = flatnessBuffer.reduce((a, b) => a + b, 0) / flatnessBuffer.length;
    const flatnessThreshold = 0.7 - sens * 0.4;
    const isMusic = avgFlatness > flatnessThreshold &&
      speechBandRatio < speechRatioThreshold;

    // Calibrate baseline when music-only is confirmed by full analysis
    if (isMusic) {
      if (musicBaselineSpeechRatio < 0) {
        musicBaselineSpeechRatio = speechBandRatio;
      } else {
        musicBaselineSpeechRatio =
          0.95 * musicBaselineSpeechRatio + 0.05 * speechBandRatio;
      }
    }

    return isMusic;
  }

  // --- Live Stream Detection ---

  function isAtLiveEdge() {
    if (!videoElement) return false;
    // YouTube adds .ytp-live-badge-is-livehead class when at the live edge
    return !!document.querySelector('.ytp-live-badge-is-livehead');
  }

  // --- Analysis Loop ---

  function startAnalysis() {
    if (analysisInterval) return;

    analysisInterval = setInterval(() => {
      if (!settings.enabled || !videoElement || videoElement.paused) {
        if (isSkipping) exitSkip();
        return;
      }

      // When the user has muted the video or set volume to 0, the Web Audio
      // signal is silent but the actual content may have audio.  Skip all
      // analysis (silence + music) to avoid false detections.
      if (videoElement.muted || videoElement.volume === 0) {
        if (isSkipping) exitSkip();
        return;
      }

      const cached = videoElement && audioNodeCache.get(videoElement);
      if (cached?.audioContext.state === 'suspended') {
        cached.audioContext.resume();
      }

      const volumeDB = calculateVolumeDB();
      const now = performance.now() / 1000;

      // --- Silence detection ---
      const isSilent = settings.silenceEnabled && volumeDB < settings.silenceThreshold;

      if (isSilent && !isInSilence) {
        silenceStartTime = now;
        isInSilence = true;
      } else if (!isSilent && isInSilence) {
        isInSilence = false;
        silenceStartTime = null;
      }

      const silenceReady = isInSilence &&
        (now - silenceStartTime >= settings.minSilenceDuration);

      // --- Music detection ---
      const musicDetected = settings.musicEnabled && isMusicDetected(volumeDB);

      if (musicDetected && !isInMusic) {
        musicStartTime = now;
        isInMusic = true;
      } else if (!musicDetected && isInMusic) {
        isInMusic = false;
        musicStartTime = null;
      }

      // Once music context is confirmed, re-enter faster after speech gaps
      const inMusicContext = lastMusicSkipEnd > 0 &&
        (now - lastMusicSkipEnd < MUSIC_REENTRY_GRACE);
      const effectiveMusicWait = inMusicContext
        ? settings.minSilenceDuration
        : settings.minMusicDuration;
      const musicReady = isInMusic &&
        (now - musicStartTime >= effectiveMusicWait);

      // --- Take action ---
      // Don't skip/speed-up if we're at the live edge of a live stream
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
          isAtLiveEdge: true
        });
        return;
      }

      if (silenceReady || musicReady) {
        const reason = silenceReady ? 'silence' : 'music';
        if (!isSkipping || skipReason !== reason) {
          skipReason = reason;
        }
        isSkipping = true;
        handleSkip();
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
        isAtLiveEdge: false
      });
    }, ANALYSIS_INTERVAL_MS);
  }

  function handleSkip() {
    if (!videoElement || videoElement.paused) return;

    if (settings.actionMode === 'skip') {
      videoElement.currentTime += SKIP_INCREMENT;
      timeSavedMs += SKIP_INCREMENT * 1000;
      skippedCount++;
    } else if (settings.actionMode === 'speed') {
      if (videoElement.playbackRate !== settings.speedMultiplier) {
        originalPlaybackRate = videoElement.playbackRate;
        videoElement.playbackRate = settings.speedMultiplier;
        skippedCount++;
      }
      // At Nx speed, 50ms real time = 50*N ms of video content.
      // Time saved per tick = interval * (multiplier - 1)
      const savedPerTick = ANALYSIS_INTERVAL_MS * (settings.speedMultiplier - 1);
      timeSavedMs += savedPerTick;
    }
  }

  function exitSkip() {
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

  function notify(data) {
    window.postMessage(data, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    switch (event.data.type) {
      case 'SILENCE_CUT_UPDATE_SETTINGS':
        Object.assign(settings, event.data.settings);
        if (!settings.enabled && isSkipping) exitSkip();
        break;

      case 'SILENCE_CUT_INIT':
        Object.assign(settings, event.data.settings);
        initializeOnVideo();
        break;

      case 'SILENCE_CUT_TEARDOWN':
        stopAnalysis();
        videoElement = null;
        break;
    }
  });

  // --- Video Detection ---

  function initializeOnVideo() {
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
