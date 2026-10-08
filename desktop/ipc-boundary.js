'use strict';

const MAX_PEER_ID_BYTES = 256;
const MAX_SDP_BYTES = 1024 * 1024;
const MAX_ICE_BYTES = 16 * 1024;

const NO_ARGUMENT_CHANNELS = new Set([
  'get-app-version', 'get-update-log-snapshot', 'media-engine-start',
  'media-engine-list-capture-targets', 'media-engine-audio-is-platform-supported',
  'media-engine-audio-check-permission', 'media-engine-audio-get-process-list',
  'media-engine-get-viewer-volume', 'media-engine-get-capabilities',
  'window-is-maximized', 'window-get-bounds', 'window-get-cursor-screen-point',
  'window-is-fullscreen', 'window-minimize', 'window-minimize-to-tray',
  'window-maximize', 'window-close', 'check-for-updates', 'download-update',
  'quit-and-install'
]);

const OPTION_CHANNELS = new Set([
  'media-engine-get-capture-target-thumbnail', 'media-engine-start-host-session',
  'media-engine-stop-host-session', 'media-engine-prepare-obs-ingest',
  'media-engine-start-audio-session', 'media-engine-stop-audio-session',
  'media-engine-create-peer', 'media-engine-close-peer',
  'media-engine-set-remote-description', 'media-engine-add-remote-ice-candidate',
  'media-engine-attach-peer-media-source', 'media-engine-detach-peer-media-source',
  'media-engine-attach-surface', 'media-engine-update-surface',
  'media-engine-detach-surface', 'media-engine-set-viewer-audio-delay',
  'media-engine-get-stats', 'p2p-open-nat-mapping'
]);

function boundaryError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

function invalid(field) {
  throw boundaryError('IPC_INVALID_ARGUMENT', field);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkString(value, field, { required = false, maxBytes = Infinity } = {}) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || (required && !value.trim()) ||
      (maxBytes !== Infinity && Buffer.byteLength(value, 'utf8') > maxBytes)) invalid(field);
}

function checkNumber(value, field, { required = false, minimum = -Infinity, maximum = Infinity, integer = false } = {}) {
  if (value === undefined && !required) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum ||
      (integer && !Number.isSafeInteger(value))) invalid(field);
}

function checkBoolean(value, field, required = false) {
  if (value === undefined && !required) return;
  if (typeof value !== 'boolean') invalid(field);
}

// Preserve extensible JSON options, but do not let JSON.stringify silently turn
// non-finite numbers into null or throw on cyclic values in the agent bridge.
function checkJsonValues(value, field) {
  const active = new WeakSet();
  const stack = [{ value, field, leave: false }];
  while (stack.length) {
    const item = stack.pop();
    const current = item.value;
    if (item.leave) {
      active.delete(current);
      continue;
    }
    if (current === null || current === undefined || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number') {
      checkNumber(current, item.field);
      continue;
    }
    if (typeof current !== 'object' || (!Array.isArray(current) && !isRecord(current)) || active.has(current)) invalid(item.field);
    active.add(current);
    stack.push({ value: current, leave: true });
    for (const [key, child] of Object.entries(current)) {
      stack.push({ value: child, field: `${item.field}.${key}`, leave: false });
    }
  }
}

function checkCandidate(candidate, field) {
  if (typeof candidate === 'string') {
    checkString(candidate, field, { maxBytes: MAX_ICE_BYTES });
    return;
  }
  if (!isRecord(candidate)) invalid(field);
  checkString(candidate.candidate, `${field}.candidate`, { required: true, maxBytes: MAX_ICE_BYTES });
  if (candidate.sdpMid !== null) checkString(candidate.sdpMid, `${field}.sdpMid`, { maxBytes: MAX_PEER_ID_BYTES });
  if (candidate.sdpMLineIndex !== null) checkNumber(candidate.sdpMLineIndex, `${field}.sdpMLineIndex`, { minimum: 0, integer: true });
  checkString(candidate.usernameFragment, `${field}.usernameFragment`, { maxBytes: MAX_ICE_BYTES });
}

