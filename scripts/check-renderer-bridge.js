const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const appPath = path.join(root, 'server', 'public', 'app.js');
const nativePath = path.join(root, 'server', 'public', 'app-native-overrides.js');

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function normalizeParam(param) {
  return String(param || '')
    .trim()
    .replace(/^\.\.\./, '')
    .split('=')[0]
    .trim();
}

function splitParams(paramsText) {
  return String(paramsText || '')
    .split(',')
    .map(normalizeParam)
    .filter(Boolean);
}

function collectFunctions(source) {
  const functions = new Map();
  const regex = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  for (const match of source.matchAll(regex)) {
    functions.set(match[1], splitParams(match[2]));
  }
  return functions;
}

function collectDeclaredNames(source) {
  const declared = new Set();
  for (const [name] of collectFunctions(source)) {
    declared.add(name);
  }
  const variableRegex = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  for (const match of source.matchAll(variableRegex)) {
    declared.add(match[1]);
  }
  return declared;
}

function collectNativeOverrideCalls(source) {
  const calls = [];
  const regex = /requireNativeAuthorityOverride\('([^']+)',\s*([A-Za-z_$][\w$]*)\)\(([^)]*)\)/g;
  for (const match of source.matchAll(regex)) {
    calls.push({
      overrideName: match[1],
      fallbackName: match[2],
      args: splitParams(match[3])
    });
  }
  return calls;
}

function collectLegacyBindings(source) {
  const bindingsMatch = source.match(/const legacyGlobalBindings = \{([\s\S]*?)\n  \};/);
  if (!bindingsMatch) {
    return { names: [], shorthands: [] };
  }
  const names = [];
  const shorthands = [];
  for (const line of bindingsMatch[1].split(/\r?\n/)) {
    const trimmed = line.trim().replace(/,$/, '');
    if (!trimmed || trimmed.startsWith('//')) {
      continue;
    }
    const shorthandMatch = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
    if (shorthandMatch) {
      names.push(shorthandMatch[1]);
      shorthands.push(shorthandMatch[1]);
      continue;
    }
    const propertyMatch = /^([A-Za-z_$][\w$]*)\s*:/.exec(trimmed);
    if (propertyMatch) {
      names.push(propertyMatch[1]);
    }
  }
  return { names, shorthands };
}

function assertNoSnippets(source, snippets, errors, messagePrefix) {
  for (const snippet of snippets) {
    if (source.includes(snippet)) {
      errors.push(`${messagePrefix}: ${snippet}`);
    }
  }
}

