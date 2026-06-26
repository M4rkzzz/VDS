const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const roomClientPath = path.join(root, 'server', 'public', 'room-client.js');
const nativeOverridesPath = path.join(root, 'server', 'public', 'app-native-overrides.js');
const nativeRoomMessagesPath = path.join(root, 'server', 'public', 'native', 'native-room-message-controller.js');
const nativePeerMessagesPath = path.join(root, 'server', 'public', 'native', 'native-peer-message-controller.js');
const nativeSessionControllerPath = path.join(root, 'server', 'public', 'native', 'native-session-controller.js');
const source = fs.readFileSync(roomClientPath, 'utf8');
const nativeOverridesSource = fs.readFileSync(nativeOverridesPath, 'utf8');
const nativeRoomMessagesSource = fs.readFileSync(nativeRoomMessagesPath, 'utf8');
const nativePeerMessagesSource = fs.readFileSync(nativePeerMessagesPath, 'utf8');
const nativeSessionControllerSource = fs.readFileSync(nativeSessionControllerPath, 'utf8');

const requiredSnippets = [
  'const messageHandlers = new Map();',
  'function registerMessageHandler(type, handler)',
  'function unregisterMessageHandler(type, handler)',
  'function getRegisteredMessageTypes()',
  'async function dispatchMessage(data)',
  'await dispatchMessage(data);',
  'registerMessageHandler,',
  'unregisterMessageHandler,',
  'getRegisteredMessageTypes,',
  'dispatchMessage,'
];

const migratedRoomMessageHandlers = [
  {
    type: 'viewer-count-updated',
    declaration: 'function handleViewerCountUpdatedMessage(data)',
    registration: "roomClient.registerMessageHandler('viewer-count-updated', handleViewerCountUpdatedMessage);"
  },
  {
    type: 'viewer-left',
    declaration: 'async function handleViewerLeftMessage(data)',
    registration: "roomClient.registerMessageHandler('viewer-left', handleViewerLeftMessage);"
  },
  {
    type: 'host-disconnected',
    declaration: 'async function handleHostDisconnectedMessage()',
    registration: "roomClient.registerMessageHandler('host-disconnected', handleHostDisconnectedMessage);"
  },
  {
    type: 'error',
    declaration: 'async function handleErrorMessage(data)',
    registration: "roomClient.registerMessageHandler('error', handleErrorMessage);"
  },
  {
    type: 'room-joined',
    declaration: 'async function handleRoomJoinedMessage(data)',
    registration: "roomClient.registerMessageHandler('room-joined', handleRoomJoinedMessage);"
  },
  {
    type: 'room-created',
    declaration: 'async function handleRoomCreatedMessage(data)',
    registration: "roomClient.registerMessageHandler('room-created', handleRoomCreatedMessage);"
  },
  {
    type: 'session-resumed',
    declaration: 'async function handleSessionResumedMessage(data)',
    registration: "roomClient.registerMessageHandler('session-resumed', handleSessionResumedMessage);"
  }
];

const migratedPeerMessageHandlers = [
  {
    type: 'viewer-joined',
    declaration: 'async function handleViewerJoinedMessage(data)',
    registration: "roomClient.registerMessageHandler('viewer-joined', handleViewerJoinedMessage);"
  },
  {
    type: 'connect-to-next',
    declaration: 'async function handleConnectToNextMessage(data)',
    registration: "roomClient.registerMessageHandler('connect-to-next', handleConnectToNextMessage);"
  },
  {
    type: 'chain-reconnect',
    declaration: 'async function handleChainReconnectMessage(data)',
    registration: "roomClient.registerMessageHandler('chain-reconnect', handleChainReconnectMessage);"
  },
  {
    type: 'answer',
    declaration: 'async function handleAnswerMessage(data)',
    registration: "roomClient.registerMessageHandler('answer', handleAnswerMessage);"
  },
  {
    type: 'ice-candidate',
    declaration: 'async function handleIceCandidateMessage(data)',
    registration: "roomClient.registerMessageHandler('ice-candidate', handleIceCandidateMessage);"
  },
  {
    type: 'offer',
    declaration: 'async function handleOfferMessage(data)',
    registration: "roomClient.registerMessageHandler('offer', handleOfferMessage);"
  }
];

const nativeOverrideHandlers = [];

const errors = [];
for (const snippet of requiredSnippets) {
  if (!source.includes(snippet)) {
    errors.push(`Missing room-client dispatcher snippet: ${snippet}`);
  }
}

if (source.includes("callAdapter('handleMessage'")) {
  errors.push('Dispatcher still falls back through legacy handleMessage adapter.');
}

if (!source.includes('function handleUnhandledMessage(data)')) {
  errors.push('Dispatcher does not own unknown-message fallback.');
}

if (!source.includes('return handleUnhandledMessage(data);')) {
  errors.push('Dispatcher does not route unknown messages through room-client fallback.');
}

if (nativeOverridesSource.includes('switch (data.type)')) {
  errors.push('Native override still owns a data.type message switch.');
}