function checkManifest(manifest, field) {
  if (manifest === undefined || manifest === null) return;
  if (!isRecord(manifest)) invalid(field);
  checkString(manifest.mediaSessionId, `${field}.mediaSessionId`);
  checkNumber(manifest.manifestVersion, `${field}.manifestVersion`, { minimum: 0, integer: true });
  for (const key of ['video', 'audio']) {
    const stream = manifest[key];
    if (stream === undefined || stream === null) continue;
    if (!isRecord(stream)) invalid(`${field}.${key}`);
    checkString(stream.codec, `${field}.${key}.codec`);
    for (const numeric of ['width', 'height', 'frameRate', 'bitrateKbps', 'sampleRate', 'channels']) {
      checkNumber(stream[numeric], `${field}.${key}.${numeric}`, { minimum: 0 });
    }
    checkBoolean(stream.enabled, `${field}.${key}.enabled`);
  }
}

function checkIceServers(servers, field) {
  if (servers === undefined) return;
  if (!Array.isArray(servers)) invalid(field);
  for (const [index, server] of servers.entries()) {
    if (typeof server === 'string') {
      checkString(server, `${field}.${index}`, { required: true, maxBytes: MAX_ICE_BYTES });
      continue;
    }
    if (!isRecord(server)) invalid(`${field}.${index}`);
    const urls = server.urls === undefined ? server.url : server.urls;
    if (typeof urls === 'string') {
      checkString(urls, `${field}.${index}.urls`, { required: true, maxBytes: MAX_ICE_BYTES });
    } else if (Array.isArray(urls)) {
      for (const url of urls) checkString(url, `${field}.${index}.urls`, { required: true, maxBytes: MAX_ICE_BYTES });
    } else invalid(`${field}.${index}.urls`);
    checkString(server.username, `${field}.${index}.username`);
    checkString(server.credentialType, `${field}.${index}.credentialType`);
  }
}

function checkOptions(channel, options) {
  if (options === undefined) options = {};
  if (!isRecord(options)) invalid(`${channel}.options`);
  checkJsonValues(options, channel);
  const peerChannel = channel.includes('-peer') || channel === 'media-engine-set-remote-description' || channel === 'media-engine-add-remote-ice-candidate';
  checkString(options.peerId, `${channel}.peerId`, { required: peerChannel, maxBytes: MAX_PEER_ID_BYTES });
  checkString(options.sdp, `${channel}.sdp`, { required: channel === 'media-engine-set-remote-description', maxBytes: MAX_SDP_BYTES });
  if (channel === 'media-engine-set-remote-description') {
    if (!['offer', 'answer', 'pranswer', 'rollback'].includes(options.type)) invalid(`${channel}.type`);
  }
  if (channel === 'media-engine-add-remote-ice-candidate') {
    checkString(options.candidate, `${channel}.candidate`, { required: true, maxBytes: MAX_ICE_BYTES });
  }
  for (const key of ['role', 'source', 'surface', 'target', 'transportGeneration', 'mediaSessionId', 'sessionId',
    'backend', 'captureTargetId', 'captureHwnd', 'captureKind', 'captureState', 'requestedCodec', 'effectiveCodec',
    'codec', 'reason', 'lastError', 'processName', 'sourceId', 'id', 'hwnd', 'windowHandle', 'title', 'name', 'kind',
    'sdpMid', 'parentWindowHandle']) {
    checkString(options[key], `${channel}.${key}`);
  }
  for (const key of ['initiator', 'encodedMediaDataChannel', 'embedded', 'visible', 'refresh']) {
    checkBoolean(options[key], `${channel}.${key}`);
  }
  for (const key of ['width', 'height', 'frameRate', 'bitrateKbps', 'lifetimeSeconds', 'timeoutMs']) {
    checkNumber(options[key], `${channel}.${key}`, { minimum: 0 });
  }
  for (const key of ['x', 'y', 'delayMs']) checkNumber(options[key], `${channel}.${key}`);
  for (const key of ['pid', 'audioPid', 'sdpMLineIndex']) {
    checkNumber(options[key], `${channel}.${key}`, { minimum: 0, integer: true });
  }
  checkNumber(options.port, `${channel}.port`, { minimum: 0, maximum: 65535, integer: true });
  checkManifest(options.mediaManifest, `${channel}.mediaManifest`);
  checkIceServers(options.iceServers, `${channel}.iceServers`);
  if (options.candidates !== undefined) {
    if (!Array.isArray(options.candidates)) invalid(`${channel}.candidates`);
    options.candidates.forEach((candidate, index) => checkCandidate(candidate, `${channel}.candidates.${index}`));
  }
  if (channel.endsWith('-surface')) checkString(options.surface, `${channel}.surface`, { required: true });
  if (channel === 'media-engine-attach-surface') checkString(options.target, `${channel}.target`, { required: true });
  if (channel === 'media-engine-attach-peer-media-source') checkString(options.source, `${channel}.source`, { required: true });
  if (channel === 'media-engine-get-capture-target-thumbnail') {
    checkString(options.sourceId === undefined ? options.id : options.sourceId, `${channel}.sourceId`, { required: true });
  }
  if (channel === 'media-engine-set-viewer-audio-delay') checkNumber(options.delayMs, `${channel}.delayMs`, { required: true });
}

