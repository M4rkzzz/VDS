(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.state) {
    return;
  }

  const DEFAULT_STATE = Object.freeze({
    role: null,
    roomId: null,
    clientId: null,
    sessionToken: null,
    hostId: null,
    upstreamPeerId: null,
    chainPosition: -1,
    viewerCount: 0,
    mediaManifest: null,
    connectionState: 'idle'
  });

  const state = { ...DEFAULT_STATE };
  const listeners = new Set();
  const generations = new Map();

  function cloneState() {
    return { ...state };
  }

  function notifyListeners(changed, metadata) {
    const snapshot = cloneState();
    listeners.forEach((listener) => {
      try {
        listener(snapshot, changed, metadata);
      } catch (error) {
        // State listeners must not break app startup or signaling flow.
        window.setTimeout(() => {
          throw error;
        }, 0);
      }
    });
    return snapshot;
  }

  function patch(update, metadata = {}) {
    if (!update || typeof update !== 'object') {
      return cloneState();
    }

    const changed = {};
    let hasChanges = false;

    Object.keys(update).forEach((key) => {
      if (state[key] !== update[key]) {
        state[key] = update[key];
        changed[key] = update[key];
        hasChanges = true;
      }
    });

    if (!hasChanges) {
      return cloneState();
    }

    return notifyListeners(changed, metadata);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      return function noopUnsubscribe() {};
    }
    listeners.add(listener);
    return function unsubscribe() {
      listeners.delete(listener);
    };
  }

  function nextGeneration(scope = 'default') {
    const normalizedScope = String(scope || 'default');
    const generation = (generations.get(normalizedScope) || 0) + 1;
    generations.set(normalizedScope, generation);
    return generation;
  }

  function getGeneration(scope = 'default') {
    return generations.get(String(scope || 'default')) || 0;
  }

  function reset(update = {}) {
    const nextState = {
      ...DEFAULT_STATE,
      ...(update && typeof update === 'object' ? update : {})
    };
    const changed = {};

    Object.keys(state).forEach((key) => {
      if (!(key in nextState)) {
        changed[key] = undefined;
      }
    });
    Object.keys(nextState).forEach((key) => {
      if (state[key] !== nextState[key]) {
        changed[key] = nextState[key];
      }
    });
    Object.keys(state).forEach((key) => {
      delete state[key];
    });
    Object.assign(state, nextState);

    if (Object.keys(changed).length === 0) {
      return cloneState();
    }

    return notifyListeners(changed, { reason: 'reset' });
  }

  VDS.state = {
    getSnapshot: cloneState,
    patch,
    subscribe,
    nextGeneration,
    getGeneration,
    reset
  };
})();
