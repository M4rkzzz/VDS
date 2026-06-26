(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.nativeMediaEngine) {
    return;
  }

  function createController(options = {}) {
    const mediaEngine = options.mediaEngine || null;
    const logCapabilities = typeof options.logCapabilities === 'function'
      ? options.logCapabilities
      : () => {};
    const eventHandlers = options.eventHandlers || {};
    let started = false;
    let startPromise = null;

    async function ensureStarted() {
      if (started) {
        return null;
      }
      if (startPromise) {
        return startPromise;
      }
      if (!mediaEngine || typeof mediaEngine.start !== 'function') {
        throw new Error('native-media-engine-start-unavailable');
      }

      startPromise = (async () => {
        const status = await mediaEngine.start();
        if (!status || status.available === false || status.running !== true) {
          const reason = status && status.reason ? String(status.reason) : 'media-engine-not-running';
          throw new Error(`native-media-engine-unavailable:${reason}`);
        }
        started = true;
        if (typeof mediaEngine.getCapabilities === 'function') {
          logCapabilities(await mediaEngine.getCapabilities());
        }
        return status;
      })();

      try {
        return await startPromise;
      } finally {
        startPromise = null;
      }
    }

    function handleEvent(event) {
      if (!event || !event.event) {
        return false;
      }
      if (event.event === 'signal') {
        if (typeof eventHandlers.onSignal === 'function') {
          eventHandlers.onSignal(event.params || {});
        }
        return true;
      }
      if (event.event === 'peer-state') {
        if (typeof eventHandlers.onPeerState === 'function') {
          eventHandlers.onPeerState(event.params || {});
        }
        return true;
      }
      if (event.event === 'media-state') {
        if (typeof eventHandlers.onMediaState === 'function') {
          eventHandlers.onMediaState(event.params || {});
        }
        return true;
      }
      return false;
    }

    return {
      ensureStarted,
      isStarted: () => started,
      handleEvent
    };
  }

  VDS.nativeMediaEngine = { createController };
})();
