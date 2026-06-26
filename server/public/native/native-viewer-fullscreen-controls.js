(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.nativeViewerFullscreenControls) {
    return;
  }

  function createController(options = {}) {
    const electronApi = options.electronApi || null;
    const elements = options.elements || {};
    const viewerControls = options.viewerControls || null;
    const fullscreenButtons = Array.isArray(elements.fullscreenButtons)
      ? elements.fullscreenButtons.filter(Boolean)
      : [];
    const getCurrentWindowBounds = typeof options.getCurrentWindowBounds === 'function'
      ? options.getCurrentWindowBounds
      : () => null;
    const forceSurfaceResync = typeof options.forceSurfaceResync === 'function'
      ? options.forceSurfaceResync
      : () => {};
    const body = options.body || document.body;

    let controlsHideTimerId = 0;
    let cursorPollTimerId = 0;
    let volumePopoverHideTimerId = 0;
    let fullscreenTransitionPromise = null;
    let lastCursorPoint = null;
    let eventsBound = false;

    function isFullscreenMode() {
      return body.classList.contains('native-embedded-fullscreen') &&
        body.getAttribute('data-app-view') === 'viewer';
    }

    function isVolumeDragging() {
      return Boolean(viewerControls && typeof viewerControls.isVolumeDragging === 'function' && viewerControls.isVolumeDragging());
    }

    function shouldReserveUnderbarSpace() {
      return isFullscreenMode() && (
        body.classList.contains('viewer-fullscreen-controls-visible') ||
        (elements.underbar && elements.underbar.matches(':hover'))
      );
    }

    function isVolumePopoverPinned() {
      return Boolean(
        isVolumeDragging() ||
        (elements.volumeControl && elements.volumeControl.matches(':hover'))
      );
    }

    function isUnderbarPinned() {
      return Boolean(
        (elements.underbar && elements.underbar.matches(':hover')) ||
        isVolumePopoverPinned()
      );
    }

    function clearVolumePopoverHideTimer() {
      if (volumePopoverHideTimerId) {
        window.clearTimeout(volumePopoverHideTimerId);
        volumePopoverHideTimerId = 0;
      }
    }

    function setVolumePopoverOpen(open) {
      if (!elements.volumeControl) {
        return;
      }
      if (open) {
        elements.volumeControl.classList.add('is-open');
        clearVolumePopoverHideTimer();
        return;
      }
      elements.volumeControl.classList.remove('is-open');
      clearVolumePopoverHideTimer();
    }

    function setVolumeDragging(dragging) {
      if (viewerControls && typeof viewerControls.setVolumeDragging === 'function') {
        viewerControls.setVolumeDragging(dragging);
      }
    }

    function scheduleVolumePopoverHide(delayMs = 900) {
      if (!elements.volumeControl) {
        return;
      }
      clearVolumePopoverHideTimer();
      volumePopoverHideTimerId = window.setTimeout(() => {
        volumePopoverHideTimerId = 0;
        if (isVolumePopoverPinned()) {
          scheduleVolumePopoverHide(600);
          return;
        }
        setVolumePopoverOpen(false);
      }, delayMs);
    }

    function stopCursorPolling() {
      if (cursorPollTimerId) {
        window.clearInterval(cursorPollTimerId);
        cursorPollTimerId = 0;
      }
      lastCursorPoint = null;
    }

    function syncUnderbarState() {
      const active = isFullscreenMode();
      if (elements.underbar) {
        elements.underbar.setAttribute('aria-hidden', active ? 'false' : 'true');
      }
      if (!active) {
        body.classList.remove('viewer-fullscreen-controls-visible');
        setVolumePopoverOpen(false);
        if (controlsHideTimerId) {
          window.clearTimeout(controlsHideTimerId);
          controlsHideTimerId = 0;
        }
        stopCursorPolling();
      }
    }

    function isCursorInsideCurrentWindow(point) {
      const bounds = getCurrentWindowBounds();
      if (!point || !bounds) {
        return false;
      }
      const x = Number(point.x);
      const y = Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return false;
      }
      return x >= bounds.x &&
        y >= bounds.y &&
        x < bounds.x + bounds.width &&
        y < bounds.y + bounds.height;
    }

    function startCursorPolling() {
      if (
        cursorPollTimerId ||
        !electronApi ||
        typeof electronApi.getCursorScreenPoint !== 'function'
      ) {
        return;
      }

      cursorPollTimerId = window.setInterval(async () => {
        if (!isFullscreenMode()) {
          stopCursorPolling();
          return;
        }

        try {
          const point = await electronApi.getCursorScreenPoint();
          const normalizedPoint = {
            x: Number(point && point.x) || 0,
            y: Number(point && point.y) || 0
          };

          if (!isCursorInsideCurrentWindow(normalizedPoint)) {
            lastCursorPoint = normalizedPoint;
            return;
          }

          const moved =
            !lastCursorPoint ||
            Math.abs(normalizedPoint.x - lastCursorPoint.x) >= 2 ||
            Math.abs(normalizedPoint.y - lastCursorPoint.y) >= 2;

          lastCursorPoint = normalizedPoint;
          if (moved) {
            showControls();
          }
        } catch (_error) {
          // Cursor polling is best-effort; visible controls still react to direct hover.
        }
      }, 120);
    }

    function scheduleControlsHide(delayMs = 2200) {
      if (!isFullscreenMode()) {
        return;
      }
      if (controlsHideTimerId) {
        window.clearTimeout(controlsHideTimerId);
      }
      controlsHideTimerId = window.setTimeout(() => {
        controlsHideTimerId = 0;
        if (!isFullscreenMode()) {
          return;
        }
        if (isVolumePopoverPinned()) {
          scheduleVolumePopoverHide(800);
          scheduleControlsHide(900);
          return;
        }
        if (isUnderbarPinned()) {
          scheduleControlsHide(1200);
          return;
        }
        setVolumePopoverOpen(false);
        body.classList.remove('viewer-fullscreen-controls-visible');
        forceSurfaceResync();
      }, delayMs);
    }

    function showControls() {
      if (!isFullscreenMode()) {
        return;
      }
      body.classList.add('viewer-fullscreen-controls-visible');
      startCursorPolling();
      forceSurfaceResync();
      scheduleControlsHide();
    }

    function updateFullscreenUi(isFullscreen) {
      body.classList.toggle('native-embedded-fullscreen', Boolean(isFullscreen));
      syncUnderbarState();
      if (Boolean(isFullscreen) && body.getAttribute('data-app-view') === 'viewer') {
        showControls();
      }
      forceSurfaceResync();
    }

    async function toggleFullscreen() {
      if (!electronApi || typeof electronApi.isFullscreen !== 'function' || typeof electronApi.setFullscreen !== 'function') {
        return null;
      }
      if (fullscreenTransitionPromise) {
        return fullscreenTransitionPromise;
      }
      fullscreenTransitionPromise = (async () => {
        const isFullscreen = await electronApi.isFullscreen();
        const nextState = await electronApi.setFullscreen(!isFullscreen);
        updateFullscreenUi(nextState);
        return nextState;
      })();
      try {
        return await fullscreenTransitionPromise;
      } finally {
        fullscreenTransitionPromise = null;
      }
    }

    async function exitFullscreen() {
      if (!electronApi || typeof electronApi.isFullscreen !== 'function' || typeof electronApi.setFullscreen !== 'function') {
        return null;
      }
      const isFullscreen = await electronApi.isFullscreen();
      if (!isFullscreen) {
        return false;
      }
      const nextState = await electronApi.setFullscreen(false);
      updateFullscreenUi(nextState);
      return nextState;
    }

    async function handleEscapeKey(event) {
      if (!event || event.key !== 'Escape' || !electronApi || typeof electronApi.isFullscreen !== 'function') {
        return null;
      }
      if (fullscreenTransitionPromise) {
        event.preventDefault();
        event.stopPropagation();
        return fullscreenTransitionPromise;
      }

      const isFullscreen = await electronApi.isFullscreen();
      if (!isFullscreen) {
        return false;
      }

      event.preventDefault();
      event.stopPropagation();
      fullscreenTransitionPromise = electronApi.setFullscreen(false).then((nextState) => {
        updateFullscreenUi(nextState);
        return nextState;
      });
      try {
        return await fullscreenTransitionPromise;
      } finally {
        fullscreenTransitionPromise = null;
      }
    }

    function bindViewerEvents(callbacks = {}) {
      if (eventsBound) {
        return;
      }
      eventsBound = true;

      fullscreenButtons.forEach((button) => {
        button.addEventListener('click', () => {
          toggleFullscreen();
        });
      });

      const onVolumeInput = typeof callbacks.onVolumeInput === 'function'
        ? callbacks.onVolumeInput
        : async (event) => {
            if (viewerControls && typeof viewerControls.handleVolumeInput === 'function') {
              await viewerControls.handleVolumeInput(event);
              showControls();
            }
          };
      if (elements.volumeInput) {
        elements.volumeInput.addEventListener('input', onVolumeInput);
      }
      if (elements.fullscreenVolumeInput) {
        elements.fullscreenVolumeInput.addEventListener('input', onVolumeInput);
        elements.fullscreenVolumeInput.addEventListener('pointerdown', () => {
          setVolumeDragging(true);
          setVolumePopoverOpen(true);
          showControls();
        });
        elements.fullscreenVolumeInput.addEventListener('pointerup', () => {
          setVolumeDragging(false);
          if (document.activeElement === elements.fullscreenVolumeInput) {
            elements.fullscreenVolumeInput.blur();
          }
          scheduleVolumePopoverHide(1000);
          scheduleControlsHide(1400);
        });
        elements.fullscreenVolumeInput.addEventListener('change', () => {
          setVolumeDragging(false);
          if (document.activeElement === elements.fullscreenVolumeInput) {
            elements.fullscreenVolumeInput.blur();
          }
          scheduleVolumePopoverHide(900);
          scheduleControlsHide(1300);
        });
        elements.fullscreenVolumeInput.addEventListener('blur', () => {
          setVolumeDragging(false);
        });
      }

      if (elements.volumeControl) {
        elements.volumeControl.addEventListener('mouseenter', () => {
          setVolumePopoverOpen(true);
          showControls();
        });
        elements.volumeControl.addEventListener('mouseleave', () => {
          scheduleVolumePopoverHide(320);
          scheduleControlsHide(900);
        });
        elements.volumeControl.addEventListener('focusin', () => {
          setVolumePopoverOpen(true);
          showControls();
        });
        elements.volumeControl.addEventListener('focusout', () => {
          window.setTimeout(() => {
            if (!isVolumePopoverPinned()) {
              scheduleVolumePopoverHide(180);
              scheduleControlsHide(900);
            }
          }, 0);
        });
      }

      const onToggleMute = typeof callbacks.onToggleMute === 'function'
        ? callbacks.onToggleMute
        : async () => {
            if (viewerControls && typeof viewerControls.toggleMute === 'function') {
              await viewerControls.toggleMute();
              showControls();
            }
          };
      if (elements.muteButton) {
        elements.muteButton.addEventListener('click', () => {
          onToggleMute().catch((error) => {
            if (typeof callbacks.onMuteToggleError === 'function') {
              callbacks.onMuteToggleError(error);
            }
          });
        });
      }
      if (elements.exitButton) {
        elements.exitButton.addEventListener('click', () => {
          exitFullscreen().catch((error) => {
            if (typeof callbacks.onExitFullscreenError === 'function') {
              callbacks.onExitFullscreenError(error);
            }
          });
        });
      }
      if (elements.remoteContainer) {
        const handleShowControls = () => {
          showControls();
        };
        elements.remoteContainer.addEventListener('mousemove', handleShowControls);
        elements.remoteContainer.addEventListener('mouseenter', handleShowControls);
        elements.remoteContainer.addEventListener('touchstart', handleShowControls, { passive: true });
      }
      if (elements.underbar) {
        elements.underbar.addEventListener('mouseenter', () => {
          showControls();
        });
        elements.underbar.addEventListener('mouseleave', () => {
          scheduleVolumePopoverHide(220);
          scheduleControlsHide(900);
        });
        elements.underbar.addEventListener('focusin', () => {
          showControls();
        });
      }

      if (electronApi && typeof electronApi.onFullscreenChange === 'function') {
        electronApi.onFullscreenChange(updateFullscreenUi);
      }

      window.addEventListener('keydown', (event) => {
        handleEscapeKey(event).catch((error) => {
          if (typeof callbacks.onEscapeError === 'function') {
            callbacks.onEscapeError(error);
          }
        });
      }, true);
    }

    return {
      isFullscreenMode,
      shouldReserveUnderbarSpace,
      isVolumePopoverPinned,
      setVolumePopoverOpen,
      scheduleVolumePopoverHide,
      syncUnderbarState,
      scheduleControlsHide,
      showControls,
      updateFullscreenUi,
      toggleFullscreen,
      exitFullscreen,
      handleEscapeKey,
      bindViewerEvents
    };
  }

  VDS.nativeViewerFullscreenControls = { createController };
})();
