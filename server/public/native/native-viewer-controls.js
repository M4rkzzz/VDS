(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.nativeViewerControls) {
    return;
  }

  function normalizeVolume(value) {
    return Math.max(0, Math.min(100, Number(value) || 0));
  }

  function createController(options = {}) {
    const elements = options.elements || {};
    const mediaEngine = options.mediaEngine || null;
    const logRecoverableNativeWarning = typeof options.logRecoverableNativeWarning === 'function'
      ? options.logRecoverableNativeWarning
      : () => {};
    let volumeApplyTimerId = 0;
    let volumeApplySeq = 0;
    let volumeApplyPreviousVolume = 100;
    let lastNonZeroVolume = 100;
    let volumeDragging = false;

    function getCurrentVolume() {
      return normalizeVolume(elements.viewerVolumeInput && elements.viewerVolumeInput.value);
    }

    function applyVolumeUi(volume) {
      const normalizedVolume = normalizeVolume(volume);
      if (normalizedVolume > 0) {
        lastNonZeroVolume = normalizedVolume;
      }

      if (elements.viewerVolumeInput) {
        elements.viewerVolumeInput.value = String(normalizedVolume);
      }
      if (elements.viewerVolumeValue) {
        elements.viewerVolumeValue.textContent = `${normalizedVolume}%`;
      }
      if (elements.viewerFullscreenVolumeInput) {
        elements.viewerFullscreenVolumeInput.value = String(normalizedVolume);
      }
      if (elements.viewerFullscreenVolumeValue) {
        elements.viewerFullscreenVolumeValue.textContent = `${normalizedVolume}%`;
      }
      if (elements.viewerFullscreenMuteButton) {
        const volumeState = normalizedVolume <= 0 ? 'muted' : (normalizedVolume < 45 ? 'low' : 'high');
        elements.viewerFullscreenMuteButton.dataset.volumeState = volumeState;
        elements.viewerFullscreenMuteButton.setAttribute('aria-pressed', normalizedVolume <= 0 ? 'true' : 'false');
        elements.viewerFullscreenMuteButton.setAttribute('aria-label', normalizedVolume <= 0 ? '取消静音' : '静音');
      }
      return normalizedVolume;
    }

    function scheduleVolumeApply(normalizedVolume, previousVolume) {
      const nextVolume = normalizeVolume(normalizedVolume);
      if (volumeApplyTimerId) {
        window.clearTimeout(volumeApplyTimerId);
        volumeApplyTimerId = 0;
      } else {
        volumeApplyPreviousVolume = normalizeVolume(previousVolume);
      }

      const applySeq = volumeApplySeq + 1;
      volumeApplySeq = applySeq;
      volumeApplyTimerId = window.setTimeout(async () => {
        volumeApplyTimerId = 0;
        try {
          if (!mediaEngine || typeof mediaEngine.setViewerVolume !== 'function') {
            throw new Error('setViewerVolume-unavailable');
          }
          await mediaEngine.setViewerVolume(nextVolume / 100);
          if (applySeq === volumeApplySeq) {
            volumeApplyPreviousVolume = nextVolume;
          }
        } catch (error) {
          if (applySeq === volumeApplySeq) {
            applyVolumeUi(volumeApplyPreviousVolume);
          }
          logRecoverableNativeWarning('viewer-volume:set-failed', error, {
            key: 'viewer-volume-set',
            category: 'audio',
            channel: 'nativeSteps',
            fallbackLabel: '[media-engine] setViewerVolume failed:'
          });
        }
      }, 80);
    }

    async function setVolumeValue(nextValue) {
      const previousVolume = getCurrentVolume();
      const normalizedVolume = normalizeVolume(nextValue);
      applyVolumeUi(normalizedVolume);
      scheduleVolumeApply(normalizedVolume, previousVolume);
      return normalizedVolume;
    }

    async function toggleMute() {
      const currentVolume = getCurrentVolume();
      const nextVolume = currentVolume <= 0 ? Math.max(1, lastNonZeroVolume || 100) : 0;
      await setVolumeValue(nextVolume);
      return nextVolume;
    }

    async function handleVolumeInput(event) {
      const source = event && event.target ? event.target : null;
      return setVolumeValue(source ? source.value : event);
    }

    async function refreshVolumeUi() {
      if (!elements.viewerVolumeInput || !elements.viewerVolumeValue || !mediaEngine || typeof mediaEngine.getViewerVolume !== 'function') {
        return null;
      }

      try {
        const result = await mediaEngine.getViewerVolume();
        const volume = Math.round(Math.max(0, Math.min(1, Number(result && result.volume))) * 100);
        applyVolumeUi(volume);
        return volume;
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (message.includes('No active render audio session was found')) {
          applyVolumeUi(100);
          return 100;
        }
        logRecoverableNativeWarning('viewer-volume:get-failed', error, {
          key: 'viewer-volume-get',
          category: 'audio',
          channel: 'nativeSteps',
          fallbackLabel: '[media-engine] getViewerVolume failed:'
        });
        return null;
      }
    }

    function setVolumeDragging(dragging) {
      volumeDragging = Boolean(dragging);
    }

    function isVolumeDragging() {
      return volumeDragging;
    }

    function clearPendingVolumeApply() {
      if (volumeApplyTimerId) {
        window.clearTimeout(volumeApplyTimerId);
        volumeApplyTimerId = 0;
      }
    }

    return {
      normalizeVolume,
      applyVolumeUi,
      setVolumeValue,
      toggleMute,
      handleVolumeInput,
      refreshVolumeUi,
      setVolumeDragging,
      isVolumeDragging,
      clearPendingVolumeApply
    };
  }

  VDS.nativeViewerControls = { createController };
})();