if (/roomClient\.registerMessageHandler\s*\(/.test(nativeOverridesSource)) {
  errors.push('Native override must not directly register room-client message handlers; use native message controllers.');
}

if (!nativeOverridesSource.includes('nativeRoomMessages.registerHandlers();')) {
  errors.push('Native room message controller is not registered by native overrides.');
}

if (!nativeOverridesSource.includes('nativePeerMessages.registerHandlers();')) {
  errors.push('Native peer message controller is not registered by native overrides.');
}

if (nativeRoomMessagesSource.includes("type: 'leave-room'")) {
  errors.push('Native room message controller must send leave-room through roomClient.leaveRoom().');
}

if (nativeSessionControllerSource.includes("type: 'create-room'")) {
  errors.push('Native session controller must pass create-room options to roomClient.createRoom(), not hand-build create-room payloads.');
}

if (!nativeSessionControllerSource.includes('function buildHostCreateRoomOptions(options = {})') || nativeSessionControllerSource.includes('buildHostCreateRoomMessage')) {
  errors.push('Native session controller must expose buildHostCreateRoomOptions() instead of buildHostCreateRoomMessage().');
}

if (!nativeRoomMessagesSource.includes('function sendLeaveRoom(optionsForLeave = {})') || !nativeRoomMessagesSource.includes('return roomClient.leaveRoom(optionsForLeave);')) {
  errors.push('Native room message controller does not delegate leave-room through roomClient.leaveRoom().');
}

if (nativeOverridesSource.includes('      sendMessage: (message, options) => sendMessage(message, options),')) {
  errors.push('Native room message controller should not receive a generic sendMessage injection.');
}

if (!source.includes('function buildViewerReconnectReadyMessage(options = {})') || !source.includes('function sendViewerReconnectReady(options = {})')) {
  errors.push('Room client must own viewer-reconnect-ready message construction and sending.');
}

if (!source.includes('function buildViewerReadyMessage(options = {})') || !source.includes('function sendViewerReady(options = {})')) {
  errors.push('Room client must own viewer-ready message construction and sending.');
}

const nativeStatsInjectionBlock = nativeOverridesSource.match(/const nativeStatsController = nativeEntry\.createRequired\('nativeStats'[\s\S]*?\n    \}\);/);
if (!nativeStatsInjectionBlock || !nativeStatsInjectionBlock[0].includes('      roomClient,')) {
  errors.push('Native stats controller must receive roomClient for viewer-ready sending.');
}
if (nativeStatsInjectionBlock && nativeStatsInjectionBlock[0].includes('sendMessage: (message) => sendMessage(message)')) {
  errors.push('Native stats controller should not receive a generic sendMessage injection for viewer-ready.');
}

if (nativeOverridesSource.includes("type: 'viewer-ready'")) {
  errors.push('Native override must not hand-build viewer-ready payloads.');
}

if (!nativeOverridesSource.includes('roomClient.sendViewerReconnectReady({')) {
  errors.push('Native override upstream-offer timeout must send viewer-reconnect-ready through roomClient facade.');
}

if (!nativeOverridesSource.includes('      roomClient,') || !nativePeerMessagesSource.includes('roomClient.sendViewerReconnectReady(optionsForReconnect)')) {
  errors.push('Native peer controllers must receive roomClient and delegate viewer-reconnect-ready through its facade.');
}

if (nativeOverridesSource.includes("type: 'viewer-reconnect-ready'") || nativePeerMessagesSource.includes("type: 'viewer-reconnect-ready'")) {
  errors.push('Native override and peer message controller must not hand-build viewer-reconnect-ready payloads.');
}

const nativePeerMessagesInjectionBlock = nativeOverridesSource.match(/const nativePeerMessages = nativeEntry\.createRequired\('nativePeerMessages'[\s\S]*?\n    \}\);/);
if (nativePeerMessagesInjectionBlock && nativePeerMessagesInjectionBlock[0].includes('sendMessage: (message) => sendMessage(message)')) {
  errors.push('Native peer message controller should not receive a generic sendMessage injection for viewer-reconnect-ready.');
}

const nativePeerControllerInjectionBlock = nativeOverridesSource.match(/const nativePeerController = nativeEntry\.createRequired\('nativePeer'[\s\S]*?\n    \}\);/);
if (!nativePeerControllerInjectionBlock || !nativePeerControllerInjectionBlock[0].includes('      roomClient,')) {
  errors.push('Native peer controller must receive roomClient for signaling.');
}
if (nativePeerControllerInjectionBlock && nativePeerControllerInjectionBlock[0].includes('sendMessage: (message) => sendMessage(message)')) {
  errors.push('Native peer controller should not receive a generic sendMessage injection; use roomClient.');
}

function checkMigratedHandlers(handlers, controllerSource, controllerLabel) {
  for (const handler of handlers) {
    if (!controllerSource.includes(handler.declaration)) {
      errors.push(`${handler.type} handler is not defined in ${controllerLabel}.`);
    }
    if (!controllerSource.includes(handler.registration)) {
      errors.push(`${handler.type} is not registered through ${controllerLabel}.`);
    }
    if (nativeOverridesSource.includes(handler.declaration)) {
      errors.push(`${handler.type} handler still lives in native overrides.`);
    }
    if (nativeOverridesSource.includes(handler.registration)) {
      errors.push(`${handler.type} is still registered directly by native overrides.`);
    }
    if (nativeOverridesSource.includes(`case '${handler.type}':`)) {
      errors.push(`${handler.type} is still handled by the legacy native override switch.`);
    }
  }
}

checkMigratedHandlers(migratedRoomMessageHandlers, nativeRoomMessagesSource, 'native room message controller');
checkMigratedHandlers(migratedPeerMessageHandlers, nativePeerMessagesSource, 'native peer message controller');

for (const handler of nativeOverrideHandlers) {
  if (!nativeOverridesSource.includes(handler.declaration)) {
    errors.push(`${handler.type} handler is not defined in native overrides.`);
  }
  if (!nativeOverridesSource.includes(handler.registration)) {
    errors.push(`${handler.type} is not registered through room-client dispatcher.`);
  }
  if (nativeOverridesSource.includes(`case '${handler.type}':`)) {
    errors.push(`${handler.type} is still handled by the legacy native override switch.`);
  }
}

if (errors.length > 0) {
  console.error('Room client dispatcher check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Room client dispatcher check passed.');