function main() {
  const appSource = readSource(appPath);
  const nativeSource = readSource(nativePath);
  const nativeSessionSource = readSource(path.join(root, 'server', 'public', 'native', 'native-session-controller.js'));
  const nativeEntrySource = readSource(path.join(root, 'server', 'public', 'native', 'native-entry.js'));
  const appFunctions = collectFunctions(appSource);
  const nativeFunctions = collectFunctions(nativeSource);
  const nativeDeclaredNames = collectDeclaredNames(nativeSource);
  const nativeLegacyBindings = collectLegacyBindings(nativeSource);
  const nativeLegacyBindingNames = new Set(nativeLegacyBindings.names);
  const errors = [];

  for (const call of collectNativeOverrideCalls(appSource)) {
    const fallbackParams = appFunctions.get(call.fallbackName);
    if (!fallbackParams) {
      errors.push(`Missing app fallback function for override ${call.overrideName}: ${call.fallbackName}`);
      continue;
    }

    if (!nativeFunctions.has(call.overrideName) && !nativeLegacyBindingNames.has(call.overrideName)) {
      errors.push(`Missing native override function: ${call.overrideName}`);
    }

    const missingArgs = fallbackParams.filter((param) => !call.args.includes(param));
    if (missingArgs.length > 0) {
      errors.push(
        `Override ${call.overrideName} wrapper does not forward parameter(s): ${missingArgs.join(', ')}`
      );
    }
  }

  for (const name of nativeLegacyBindings.shorthands) {
    if (!nativeDeclaredNames.has(name)) {
      errors.push(`legacyGlobalBindings shorthand references an undeclared local: ${name}`);
    }
  }

  if (nativeSource.includes('function scheduleDisconnectedPeerRecovery(') ||
      nativeSource.includes('scheduleDisconnectedPeerRecovery:')) {
    errors.push('Disconnected recovery timer actions must stay inside native-peer-controller, not app-native-overrides.');
  }

  if (!nativeSource.includes("createRequired('nativeRendererState', 'createController'")) {
    errors.push('app-native-overrides must create nativeRendererState controller for renderer state patching.');
  }
  if (!nativeSource.includes('roomIdDisplay: elements.roomIdDisplay')) {
    errors.push('nativeRendererState controller must receive roomIdDisplay so host room-created can render the room id.');
  }
  if (!nativeSource.includes("createRequired('nativeRendererState', 'createAppStateSyncBridge'")) {
    errors.push('app-native-overrides must create nativeRendererState app-state sync bridge.');
  }

  assertNoSnippets(nativeSource, [
    'function applyNativeRendererStatePatch(',
    'return window.__vdsSyncAppState({',
    'mediaManifest: currentMediaManifest || null,',
    "Object.prototype.hasOwnProperty.call(patch, 'currentRoomId')",
    "Object.prototype.hasOwnProperty.call(patch, 'sessionRole')",
    "Object.prototype.hasOwnProperty.call(patch, 'currentSessionToken')",
    'setViewerRoomState: (state) => {',
    'setHostRoomState: (state) => {',
    'setSessionRoomState: (state) => {',
    'setViewerResumeState: (state) => {',
    'setUpstreamPeerId: (peerId) => {',
    'setChainPosition: (chainPosition) => {',
    'markViewerRoomJoinedPending: () => {',
    'viewerReadySent = false;',
    'videoStarted = false;',
    'upstreamConnected = false;'
  ], errors, 'Renderer room/viewer state patching must go through native-renderer-state-controller');

  assertNoSnippets(nativeSource, [
    'function beginNativeStopShare(',
    'function startNativeAudioForShare(',
    'nativeSessionController.startNativeAudioForShare({',
    "native-audio-session:start-failed', error",
    "showError('原生音频启动失败，将仅共享画面')",
    'nativeSessionController.beginStopShare({',
    'nativeSessionController.cleanupStopResources()',
    'nativeSessionController.finalizeStopState()',
    'nativeSessionController.finishStopShare()',
    'nativeSessionController.buildHostStartBeginEffects({ backend: \'native\' })',
    'nativeSessionController.buildHostStartBeginEffects({ backend: \'obs-ingest\' })',
    'nativeSessionController.prepareNativeCaptureHostStart(sourceId)',
    'nativeSessionController.buildNativePreviewStartState({ nativeHostPreviewEnabled })',
    'nativeSessionController.startHostSession(parsedSource)',
    'nativeSessionController.startHostSession({\n        backend: \'obs-ingest\'',
    'nativeSessionController.createNativeCaptureHostRoom({',
    'function finalizeP2pFailureWithNatMapping(',
    'function requestPeerRecovery(',
    'function handleNativePeerStateEvent(',
    'function forwardNativeMediaSignal(',
    'function applyNativeMediaStateUpdate(',
    'function createNativePeerConnectionImpl(',
    'function closeNativePeerConnectionImpl(',
    'function clearNativePeerConnectionsImpl(',
    'function createAndSendPeerOffer(',
    'function supportsDataChannelEncodedMedia(',
    'function createNonRetryableRelayError(',
    'function resetNativeRoomStateAfterStop(',
    'function resetNativePlaybackStateAfterStop(',
    'function resetNativeStopUiAfterStop(',
    'function resetObsRoomStatePreservingSession(',
    'function resetObsPlaybackStatePreservingSession(',
    'function resetObsRoomUiWaitingForStream(',
    'function teardownHostRoomPreservingSession(',
    'function ensureObsHostRoomCreated(',
    'function setViewerConnectionState(',
    'function setHostStopUiState(',
    'function syncHostWaitingWindowRestoreUi(',
    'elements.roomInfo.classList.add(\'hidden\');',
    'elements.viewerCount.textContent = \'0\';',
    'setRoomInfoHidden: (hidden) => elements.roomInfo.classList.toggle',
    'setViewerCount: (count) => {\n        elements.viewerCount.textContent',
    'setShareButtons: (sharing) => {\n        elements.btnStartShare.classList.toggle',
    'setHostStatus: (text, waiting) => {\n        elements.hostStatus.textContent',
    'setObsCreatingRoomUi: () => {\n        if (elements.hostStatus)',
    'function stopNativeViewerStatsPolling(',
    'function resetHostFpsIndicators(',
    'function updateHostFpsIndicators(',
    'function resetViewerFpsIndicator(',
    'function updateViewerFpsIndicator(',
    'function stopNativeHostStatsPolling(',
    'function updateHostEncoderDetail(',
    'function pollNativeHostStats(',
    'function startNativeHostStatsPolling(',
    'function pollNativeViewerStats(',
    'function startNativeViewerStatsPolling(',
    'function attemptLastChanceNatMapping(',
    'prepareP2pFailureFinalization(',
    'finalizeP2pConnectionFailureAndApply(',
    'attemptLastChanceNatMapping(',
    'nativePeerController.clearSignalState(',
    'nativePeerController.createPeerHandle(',
    'nativePeerController.initializePeerMetaForHandle(',
    'nativePeerController.preparePeerCloseCleanup(',
    'nativePeerController.closePeer(',
    'nativePeerController.applyPeerCloseCleanupEffects(',
    'closePeer: (peerId, closeOptions)',
    'closePeer: (targetPeerId)',
    'createPeer: (targetPeerId'
  ], errors, 'Native lifecycle internals must stay inside native controllers, not app-native-overrides');

  if (!nativeSessionSource.includes('function validateAudioStartResult(result = {})')) {
    errors.push('native-session-controller must own native audio start result validation.');
  }
  if (!nativeSessionSource.includes("Object.prototype.hasOwnProperty.call(result, 'captureActive')") ||
      !nativeSessionSource.includes("Object.prototype.hasOwnProperty.call(result, 'ready')")) {
    errors.push('native-session-controller audio validation must inspect captureActive/audioCaptureActive and ready fields.');
  }
  if (!nativeSessionSource.includes('const validation = validateAudioStartResult(result);')) {
    errors.push('startNativeAudioForShare must return normalized validation output from validateAudioStartResult.');
  }
  for (const requiredSessionExport of [
    'function buildHostSessionStoppedEffects()',
    'function buildObsMediaStateEffects(params = {})'
  ]) {
    if (!nativeSessionSource.includes(requiredSessionExport)) {
      errors.push(`native-session-controller missing required implementation: ${requiredSessionExport}`);
    }
  }
  if (/markLegacyOverridesInstalled\(\);\s*const bindings = installer/.test(nativeEntrySource)) {
    errors.push('native-entry must not mark native authority installed before registering installer bindings.');
  }
  if (!/registerLegacyGlobals\(bindings\);\s*markLegacyOverridesInstalled\(\);/.test(nativeEntrySource)) {
    errors.push('native-entry must register legacy globals before marking native authority installed.');
  }
  if (!nativeEntrySource.includes('window.__vdsNativeAuthorityOverrides = {')) {
    errors.push('native-entry must keep a dedicated native authority override registry, not only window globals.');
  }
  if (!appSource.includes('const registry = window.__vdsNativeAuthorityOverrides;') ||
      !appSource.includes('return registry[name];')) {
    errors.push('app.js must resolve native authority overrides from the dedicated registry before window global fallback.');
  }

  const nativePeerSource = readSource(path.join(root, 'server', 'public', 'native', 'native-peer-controller.js'));
  assertNoSnippets(nativePeerSource, [
    'armPeerDisconnectTimer,',
    'prepareDisconnectedRecovery,',
    'prepareDisconnectedRecoveryRetry,',
    'prepareP2pFailureFinalization,',
    'finalizeP2pConnectionFailure,',
    'finalizeP2pConnectionFailureAndApply,',
    'attemptLastChanceNatMapping,',
    'initializePeerMetaForHandle,',
    'createPeerHandle,',
    'clearSignalState,',
    'closePeer,',
    'preparePeerCloseCleanup,',
    'buildPeerCloseCleanupEffects,',
    'applyPeerCloseCleanupEffects,'
  ], errors, 'native-peer-controller public API leaks renderer-internal recovery/failure helper');

  const roomMessageSource = readSource(path.join(root, 'server', 'public', 'native', 'native-room-message-controller.js'));
  assertNoSnippets(roomMessageSource, [
    'elements.viewerCount',
    'elements.roomInfo',
    'elements.btnStartShare',
    'elements.btnStopShare',
    'elements.hostStatus',
    'elements.joinForm',
    'elements.viewerStatus',
    'elements.viewerRoomId',
    'elements.btnLeave',
    'elements.chainPosition',
    'elements.connectionStatus'
  ], errors, 'native-room-message-controller must not own room/viewer DOM; use native-renderer-state-controller');

  const peerMessageSource = readSource(path.join(root, 'server', 'public', 'native', 'native-peer-message-controller.js'));
  assertNoSnippets(peerMessageSource, [
    'const elements =',
    'options.elements',
    'elements.viewerCount',
    'elements.chainPosition',
    'elements.connectionStatus'
  ], errors, 'native-peer-message-controller must not own room/viewer DOM; use native-renderer-state-controller');

  if (errors.length > 0) {
    console.error('Renderer bridge check failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log('Renderer bridge check passed.');
}

main();