function checkArguments(channel, args) {
  if (NO_ARGUMENT_CHANNELS.has(channel)) {
    if (args.length !== 0) invalid(`${channel}.arguments`);
    return;
  }
  if (args.length > 1) invalid(`${channel}.arguments`);
  if (OPTION_CHANNELS.has(channel)) {
    checkOptions(channel, args[0]);
    return;
  }
  if (channel === 'clipboard-write-text') {
    checkString(args[0], `${channel}.text`, { required: true });
  } else if (channel === 'window-set-fullscreen') {
    checkBoolean(args[0], `${channel}.enabled`, true);
  } else if (channel === 'media-engine-set-viewer-volume') {
    checkNumber(args[0], `${channel}.volume`, { required: true, minimum: 0, maximum: 1 });
  } else if (channel === 'renderer-debug-config-changed') {
    const config = args[0];
    if (typeof config === 'boolean') return;
    if (!isRecord(config)) invalid(`${channel}.config`);
    checkJsonValues(config, channel);
    for (const [key, value] of Object.entries(config)) {
      if (key === 'categories' || key === 'channels') {
        if (!isRecord(value)) invalid(`${channel}.${key}`);
        for (const [name, flag] of Object.entries(value)) checkBoolean(flag, `${channel}.${key}.${name}`, true);
      } else checkBoolean(value, `${channel}.${key}`, true);
    }
  } else {
    throw boundaryError('IPC_UNKNOWN_CHANNEL', channel);
  }
}

function createIpcBoundary({ getWindow, entryUrl, onRejected = () => {} }) {
  if (typeof getWindow !== 'function' || typeof entryUrl !== 'string' || !entryUrl.startsWith('file:')) {
    throw new TypeError('IPC boundary requires getWindow and an exact file entryUrl');
  }
  const reportRejected = (error, channel) => {
    try { onRejected(error, channel); } catch { /* Reporting must not crash a fire-and-forget IPC handler. */ }
  };
  function validate(event, channel, args) {
    const window = getWindow();
    const contents = window && window.webContents;
    if (!contents || (typeof window.isDestroyed === 'function' && window.isDestroyed()) ||
        (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) ||
        !event || event.sender !== contents || !event.senderFrame ||
        event.senderFrame !== contents.mainFrame || event.senderFrame.url !== entryUrl) {
      throw boundaryError('IPC_UNTRUSTED_SENDER', channel);
    }
    checkArguments(channel, args);
  }
  return {
    handle(ipcMain, channel, handler) {
      ipcMain.handle(channel, async (event, ...args) => {
        try { validate(event, channel, args); } catch (error) {
          reportRejected(error, channel);
          throw error;
        }
        return handler(event, ...args);
      });
    },
    on(ipcMain, channel, handler) {
      ipcMain.on(channel, (event, ...args) => {
        try {
          validate(event, channel, args);
          Promise.resolve(handler(event, ...args)).catch((error) => reportRejected(error, channel));
        } catch (error) {
          reportRejected(error, channel);
        }
      });
    }
  };
}

module.exports = { createIpcBoundary };
