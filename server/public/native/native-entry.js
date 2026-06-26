(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.nativeEntry) {
    return;
  }

  const state = {
    loaded: true,
    legacyInstallerInvoked: false,
    legacyInstallerCompleted: false,
    legacyInstallerError: null,
    nativePeerTransportEnabled: false
  };

  function installLegacyOverrides(installer) {
    if (typeof installer !== 'function') {
      return false;
    }
    if (state.legacyInstallerInvoked || window.__vdsNativeAuthorityOverridesInstalled) {
      return false;
    }

    state.legacyInstallerInvoked = true;
    try {
      const bindings = installer({ installManagedByEntry: true });
      if (!bindings || typeof bindings !== 'object') {
        state.legacyInstallerCompleted = false;
        return false;
      }
      registerLegacyGlobals(bindings);
      markLegacyOverridesInstalled();
      state.legacyInstallerCompleted = true;
      return true;
    } catch (error) {
      state.legacyInstallerError = error;
      throw error;
    }
  }

  function markLegacyOverridesInstalled() {
    window.__vdsNativeAuthorityOverridesInstalled = true;
    state.legacyInstallerCompleted = true;
  }

  function setRuntimeFlags(flags = {}) {
    state.nativePeerTransportEnabled = Boolean(flags.nativePeerTransportEnabled);
  }

  function isNativePeerDriverActive() {
    return Boolean(state.nativePeerTransportEnabled);
  }

  function registerLegacyGlobals(bindings = {}) {
    window.__vdsNativeAuthorityOverrides = {
      ...(window.__vdsNativeAuthorityOverrides || {}),
      ...(bindings || {})
    };
    Object.keys(bindings).forEach((name) => {
      const value = bindings[name];
      if (typeof value !== 'undefined') {
        window[name] = value;
      }
    });
    return bindings;
  }

  function createRequired(namespaceName, factoryName, errorCode, ...args) {
    const namespace = VDS[namespaceName];
    if (namespace && typeof namespace[factoryName] === 'function') {
      return namespace[factoryName](...args);
    }
    throw new Error(errorCode || `${namespaceName}-${factoryName}-unavailable`);
  }

  function getState() {
    return {
      loaded: state.loaded,
      legacyInstallerInvoked: state.legacyInstallerInvoked,
      legacyInstallerCompleted: state.legacyInstallerCompleted,
      legacyInstallerError: state.legacyInstallerError,
      nativePeerTransportEnabled: state.nativePeerTransportEnabled
    };
  }

  VDS.nativeEntry = {
    installLegacyOverrides,
    markLegacyOverridesInstalled,
    setRuntimeFlags,
    isNativePeerDriverActive,
    registerLegacyGlobals,
    createRequired,
    getState
  };
})();
