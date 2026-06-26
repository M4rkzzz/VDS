(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.nativeSurface) {
    return;
  }

  function createSurfaceRegistry() {
    const attachedSurfaces = new Map();
    const surfaceGenerations = new Map();
    const surfaceFailureCounts = new Map();
    return {
      getSurfaceCount: () => attachedSurfaces.size,
      getSurfaceEntry: (surfaceId) => attachedSurfaces.get(surfaceId) || null,
      setSurfaceEntry: (surfaceId, entry) => {
        attachedSurfaces.set(surfaceId, entry);
        return entry;
      },
      deleteSurfaceEntry: (surfaceId) => attachedSurfaces.delete(surfaceId),
      forEachSurface: (callback) => attachedSurfaces.forEach(callback),
      invalidateSurfaceLayouts: () => {
        attachedSurfaces.forEach((entry) => {
          if (entry) {
            entry.lastLayoutKey = '';
          }
        });
      },
      getSurfaceGeneration: (surfaceId) => surfaceGenerations.get(surfaceId) || 0,
      setSurfaceGeneration: (surfaceId, generation) => {
        surfaceGenerations.set(surfaceId, generation);
        return generation;
      },
      incrementSurfaceGeneration: (surfaceId) => {
        const generation = (surfaceGenerations.get(surfaceId) || 0) + 1;
        surfaceGenerations.set(surfaceId, generation);
        return generation;
      },
      clearSurfaceFailureCount: (surfaceId) => surfaceFailureCounts.delete(surfaceId),
      incrementSurfaceFailureCount: (surfaceId) => {
        const count = (surfaceFailureCounts.get(surfaceId) || 0) + 1;
        surfaceFailureCounts.set(surfaceId, count);
        return count;
      }
    };
  }

  function createController(options = {}) {
    const surfaceRegistry = createSurfaceRegistry();
    const recoverableSurfaceSyncWarnings = new Map();
    let surfaceSyncRafId = 0;
    let surfaceSyncInFlight = false;
    let surfaceSyncPending = false;
    let wheelDrivenSyncRafId = 0;
    let wheelDrivenSyncFramesRemaining = 0;
    let trackingTimerId = 0;
    let windowBoundsSyncRafId = 0;
    let windowBoundsSyncFinalTimerId = 0;
    let layoutEventsBound = false;

    function isSurfaceEmbeddingEnabled() {
      return options.surfaceEmbeddingEnabled !== false;
    }

    function getCurrentWindowBounds() {
      return typeof options.getCurrentWindowBounds === 'function'
        ? options.getCurrentWindowBounds()
        : null;
    }

    function isBlockingModalVisible() {
      return typeof options.isBlockingModalVisible === 'function'
        ? Boolean(options.isBlockingModalVisible())
        : false;
    }

    function shouldReserveViewerFullscreenUnderbarSpace() {
      return typeof options.shouldReserveViewerFullscreenUnderbarSpace === 'function'
        ? Boolean(options.shouldReserveViewerFullscreenUnderbarSpace())
        : false;
    }

    function logNativeStep(scope, payload, category) {
      if (options.diagnostics && typeof options.diagnostics.logNativeStep === 'function') {
        options.diagnostics.logNativeStep(scope, payload, category);
        return;
      }
      if (typeof options.logNativeStep === 'function') {
        options.logNativeStep(scope, payload, category);
      }
    }

    function logNativeWarningLine(label, ...args) {
      if (options.diagnostics && typeof options.diagnostics.logNativeWarningLine === 'function') {
        options.diagnostics.logNativeWarningLine(label, ...args);
        return;
      }
      if (typeof options.logNativeWarningLine === 'function') {
        options.logNativeWarningLine(label, ...args);
      }
    }

    function shouldShowDebugLogsFor(category = 'misc', channel = 'renderer') {
      if (options.diagnostics && typeof options.diagnostics.shouldShowDebugLogsFor === 'function') {
        return options.diagnostics.shouldShowDebugLogsFor(category, channel);
      }
      if (typeof options.shouldShowDebugLogsFor === 'function') {
        return options.shouldShowDebugLogsFor(category, channel);
      }
      return false;
    }

    function getMaxConsecutiveSyncFailures() {
      const configured = Number(options.maxConsecutiveSyncFailures);
      return Number.isFinite(configured) && configured > 0 ? configured : 5;
    }

    function getWheelDrivenSyncFrameCount() {
      const configured = Number(options.wheelDrivenSyncFrameCount);
      return Number.isFinite(configured) && configured > 0 ? configured : 8;
    }

    function getTrackingIntervalMs() {
      const configured = Number(options.trackingIntervalMs);
      return Number.isFinite(configured) && configured > 0 ? configured : 180;
    }

    function logRecoverableSurfaceSyncWarning(surfaceId, error) {
      const message = error && error.message ? error.message : String(error);
      const now = Date.now();
      const lastLoggedAt = recoverableSurfaceSyncWarnings.get(surfaceId) || 0;
      const debugEnabled = shouldShowDebugLogsFor('video', 'nativeSteps');
      if (!debugEnabled && now - lastLoggedAt < 5000) {
        return;
      }
      recoverableSurfaceSyncWarnings.set(surfaceId, now);
      if (debugEnabled) {
        logNativeStep('updateSurface:recoverable-error', { surfaceId, message }, 'video');
        return;
      }
      logNativeWarningLine('[media-engine] surface sync failed:', surfaceId, message);
    }

    function logSyncAllError(error) {
      if (typeof options.logSyncAllError === 'function') {
        options.logSyncAllError(error);
      }
    }

    function hideLegacyVideoElements() {
      if (typeof options.hideLegacyVideoElements === 'function') {
        options.hideLegacyVideoElements();
      }
    }

    function getHostPreviewState() {
      if (typeof options.getHostPreviewState === 'function') {
        return options.getHostPreviewState() || {};
      }
      return {};
    }

    function setHostPreviewAttached(attached) {
      if (typeof options.setHostPreviewAttached === 'function') {
        options.setHostPreviewAttached(Boolean(attached));
      }
    }

    function isHostPreviewAttached() {
      if (typeof options.isHostPreviewAttached === 'function') {
        return Boolean(options.isHostPreviewAttached());
      }
      return Boolean(options.hostPreviewSurfaceId && getSurfaceEntry(options.hostPreviewSurfaceId));
    }

    function describeSurfaceElement(element) {
      if (!element) {
        return { missing: true };
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return {
        id: element.id || '',
        className: element.className || '',
        clientWidth: element.clientWidth || 0,
        clientHeight: element.clientHeight || 0,
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        },
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        zIndex: style.zIndex,
        overflow: style.overflow,
        hiddenClass: element.classList ? element.classList.contains('hidden') : false
      };
    }

    function buildSurfaceLayout(element, layoutOptions = {}) {
      const shouldLog = layoutOptions.log !== false;
      const rect = element.getBoundingClientRect();
      const scale = Math.max(1, Number(window.devicePixelRatio) || 1);
      const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
      const viewportHeight = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
      const clippedLeft = Math.max(0, Math.min(viewportWidth, rect.left));
      const clippedTop = Math.max(0, Math.min(viewportHeight, rect.top));
      const clippedRight = Math.max(0, Math.min(viewportWidth, rect.right));
      const clippedBottom = Math.max(0, Math.min(viewportHeight, rect.bottom));
      let reservedBottom = 0;
      if (
        element === options.remoteVideoContainer &&
        shouldReserveViewerFullscreenUnderbarSpace() &&
        options.viewerFullscreenUnderbar
      ) {
        const underbarRect = options.viewerFullscreenUnderbar.getBoundingClientRect();
        if (underbarRect && Number.isFinite(underbarRect.height) && underbarRect.height > 0) {
          reservedBottom = Math.max(58, Math.round(underbarRect.height + 10));
        }
      }
      const adjustedClippedBottom = Math.max(clippedTop, clippedBottom - reservedBottom);
      const cssWidth = Math.max(0, Math.round(clippedRight - clippedLeft));
      const cssHeight = Math.max(0, Math.round(adjustedClippedBottom - clippedTop));
      const visible =
        cssWidth > 1 &&
        cssHeight > 1 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.left < viewportWidth &&
        rect.top < viewportHeight &&
        !isBlockingModalVisible();
      const currentWindowBounds = getCurrentWindowBounds();
      const windowX = currentWindowBounds && Number.isFinite(currentWindowBounds.x)
        ? currentWindowBounds.x
        : window.screenX;
      const windowY = currentWindowBounds && Number.isFinite(currentWindowBounds.y)
        ? currentWindowBounds.y
        : window.screenY;

      if (!isSurfaceEmbeddingEnabled()) {
        const layout = {
          embedded: false,
          visible,
          width: Math.max(1, cssWidth),
          height: Math.max(1, cssHeight)
        };
        if (shouldLog) {
          logNativeStep('buildSurfaceLayout:detached', {
            elementId: element.id || '',
            width: cssWidth,
            height: cssHeight,
            reservedBottom
          });
        }
        return layout;
      }

      const layout = {
        embedded: true,
        visible,
        x: Math.round(windowX + clippedLeft),
        y: Math.round(windowY + clippedTop),
        width: Math.max(1, cssWidth),
        height: Math.max(1, cssHeight)
      };
      Object.defineProperty(layout, '__syncKey', {
        value: JSON.stringify({
          embedded: true,
          visible,
          x: Math.round(windowX + clippedLeft),
          y: Math.round(windowY + clippedTop),
          relativeLeft: Math.round(clippedLeft),
          relativeTop: Math.round(clippedTop),
          width: Math.max(1, cssWidth),
          height: Math.max(1, cssHeight)
        }),
        enumerable: false
      });
      if (shouldLog) {
        logNativeStep('buildSurfaceLayout:embedded', {
          elementId: element.id || '',
          rect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
          },
          clippedRect: {
            left: clippedLeft,
            top: clippedTop,
            width: cssWidth,
            height: cssHeight,
            reservedBottom
          },
          viewport: {
            width: viewportWidth,
            height: viewportHeight
          },
          scale,
          coordinateMode: 'css-px-overlay',
          layout
        });
      }
      return layout;
    }

    function getSurfaceLayoutKey(layout) {
      if (!layout) {
        return '';
      }

      if (layout.__syncKey) {
        return layout.__syncKey;
      }

      return JSON.stringify({
        embedded: Boolean(layout.embedded),
        visible: layout.visible !== false,
        x: Number(layout.x || 0),
        y: Number(layout.y || 0),
        width: Number(layout.width || 0),
        height: Number(layout.height || 0)
      });
    }

    function getSurfaceCount() {
      return surfaceRegistry.getSurfaceCount();
    }

    function getSurfaceEntry(surfaceId) {
      return surfaceRegistry.getSurfaceEntry(surfaceId);
    }

    function setSurfaceEntry(surfaceId, entry) {
      return surfaceRegistry.setSurfaceEntry(surfaceId, entry);
    }

    function deleteSurfaceEntry(surfaceId) {
      return surfaceRegistry.deleteSurfaceEntry(surfaceId);
    }

    function forEachSurface(callback) {
      surfaceRegistry.forEachSurface(callback);
    }

    function invalidateSurfaceLayouts() {
      surfaceRegistry.invalidateSurfaceLayouts();
    }

    function getSurfaceGeneration(surfaceId) {
      return surfaceRegistry.getSurfaceGeneration(surfaceId);
    }

    function setSurfaceGeneration(surfaceId, generation) {
      return surfaceRegistry.setSurfaceGeneration(surfaceId, generation);
    }

    function incrementSurfaceGeneration(surfaceId) {
      return surfaceRegistry.incrementSurfaceGeneration(surfaceId);
    }

    function clearSurfaceFailureCount(surfaceId) {
      surfaceRegistry.clearSurfaceFailureCount(surfaceId);
    }

    function incrementSurfaceFailureCount(surfaceId) {
      return surfaceRegistry.incrementSurfaceFailureCount(surfaceId);
    }

    function clearRecoverableSurfaceSyncWarning(surfaceId) {
      recoverableSurfaceSyncWarnings.delete(surfaceId);
      clearSurfaceFailureCount(surfaceId);
    }

    function stopTrackingLoop() {
      if (trackingTimerId) {
        window.clearTimeout(trackingTimerId);
        trackingTimerId = 0;
      }
    }

    function startTrackingLoop() {
      if (!isSurfaceEmbeddingEnabled() || trackingTimerId || getSurfaceCount() === 0) {
        return;
      }

      const tick = () => {
        trackingTimerId = 0;
        if (getSurfaceCount() === 0) {
          return;
        }
        scheduleSync();
        trackingTimerId = window.setTimeout(tick, getTrackingIntervalMs());
      };

      trackingTimerId = window.setTimeout(tick, getTrackingIntervalMs());
    }

    function removeSurfaceTracking(surfaceId, reason) {
      incrementSurfaceGeneration(surfaceId);
      deleteSurfaceEntry(surfaceId);
      clearRecoverableSurfaceSyncWarning(surfaceId);
      if (getSurfaceCount() === 0) {
        stopTrackingLoop();
      }
      if (typeof options.onSurfaceTrackingRemoved === 'function') {
        options.onSurfaceTrackingRemoved(surfaceId, reason);
      }
    }

    async function attachSurface(surfaceId, target, element) {
      if (!element) {
        throw new Error(`缺少承载容器:${surfaceId}`);
      }
      if (!options.mediaEngine || typeof options.mediaEngine.attachSurface !== 'function') {
        throw new Error('native-surface-media-engine-unavailable');
      }

      const layout = buildSurfaceLayout(element);
      const layoutKey = getSurfaceLayoutKey(layout);
      const attachGeneration = incrementSurfaceGeneration(surfaceId);
      const payload = {
        surface: surfaceId,
        target,
        ...layout
      };
      logNativeStep('attachSurface:request', {
        surfaceId,
        target,
        payload,
        element: describeSurfaceElement(element)
      });
      const result = await options.mediaEngine.attachSurface(payload);
      if (getSurfaceGeneration(surfaceId) !== attachGeneration) {
        if (typeof options.mediaEngine.detachSurface === 'function') {
          await options.mediaEngine.detachSurface({ surface: surfaceId }).catch(() => {});
        }
        logNativeStep('attachSurface:stale-result-ignored', { surfaceId, target }, 'video');
        return null;
      }
      clearRecoverableSurfaceSyncWarning(surfaceId);
      setSurfaceEntry(surfaceId, { target, element, lastLayoutKey: layoutKey });
      startTrackingLoop();
      logNativeStep('attachSurface:result', {
        surfaceId,
        target,
        result
      });
      return result;
    }

    async function detachSurface(surfaceId) {
      if (!options.mediaEngine || typeof options.mediaEngine.detachSurface !== 'function') {
        throw new Error('native-surface-media-engine-unavailable');
      }
      removeSurfaceTracking(surfaceId, 'detach-requested');
      logNativeStep('detachSurface:request', { surfaceId });
      const result = await options.mediaEngine.detachSurface({ surface: surfaceId });
      logNativeStep('detachSurface:result', { surfaceId, result });
      return result;
    }

    async function recoverSurface(surfaceId, entry, reason = 'surface-sync-failed') {
      if (!surfaceId || !entry || !entry.element || !entry.target) {
        removeSurfaceTracking(surfaceId, reason);
        return null;
      }

      removeSurfaceTracking(surfaceId, reason);
      if (options.mediaEngine && typeof options.mediaEngine.detachSurface === 'function') {
        await options.mediaEngine.detachSurface({ surface: surfaceId }).catch(() => {});
      }

      logNativeStep('surface-tracking:reattach', { surfaceId, target: entry.target, reason }, 'video');
      const result = await attachSurface(surfaceId, entry.target, entry.element);
      if (result && surfaceId === (options.hostPreviewSurfaceId || 'embedded-host-preview')) {
        setHostPreviewAttached(true);
      }
      return result;
    }

    async function attachHostPreviewSurface() {
      const state = getHostPreviewState();
      if (!state.nativeHostPreviewEnabled || !state.nativeHostSessionRunning || !state.hostPreviewRequested) {
        logNativeStep('attachNativeHostPreviewSurface:skipped', {
          nativeHostPreviewEnabled: Boolean(state.nativeHostPreviewEnabled),
          nativeHostSessionRunning: Boolean(state.nativeHostSessionRunning),
          hostPreviewRequested: Boolean(state.hostPreviewRequested)
        });
        return null;
      }

      const surfaceId = options.hostPreviewSurfaceId || 'embedded-host-preview';
      const target = options.hostPreviewTarget || 'host-capture-artifact';
      const element = options.hostPreviewElement;
      logNativeStep('attachNativeHostPreviewSurface:start', { surfaceId, target });
      const result = await attachSurface(surfaceId, target, element);
      setHostPreviewAttached(Boolean(result));
      if (result) {
        forceResyncBurst();
      }
      hideLegacyVideoElements();
      return result;
    }

    async function detachHostPreviewSurface() {
      if (!isHostPreviewAttached()) {
        return null;
      }
      const surfaceId = options.hostPreviewSurfaceId || 'embedded-host-preview';
      setHostPreviewAttached(false);
      return detachSurface(surfaceId);
    }

    async function attachPeerVideoSurface(peerId) {
      const surfaceId = `peer-surface:${peerId}`;
      const target = `peer-video:${peerId}`;
      logNativeStep('attachNativePeerVideoSurface:start', { peerId, surfaceId, target });
      const result = await attachSurface(surfaceId, target, options.remoteVideoContainer);
      hideLegacyVideoElements();
      return result;
    }

    async function detachPeerVideoSurface(peerId) {
      const surfaceId = `peer-surface:${peerId}`;
      return detachSurface(surfaceId);
    }

    async function updateSurface(surfaceId) {
      if (!options.mediaEngine || typeof options.mediaEngine.updateSurface !== 'function') {
        throw new Error('native-surface-media-engine-unavailable');
      }

      const entry = getSurfaceEntry(surfaceId);
      if (!entry) {
        return null;
      }

      const layout = buildSurfaceLayout(entry.element, { log: false });
      const layoutKey = getSurfaceLayoutKey(layout);
      if (layoutKey === entry.lastLayoutKey) {
        return null;
      }

      const payload = {
        surface: surfaceId,
        ...layout
      };
      if (shouldShowDebugLogsFor('video')) {
        logNativeStep('updateSurface:request', {
          surfaceId,
          target: entry.target,
          payload,
          element: describeSurfaceElement(entry.element)
        });
      }

      let result = null;
      try {
        result = await options.mediaEngine.updateSurface(payload);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (message.includes('Surface is not attached')) {
          removeSurfaceTracking(surfaceId, 'surface-not-attached');
          if (shouldShowDebugLogsFor('video', 'nativeSteps')) {
            logNativeStep('updateSurface:detached-skip', { surfaceId, message }, 'video');
          }
          return null;
        }
        throw error;
      }

      clearRecoverableSurfaceSyncWarning(surfaceId);
      entry.lastLayoutKey = layoutKey;
      if (shouldShowDebugLogsFor('video')) {
        logNativeStep('updateSurface:result', {
          surfaceId,
          result
        });
      }
      return result;
    }

    async function syncAllSurfaces() {
      const jobs = [];
      const maxConsecutiveFailures = getMaxConsecutiveSyncFailures();
      forEachSurface((entry, surfaceId) => {
        jobs.push(updateSurface(surfaceId).catch((error) => {
          logRecoverableSurfaceSyncWarning(surfaceId, error);
          const failureCount = incrementSurfaceFailureCount(surfaceId);
          if (failureCount >= maxConsecutiveFailures) {
            return recoverSurface(surfaceId, entry, 'surface-sync-consecutive-failures').catch((recoverError) => {
              logRecoverableSurfaceSyncWarning(surfaceId, recoverError);
              return null;
            });
          }
          return null;
        }));
      });
      await Promise.all(jobs);
    }

    function scheduleSync() {
      if (!isSurfaceEmbeddingEnabled() || getSurfaceCount() === 0) {
        return;
      }
      if (surfaceSyncRafId) {
        return;
      }
      surfaceSyncRafId = window.requestAnimationFrame(async () => {
        surfaceSyncRafId = 0;
        if (surfaceSyncInFlight) {
          surfaceSyncPending = true;
          return;
        }

        surfaceSyncInFlight = true;
        try {
          await syncAllSurfaces();
        } catch (error) {
          logSyncAllError(error);
        } finally {
          surfaceSyncInFlight = false;
          if (surfaceSyncPending) {
            surfaceSyncPending = false;
            scheduleSync();
          }
        }
      });
    }

    function runWheelDrivenSyncBurst() {
      wheelDrivenSyncRafId = 0;
      if (!isSurfaceEmbeddingEnabled() || getSurfaceCount() === 0) {
        wheelDrivenSyncFramesRemaining = 0;
        return;
      }

      scheduleSync();
      wheelDrivenSyncFramesRemaining -= 1;
      if (wheelDrivenSyncFramesRemaining > 0) {
        wheelDrivenSyncRafId = window.requestAnimationFrame(runWheelDrivenSyncBurst);
      }
    }

    function scheduleWheelDrivenSync() {
      if (!isSurfaceEmbeddingEnabled() || getSurfaceCount() === 0) {
        return;
      }

      wheelDrivenSyncFramesRemaining = getWheelDrivenSyncFrameCount();
      if (!wheelDrivenSyncRafId) {
        wheelDrivenSyncRafId = window.requestAnimationFrame(runWheelDrivenSyncBurst);
      }
    }

    function scheduleWindowBoundsSync() {
      if (!isSurfaceEmbeddingEnabled() || getSurfaceCount() === 0) {
        return;
      }

      invalidateSurfaceLayouts();
      if (!windowBoundsSyncRafId) {
        windowBoundsSyncRafId = window.requestAnimationFrame(() => {
          windowBoundsSyncRafId = 0;
          scheduleSync();
        });
      }

      if (windowBoundsSyncFinalTimerId) {
        window.clearTimeout(windowBoundsSyncFinalTimerId);
      }
      windowBoundsSyncFinalTimerId = window.setTimeout(() => {
        windowBoundsSyncFinalTimerId = 0;
        invalidateSurfaceLayouts();
        scheduleSync();
      }, 120);
    }

    function refreshWindowBounds() {
      if (typeof options.refreshWindowBounds === 'function') {
        return Promise.resolve(options.refreshWindowBounds());
      }
      return Promise.resolve(getCurrentWindowBounds());
    }

    function forceResync() {
      if (!isSurfaceEmbeddingEnabled() || getSurfaceCount() === 0) {
        return;
      }

      const runPass = () => {
        refreshWindowBounds().finally(() => {
          invalidateSurfaceLayouts();
          scheduleSync();
        });
      };

      runPass();
      window.requestAnimationFrame(runPass);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(runPass);
      });
      window.setTimeout(runPass, 80);
      window.setTimeout(runPass, 180);
    }

    function forceResyncBurst() {
      forceResync();
      window.setTimeout(forceResync, 40);
      window.setTimeout(forceResync, 120);
      window.setTimeout(forceResync, 260);
    }

    function setCurrentWindowBounds(bounds) {
      if (typeof options.setCurrentWindowBounds === 'function') {
        options.setCurrentWindowBounds(bounds || null);
      }
    }

    async function bindLayoutEvents() {
      if (layoutEventsBound) {
        return;
      }
      layoutEventsBound = true;

      const electronApi = options.electronApi || null;
      if (electronApi && typeof electronApi.getWindowBounds === 'function') {
        try {
          const bounds = await electronApi.getWindowBounds();
          setCurrentWindowBounds(bounds || null);
        } catch (_error) {
          setCurrentWindowBounds(null);
        }
      }
      if (electronApi && typeof electronApi.onWindowBoundsChange === 'function') {
        electronApi.onWindowBoundsChange((bounds) => {
          setCurrentWindowBounds(bounds || null);
          scheduleWindowBoundsSync(bounds);
        });
      }
      if (electronApi && typeof electronApi.onMaximizedChange === 'function') {
        electronApi.onMaximizedChange(() => {
          refreshWindowBounds().finally(() => {
            forceResyncBurst();
          });
        });
      }

      const syncLayouts = () => {
        scheduleSync();
      };

      if (isSurfaceEmbeddingEnabled() && typeof ResizeObserver !== 'undefined') {
        if (options.hostPreviewElement) {
          const observer = new ResizeObserver(syncLayouts);
          observer.observe(options.hostPreviewElement);
        }

        if (options.remoteVideoContainer) {
          const observer = new ResizeObserver(syncLayouts);
          observer.observe(options.remoteVideoContainer);
        }
      }

      if (isSurfaceEmbeddingEnabled()) {
        window.addEventListener('resize', syncLayouts);
        window.addEventListener('scroll', syncLayouts, true);
        window.addEventListener('wheel', scheduleWheelDrivenSync, {
          capture: true,
          passive: true
        });
        if (window.visualViewport) {
          window.visualViewport.addEventListener('resize', syncLayouts);
          window.visualViewport.addEventListener('scroll', syncLayouts);
        }
      }
    }

    return {
      describeSurfaceElement,
      buildSurfaceLayout,
      getSurfaceLayoutKey,
      getSurfaceCount,
      getSurfaceEntry,
      setSurfaceEntry,
      deleteSurfaceEntry,
      forEachSurface,
      invalidateSurfaceLayouts,
      getSurfaceGeneration,
      setSurfaceGeneration,
      incrementSurfaceGeneration,
      clearSurfaceFailureCount,
      incrementSurfaceFailureCount,
      clearRecoverableSurfaceSyncWarning,
      logRecoverableSurfaceSyncWarning,
      removeSurfaceTracking,
      recoverSurface,
      attachSurface,
      detachSurface,
      attachHostPreviewSurface,
      detachHostPreviewSurface,
      attachPeerVideoSurface,
      detachPeerVideoSurface,
      updateSurface,
      syncAllSurfaces,
      scheduleSync,
      scheduleWheelDrivenSync,
      scheduleWindowBoundsSync,
      forceResync,
      forceResyncBurst,
      bindLayoutEvents,
      startTrackingLoop,
      stopTrackingLoop
    };
  }

  VDS.nativeSurface = { createController, createSurfaceRegistry };
})();
