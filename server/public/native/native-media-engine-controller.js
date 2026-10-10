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
    let lifecycleGeneration = 0;

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

      const generation = lifecycleGeneration;
      const operation = (async () => {
        const status = await mediaEngine.start();
        if (!status || status.available === false || status.running !== true) {
          const reason = status && status.reason ? String(status.reason) : 'media-engine-not-running';
          throw new Error(`native-media-engine-unavailable:${reason}`);
        }
        if (typeof mediaEngine.getCapabilities === 'function') {
          logCapabilities(await mediaEngine.getCapabilities());
        }
        if (generation !== lifecycleGeneration) {
          throw new Error('native-media-engine-start-superseded');
        }
        started = true;
        return status;
      })();
      startPromise = operation;

      try {
        return await operation;
      } finally {
        if (startPromise === operation) {
          startPromise = null;
        }
      }
    }

    function handleStatus(status) {
      if (!status || status.running !== false || status.state === 'starting') {
        return false;
      }
      // did-finish-load can deliver the initial availability snapshot after
      // ensureStarted has begun. Idle is not an exit from that startup.
      if (!started && status.state === 'idle' && status.reason !== 'stopped') {
        return false;
      }
      started = false;
      lifecycleGeneration += 1;
      return true;
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
      handleStatus,
      handleEvent
    };
  }

  VDS.nativeMediaEngine = { createController };
})();
