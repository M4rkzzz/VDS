#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SCENARIO_FILES = {
  'ios-safari-leaf': 'ios-safari-leaf.json',
  'android-chrome-relay': 'android-chrome-relay.json',
  'android-non-chrome-leaf': 'android-non-chrome-leaf.json'
};

const SCENARIOS = new Set([
  'ios-safari-leaf',
  'android-chrome-relay',
  'android-non-chrome-leaf'
]);

function usage() {
  return [
    'Usage:',
    '  node scripts/check-web-mobile-diagnostics.js <scenario> <diagnostics.json>',
    '  node scripts/check-web-mobile-diagnostics.js --self-test',
    '',
    'Scenarios:',
    '  ios-safari-leaf',
    '  android-chrome-relay',
    '  android-non-chrome-leaf'
  ].join('\n');
}

function readJson(filePath) {
  const absolutePath = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
}

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function asArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean) : [];
}

function includesAll(values, expected) {
  const normalized = new Set(asArray(values));
  return expected.every((item) => normalized.has(item));
}

function normalizeCodec(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized.startsWith('avc1') || normalized.startsWith('avc3')) {
    return 'h264';
  }
  if (normalized.startsWith('hvc1') || normalized.startsWith('hev1')) {
    return 'h265';
  }
  if (normalized === 'hevc') {
    return 'h265';
  }
  if (normalized === 'mp4a402') {
    return 'aac';
  }
  return normalized;
}

function normalizePayloadFormat(value) {
  return String(value || '').trim().toLowerCase();
}

function listIncludesNormalized(values, expected, normalizer) {
  const normalized = new Set(asArray(values).map(normalizer));
  return normalized.has(normalizer(expected));
}

function numberAtLeast(value, minimum) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum;
}

function numberEquals(value, expected) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric === expected;
}

function isValidIsoTimestamp(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function observedManifestList(report) {
  return Array.isArray(report && report.observedMediaManifests) ? report.observedMediaManifests : [];
}

function observedManifestsIncludeCodec(report, mediaType, expectedCodec) {
  const key = mediaType === 'video' ? 'videoCodec' : 'audioCodec';
  return observedManifestList(report).some((item) => item && normalizeCodec(item[key]) === normalizeCodec(expectedCodec) && numberAtLeast(item.count, 1));
}

function observedManifestsIncludeCodecWithCounter(report, mediaType, expectedCodec, counterName) {
  const key = mediaType === 'video' ? 'videoCodec' : 'audioCodec';
  return observedManifestList(report).some((item) => item && normalizeCodec(item[key]) === normalizeCodec(expectedCodec) && numberAtLeast(item[counterName], 1));
}

function probeResultsIncludeSupportedTarget(report, mediaType, expectedTarget) {
  const list = mediaType === 'video'
    ? report && report.environment && report.environment.videoCodecProbeResults
    : report && report.environment && report.environment.audioCodecProbeResults;
  return Array.isArray(list) && list.some((item) => item && normalizeCodec(item.target) === normalizeCodec(expectedTarget) && item.supported === true);
}

function validateTargetCodecProbeMatrix(report, failures) {
  assertCondition(probeResultsIncludeSupportedTarget(report, 'video', 'h264'), 'environment.videoCodecProbeResults must include supported h264 probe', failures);
  assertCondition(probeResultsIncludeSupportedTarget(report, 'video', 'h265'), 'environment.videoCodecProbeResults must include supported h265 probe', failures);
  assertCondition(probeResultsIncludeSupportedTarget(report, 'audio', 'opus'), 'environment.audioCodecProbeResults must include supported opus probe', failures);
  assertCondition(probeResultsIncludeSupportedTarget(report, 'audio', 'aac'), 'environment.audioCodecProbeResults must include supported aac probe', failures);
}

function validateObservedTargetMatrix(report, failures) {
  assertCondition(Array.isArray(report.observedMediaManifests), 'observedMediaManifests must be present', failures);
  assertCondition(observedManifestsIncludeCodec(report, 'video', 'h264'), 'observedMediaManifests must include observed video codec h264', failures);
  assertCondition(observedManifestsIncludeCodec(report, 'video', 'h265'), 'observedMediaManifests must include observed video codec h265', failures);
  assertCondition(observedManifestsIncludeCodec(report, 'audio', 'opus'), 'observedMediaManifests must include observed audio codec opus', failures);
  assertCondition(observedManifestsIncludeCodec(report, 'audio', 'aac'), 'observedMediaManifests must include observed audio codec aac', failures);
}

function validateObservedPlaybackMatrix(report, failures) {
  validateObservedTargetMatrix(report, failures);
  assertCondition(observedManifestsIncludeCodecWithCounter(report, 'video', 'h264', 'decodedVideoFrames'), 'observedMediaManifests must include decoded video frames for h264', failures);
  assertCondition(observedManifestsIncludeCodecWithCounter(report, 'video', 'h265', 'decodedVideoFrames'), 'observedMediaManifests must include decoded video frames for h265', failures);
  assertCondition(observedManifestsIncludeCodecWithCounter(report, 'audio', 'opus', 'decodedAudioBlocks'), 'observedMediaManifests must include decoded audio blocks for opus', failures);
  assertCondition(observedManifestsIncludeCodecWithCounter(report, 'audio', 'aac', 'decodedAudioBlocks'), 'observedMediaManifests must include decoded audio blocks for aac', failures);
}

function validateObservedCurrentManifestPlayback(report, failures) {
  const manifest = report && report.mediaManifest;
  const videoCodec = normalizeCodec(manifest && manifest.video && manifest.video.codec);
  const audioCodec = normalizeCodec((manifest && manifest.audio && manifest.audio.codec) || 'opus');
  assertCondition(observedManifestsIncludeCodecWithCounter(report, 'video', videoCodec, 'decodedVideoFrames'), `observedMediaManifests must include decoded video frames for manifest video codec ${videoCodec || 'unknown'}`, failures);
  assertCondition(observedManifestsIncludeCodecWithCounter(report, 'audio', audioCodec, 'decodedAudioBlocks'), `observedMediaManifests must include decoded audio blocks for manifest audio codec ${audioCodec || 'unknown'}`, failures);
}

function validateObservedRelayMatrix(report, failures) {
  validateObservedTargetMatrix(report, failures);
  assertCondition(observedManifestsIncludeCodecWithCounter(report, 'video', 'h264', 'forwardedVideoFrames'), 'observedMediaManifests must include forwarded video frames for h264', failures);
  assertCondition(observedManifestsIncludeCodecWithCounter(report, 'video', 'h265', 'forwardedVideoFrames'), 'observedMediaManifests must include forwarded video frames for h265', failures);
  assertCondition(observedManifestsIncludeCodecWithCounter(report, 'audio', 'opus', 'forwardedAudioFrames'), 'observedMediaManifests must include forwarded audio frames for opus', failures);
  assertCondition(observedManifestsIncludeCodecWithCounter(report, 'audio', 'aac', 'forwardedAudioFrames'), 'observedMediaManifests must include forwarded audio frames for aac', failures);
}

function validateObservedLeafNoForwarding(report, failures) {
  const invalidForwardedManifest = observedManifestList(report).find((item) => {
    return item && (!numberEquals(item.forwardedVideoFrames || 0, 0) || !numberEquals(item.forwardedAudioFrames || 0, 0));
  });
  assertCondition(!invalidForwardedManifest, 'observedMediaManifests forwarded counters must be 0 for leaf viewers', failures);
}

function validateCommon(report, failures) {
  assertCondition(report && typeof report === 'object', 'diagnostics root must be an object', failures);
  assertCondition(Number(report.diagnosticsSchemaVersion) === 2, 'diagnosticsSchemaVersion must be 2', failures);
  assertCondition(isValidIsoTimestamp(report.diagnosticsGeneratedAt), 'diagnosticsGeneratedAt must be a valid ISO timestamp', failures);
  assertCondition(typeof report.recommendedFixtureFilename === 'string' && report.recommendedFixtureFilename.trim() !== '', 'recommendedFixtureFilename must be present', failures);
  assertCondition(report.environment && typeof report.environment === 'object', 'environment must be present', failures);
  assertCondition(report.environment?.secureContext === true, 'environment.secureContext must be true', failures);
  assertCondition(typeof report.environment?.lanHttpAllowed === 'boolean', 'environment.lanHttpAllowed must be boolean', failures);
  assertCondition(report.environment?.webRtc === true, 'environment.webRtc must be true', failures);
  assertCondition(report.environment?.webCodecsVideoDecoder === true, 'environment.webCodecsVideoDecoder must be true', failures);
  assertCondition(report.environment?.webCodecsAudioDecoder === true, 'environment.webCodecsAudioDecoder must be true', failures);
  assertCondition(report.environment?.ok === true, 'environment.ok must be true', failures);
  assertCondition(Array.isArray(report.environment?.reasons) && report.environment.reasons.length === 0, 'environment.reasons must be empty', failures);
  assertCondition(typeof report.environment?.relayEligibilityReason === 'string', 'environment.relayEligibilityReason must be present', failures);
  assertCondition(Array.isArray(report.environment?.videoCodecProbeResults), 'environment.videoCodecProbeResults must be present', failures);
  assertCondition(Array.isArray(report.environment?.audioCodecProbeResults), 'environment.audioCodecProbeResults must be present', failures);
  assertCondition(report.serverMediaCapabilities && typeof report.serverMediaCapabilities === 'object', 'serverMediaCapabilities must be present', failures);
  assertCondition(report.serverMediaCapabilities?.webViewer === true, 'serverMediaCapabilities.webViewer must be true', failures);
  assertCondition(typeof report.serverMediaCapabilities?.relayEligibilityReason === 'string', 'serverMediaCapabilities.relayEligibilityReason must be present', failures);
  assertCondition(typeof report.serverMediaCapabilities?.localRelayEligibilityReason === 'string', 'serverMediaCapabilities.localRelayEligibilityReason must be present', failures);
  assertCondition(report.reencodePathUsed === false, 'reencodePathUsed must be false', failures);
  validateManifestCompatibility(report, failures);
}

function validateManifestCompatibility(report, failures) {
  const manifest = report && report.mediaManifest;
  const env = report && report.environment ? report.environment : {};
  const server = report && report.serverMediaCapabilities ? report.serverMediaCapabilities : {};
  assertCondition(manifest && typeof manifest === 'object', 'mediaManifest must be present', failures);
  if (!manifest || typeof manifest !== 'object') {
    return;
  }
  assertCondition(manifest.protocol === 'vds-media-encoded-v1', 'mediaManifest.protocol must be vds-media-encoded-v1', failures);
  const videoCodec = normalizeCodec(manifest.video && manifest.video.codec);
  const videoPayloadFormat = normalizePayloadFormat((manifest.video && manifest.video.payloadFormat) || 'annexb');
  const audioCodec = normalizeCodec((manifest.audio && manifest.audio.codec) || 'opus');
  const audioPayloadFormat = normalizePayloadFormat((manifest.audio && manifest.audio.payloadFormat) || (audioCodec === 'aac' ? 'aac-adts' : 'opus-raw'));
  assertCondition(listIncludesNormalized(env.supportedVideoCodecs, videoCodec, normalizeCodec), `environment.supportedVideoCodecs must include manifest video codec ${videoCodec || 'unknown'}`, failures);
  assertCondition(listIncludesNormalized(env.supportedAudioCodecs, audioCodec, normalizeCodec), `environment.supportedAudioCodecs must include manifest audio codec ${audioCodec || 'unknown'}`, failures);
  assertCondition(listIncludesNormalized(env.supportedVideoPayloadFormats, videoPayloadFormat, normalizePayloadFormat), `environment.supportedVideoPayloadFormats must include manifest video payload ${videoPayloadFormat || 'unknown'}`, failures);
  assertCondition(listIncludesNormalized(env.supportedAudioPayloadFormats, audioPayloadFormat, normalizePayloadFormat), `environment.supportedAudioPayloadFormats must include manifest audio payload ${audioPayloadFormat || 'unknown'}`, failures);
  validateServerEncodedMediaCompatibility(server, videoCodec, videoPayloadFormat, audioCodec, audioPayloadFormat, failures);
}

function validateServerEncodedMediaCompatibility(server, videoCodec, videoPayloadFormat, audioCodec, audioPayloadFormat, failures) {
  const encoded = server && server.encodedMediaDataChannel;
  assertCondition(encoded && typeof encoded === 'object', 'serverMediaCapabilities.encodedMediaDataChannel must be present', failures);
  if (!encoded || typeof encoded !== 'object') {
    return;
  }
  assertCondition(encoded.protocol === 'vds-media-encoded-v1', 'serverMediaCapabilities.encodedMediaDataChannel.protocol must be vds-media-encoded-v1', failures);
  assertCondition(Number(encoded.protocolVersion) === 1, 'serverMediaCapabilities.encodedMediaDataChannel.protocolVersion must be 1', failures);
  assertCondition(listIncludesNormalized(encoded.supportedVideoCodecs, videoCodec, normalizeCodec), `serverMediaCapabilities.encodedMediaDataChannel.supportedVideoCodecs must include manifest video codec ${videoCodec || 'unknown'}`, failures);
  assertCondition(listIncludesNormalized(encoded.supportedAudioCodecs, audioCodec, normalizeCodec), `serverMediaCapabilities.encodedMediaDataChannel.supportedAudioCodecs must include manifest audio codec ${audioCodec || 'unknown'}`, failures);
  assertCondition(listIncludesNormalized(encoded.supportedVideoPayloadFormats, videoPayloadFormat, normalizePayloadFormat), `serverMediaCapabilities.encodedMediaDataChannel.supportedVideoPayloadFormats must include manifest video payload ${videoPayloadFormat || 'unknown'}`, failures);
  assertCondition(listIncludesNormalized(encoded.supportedAudioPayloadFormats, audioPayloadFormat, normalizePayloadFormat), `serverMediaCapabilities.encodedMediaDataChannel.supportedAudioPayloadFormats must include manifest audio payload ${audioPayloadFormat || 'unknown'}`, failures);
}

function validateIosSafariLeaf(report, failures) {
  const env = report.environment || {};
  const server = report.serverMediaCapabilities || {};
  assertCondition(env.platform === 'ios', 'environment.platform must be ios', failures);
  assertCondition(env.browserFamily === 'safari', 'environment.browserFamily must be safari', failures);
  assertCondition(env.mobile === true, 'environment.mobile must be true', failures);
  assertCondition(env.iosSafari === true, 'environment.iosSafari must be true', failures);
  assertCondition(env.iosWebKit === true, 'environment.iosWebKit must be true', failures);
  assertCondition(env.audioOutput === true, 'environment.audioOutput must be true', failures);
  assertCondition(env.relayCapable === false, 'environment.relayCapable must be false', failures);
  assertCondition(Number(env.maxDirectDownstreams) === 0, 'environment.maxDirectDownstreams must be 0', failures);
  assertCondition(env.relayEligibilityReason === 'ios-leaf', 'environment.relayEligibilityReason must be ios-leaf', failures);
  assertCondition(server.relayCapable === false, 'serverMediaCapabilities.relayCapable must be false', failures);
  assertCondition(server.platform === 'ios', 'serverMediaCapabilities.platform must be ios', failures);
  assertCondition(server.browserFamily === 'safari', 'serverMediaCapabilities.browserFamily must be safari', failures);
  assertCondition(server.androidChrome === false, 'serverMediaCapabilities.androidChrome must be false', failures);
  assertCondition(Number(server.maxDirectDownstreams) === 0, 'serverMediaCapabilities.maxDirectDownstreams must be 0', failures);
  assertCondition(server.relayEligibilityReason === 'ios-leaf', 'serverMediaCapabilities.relayEligibilityReason must be ios-leaf', failures);
  assertCondition(server.localRelayEligibilityReason === 'ios-leaf', 'serverMediaCapabilities.localRelayEligibilityReason must be ios-leaf', failures);
  assertCondition(includesAll(env.supportedVideoCodecs, ['h264', 'h265']), 'environment.supportedVideoCodecs must include h264 and h265', failures);
  assertCondition(includesAll(env.supportedAudioCodecs, ['opus', 'aac']), 'environment.supportedAudioCodecs must include opus and aac', failures);
  assertCondition(includesAll(env.supportedVideoPayloadFormats, ['annexb', 'avcc']), 'environment.supportedVideoPayloadFormats must include annexb and avcc', failures);
  assertCondition(includesAll(env.supportedAudioPayloadFormats, ['opus-raw', 'raw', 'aac-adts']), 'environment.supportedAudioPayloadFormats must include opus-raw, raw, and aac-adts', failures);
  validateTargetCodecProbeMatrix(report, failures);
  assertCondition(numberAtLeast(report.webDecodedVideoFrames, 1), 'webDecodedVideoFrames must be >= 1', failures);
  assertCondition(numberAtLeast(report.webDecodedAudioBlocks, 1), 'webDecodedAudioBlocks must be >= 1', failures);
  assertCondition(numberEquals(report.encodedFramesForwarded, 0), 'encodedFramesForwarded must be 0 for leaf viewers', failures);
  assertCondition(numberEquals(report.encodedAudioFramesForwarded, 0), 'encodedAudioFramesForwarded must be 0 for leaf viewers', failures);
  validateObservedPlaybackMatrix(report, failures);
  validateObservedLeafNoForwarding(report, failures);
}

function validateAndroidChromeRelay(report, failures) {
  const env = report.environment || {};
  const server = report.serverMediaCapabilities || {};
  assertCondition(env.platform === 'android', 'environment.platform must be android', failures);
  assertCondition(env.browserFamily === 'chromium', 'environment.browserFamily must be chromium', failures);
  assertCondition(env.mobile === true, 'environment.mobile must be true', failures);
  assertCondition(env.androidChromium === true, 'environment.androidChromium must be true', failures);
  assertCondition(env.androidChrome === true, 'environment.androidChrome must be true', failures);
  assertCondition(env.audioOutput === true, 'environment.audioOutput must be true', failures);
  assertCondition(env.relayCapable === true, 'environment.relayCapable must be true', failures);
  assertCondition(Number(env.maxDirectDownstreams) === 1, 'environment.maxDirectDownstreams must be 1', failures);
  assertCondition(env.relayEligibilityReason === 'relay-ready', 'environment.relayEligibilityReason must be relay-ready', failures);
  assertCondition(server.relayCapable === true, 'serverMediaCapabilities.relayCapable must be true', failures);
  assertCondition(server.platform === 'android', 'serverMediaCapabilities.platform must be android', failures);
  assertCondition(server.browserFamily === 'chromium', 'serverMediaCapabilities.browserFamily must be chromium', failures);
  assertCondition(server.androidChrome === true, 'serverMediaCapabilities.androidChrome must be true', failures);
  assertCondition(Number(server.maxDirectDownstreams) === 1, 'serverMediaCapabilities.maxDirectDownstreams must be 1', failures);
  assertCondition(server.relayEligibilityReason === 'relay-ready', 'serverMediaCapabilities.relayEligibilityReason must be relay-ready', failures);
  assertCondition(server.localRelayEligibilityReason === 'relay-ready', 'serverMediaCapabilities.localRelayEligibilityReason must be relay-ready', failures);
  assertCondition(includesAll(env.supportedVideoCodecs, ['h264', 'h265']), 'environment.supportedVideoCodecs must include h264 and h265', failures);
  assertCondition(includesAll(env.supportedAudioCodecs, ['opus', 'aac']), 'environment.supportedAudioCodecs must include opus and aac', failures);
  assertCondition(includesAll(env.supportedVideoPayloadFormats, ['annexb', 'avcc']), 'environment.supportedVideoPayloadFormats must include annexb and avcc', failures);
  assertCondition(includesAll(env.supportedAudioPayloadFormats, ['opus-raw', 'raw', 'aac-adts']), 'environment.supportedAudioPayloadFormats must include opus-raw, raw, and aac-adts', failures);
  validateTargetCodecProbeMatrix(report, failures);
  assertCondition(numberAtLeast(report.webDecodedVideoFrames, 1), 'webDecodedVideoFrames must be >= 1', failures);
  assertCondition(numberAtLeast(report.webDecodedAudioBlocks, 1), 'webDecodedAudioBlocks must be >= 1', failures);
  assertCondition(numberAtLeast(report.encodedFramesForwarded, 1), 'encodedFramesForwarded must be >= 1', failures);
  assertCondition(numberAtLeast(report.encodedAudioFramesForwarded, 1), 'encodedAudioFramesForwarded must be >= 1', failures);
  validateObservedRelayMatrix(report, failures);
  validateObservedPlaybackMatrix(report, failures);
}

function validateAndroidNonChromeLeaf(report, failures) {
  const env = report.environment || {};
  const server = report.serverMediaCapabilities || {};
  assertCondition(env.platform === 'android', 'environment.platform must be android', failures);
  assertCondition(env.mobile === true, 'environment.mobile must be true', failures);
  assertCondition(env.androidChrome === false, 'environment.androidChrome must be false', failures);
  assertCondition(env.audioOutput === true, 'environment.audioOutput must be true', failures);
  assertCondition(env.relayCapable === false, 'environment.relayCapable must be false', failures);
  assertCondition(Number(env.maxDirectDownstreams) === 0, 'environment.maxDirectDownstreams must be 0', failures);
  assertCondition(env.relayEligibilityReason === 'android-non-chrome-leaf', 'environment.relayEligibilityReason must be android-non-chrome-leaf', failures);
  assertCondition(server.relayCapable === false, 'serverMediaCapabilities.relayCapable must be false', failures);
  assertCondition(server.platform === 'android', 'serverMediaCapabilities.platform must be android', failures);
  assertCondition(server.androidChrome === false, 'serverMediaCapabilities.androidChrome must be false', failures);
  assertCondition(Number(server.maxDirectDownstreams) === 0, 'serverMediaCapabilities.maxDirectDownstreams must be 0', failures);
  assertCondition(server.relayEligibilityReason === 'android-non-chrome-leaf', 'serverMediaCapabilities.relayEligibilityReason must be android-non-chrome-leaf', failures);
  assertCondition(server.localRelayEligibilityReason === 'android-non-chrome-leaf', 'serverMediaCapabilities.localRelayEligibilityReason must be android-non-chrome-leaf', failures);
  assertCondition(numberAtLeast(report.webDecodedVideoFrames, 1), 'webDecodedVideoFrames must be >= 1', failures);
  assertCondition(numberAtLeast(report.webDecodedAudioBlocks, 1), 'webDecodedAudioBlocks must be >= 1', failures);
  assertCondition(numberEquals(report.encodedFramesForwarded, 0), 'encodedFramesForwarded must be 0 for leaf viewers', failures);
  assertCondition(numberEquals(report.encodedAudioFramesForwarded, 0), 'encodedAudioFramesForwarded must be 0 for leaf viewers', failures);
  validateObservedCurrentManifestPlayback(report, failures);
  validateObservedLeafNoForwarding(report, failures);
}

function validateScenario(scenario, report) {
  const failures = [];
  validateCommon(report, failures);
  assertCondition(report && report.recommendedFixtureFilename === SCENARIO_FILES[scenario], `recommendedFixtureFilename must be ${SCENARIO_FILES[scenario] || 'known'}`, failures);
  if (scenario === 'ios-safari-leaf') {
    validateIosSafariLeaf(report, failures);
  } else if (scenario === 'android-chrome-relay') {
    validateAndroidChromeRelay(report, failures);
  } else if (scenario === 'android-non-chrome-leaf') {
    validateAndroidNonChromeLeaf(report, failures);
  } else {
    failures.push(`unknown scenario: ${scenario}`);
  }
  return failures;
}

function validateFile(scenario, filePath) {
  try {
    const report = readJson(filePath);
    return validateScenario(scenario, report);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return [`failed to read diagnostics JSON ${path.basename(filePath)}: ${message}`];
  }
}

function makeBaseReport(overrides) {
  function mergeReport(base, patch) {
    const patchServer = patch && patch.serverMediaCapabilities ? patch.serverMediaCapabilities : {};
    const patchManifest = patch && patch.mediaManifest ? patch.mediaManifest : {};
    return {
      ...base,
      ...(patch || {}),
      environment: { ...base.environment, ...((patch && patch.environment) || {}) },
      serverMediaCapabilities: {
        ...base.serverMediaCapabilities,
        ...patchServer,
        encodedMediaDataChannel: {
          ...base.serverMediaCapabilities.encodedMediaDataChannel,
          ...((patchServer && patchServer.encodedMediaDataChannel) || {})
        }
      },
      mediaManifest: {
        ...base.mediaManifest,
        ...patchManifest,
        video: { ...base.mediaManifest.video, ...((patchManifest && patchManifest.video) || {}) },
        audio: { ...base.mediaManifest.audio, ...((patchManifest && patchManifest.audio) || {}) }
      }
    };
  }

  const base = {
    diagnosticsSchemaVersion: 2,
    diagnosticsGeneratedAt: '2026-06-27T00:00:00.000Z',
    recommendedFixtureFilename: 'ios-safari-leaf.json',
    environment: {
      platform: 'ios',
      browserFamily: 'safari',
      mobile: true,
      secureContext: true,
      lanHttpAllowed: false,
      webRtc: true,
      webCodecsVideoDecoder: true,
      webCodecsAudioDecoder: true,
      ok: true,
      reasons: [],
      iosSafari: true,
      iosWebKit: true,
      androidChromium: false,
      androidChrome: false,
      audioOutput: true,
      relayCapable: false,
      maxDirectDownstreams: 0,
      relayEligibilityReason: 'ios-leaf',
      supportedVideoCodecs: ['h264', 'h265'],
      supportedAudioCodecs: ['opus', 'aac'],
      videoCodecProbeResults: [
        { codec: 'avc1.42E01F', target: 'h264', supported: true, source: 'webcodecs' },
        { codec: 'hvc1.1.6.L120.B0', target: 'h265', supported: true, source: 'webcodecs' }
      ],
      audioCodecProbeResults: [
        { codec: 'opus', target: 'opus', supported: true, source: 'webcodecs' },
        { codec: 'mp4a.40.2', target: 'aac', supported: true, source: 'webcodecs' }
      ],
      supportedVideoPayloadFormats: ['annexb', 'avcc'],
      supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts']
    },
    serverMediaCapabilities: {
      webViewer: true,
      relayCapable: false,
      platform: 'ios',
      browserFamily: 'safari',
      androidChrome: false,
      maxDirectDownstreams: 0,
      relayEligibilityReason: 'ios-leaf',
      localRelayEligibilityReason: 'ios-leaf',
      encodedMediaDataChannel: {
        protocol: 'vds-media-encoded-v1',
        protocolVersion: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts']
      }
    },
    mediaManifest: {
      protocol: 'vds-media-encoded-v1',
      video: { codec: 'h264', payloadFormat: 'annexb' },
      audio: { codec: 'opus', payloadFormat: 'opus-raw' }
    },
    observedMediaManifests: [
      { protocol: 'vds-media-encoded-v1', videoCodec: 'h264', videoPayloadFormat: 'annexb', audioCodec: 'opus', audioPayloadFormat: 'opus-raw', count: 1, decodedVideoFrames: 5, decodedAudioBlocks: 5, forwardedVideoFrames: 0, forwardedAudioFrames: 0 },
      { protocol: 'vds-media-encoded-v1', videoCodec: 'h265', videoPayloadFormat: 'annexb', audioCodec: 'aac', audioPayloadFormat: 'aac-adts', count: 1, decodedVideoFrames: 5, decodedAudioBlocks: 5, forwardedVideoFrames: 0, forwardedAudioFrames: 0 }
    ],
    webDecodedVideoFrames: 10,
    webDecodedAudioBlocks: 10,
    encodedFramesForwarded: 0,
    encodedAudioFramesForwarded: 0,
    reencodePathUsed: false
  };
  return mergeReport(base, overrides);
}

function runSelfTest() {
  const cases = [
    ['ios-safari-leaf', makeBaseReport({})],
    ['android-chrome-relay', makeBaseReport({
      recommendedFixtureFilename: 'android-chrome-relay.json',
      environment: {
        platform: 'android',
        browserFamily: 'chromium',
        iosSafari: false,
        androidChromium: true,
        androidChrome: true,
        audioOutput: true,
        relayCapable: true,
        maxDirectDownstreams: 1,
        relayEligibilityReason: 'relay-ready',
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts']
      },
      serverMediaCapabilities: {
        relayCapable: true,
        platform: 'android',
        browserFamily: 'chromium',
        androidChrome: true,
        maxDirectDownstreams: 1,
        relayEligibilityReason: 'relay-ready',
        localRelayEligibilityReason: 'relay-ready',
        encodedMediaDataChannel: {
          supportedVideoCodecs: ['avc1.640028', 'hvc1.1.6.L120.B0'],
          supportedAudioCodecs: ['opus', 'mp4a.40.2']
        }
      },
      observedMediaManifests: [
        { protocol: 'vds-media-encoded-v1', videoCodec: 'h264', videoPayloadFormat: 'annexb', audioCodec: 'opus', audioPayloadFormat: 'opus-raw', count: 1, decodedVideoFrames: 5, decodedAudioBlocks: 5, forwardedVideoFrames: 5, forwardedAudioFrames: 5 },
        { protocol: 'vds-media-encoded-v1', videoCodec: 'h265', videoPayloadFormat: 'annexb', audioCodec: 'aac', audioPayloadFormat: 'aac-adts', count: 1, decodedVideoFrames: 5, decodedAudioBlocks: 5, forwardedVideoFrames: 5, forwardedAudioFrames: 5 }
      ],
      encodedFramesForwarded: 5,
      encodedAudioFramesForwarded: 5
    })],
    ['android-non-chrome-leaf', makeBaseReport({
      recommendedFixtureFilename: 'android-non-chrome-leaf.json',
      environment: {
        platform: 'android',
        browserFamily: 'chromium',
        iosSafari: false,
        androidChrome: false,
        audioOutput: true,
        relayCapable: false,
        maxDirectDownstreams: 0,
        relayEligibilityReason: 'android-non-chrome-leaf',
        supportedVideoCodecs: ['h264'],
        supportedAudioCodecs: ['opus'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw']
      },
      serverMediaCapabilities: {
        relayCapable: false,
        platform: 'android',
        androidChrome: false,
        maxDirectDownstreams: 0,
        relayEligibilityReason: 'android-non-chrome-leaf',
        localRelayEligibilityReason: 'android-non-chrome-leaf'
      }
    })]
  ];
  for (const [scenario, report] of cases) {
    const failures = validateScenario(scenario, report);
    if (failures.length > 0) {
      throw new Error(`self-test failed for ${scenario}: ${failures.join('; ')}`);
    }
  }

  const negativeCases = [
    ['ios-safari-leaf', makeBaseReport({ diagnosticsSchemaVersion: 1 }), 'diagnosticsSchemaVersion must be 2'],
    ['ios-safari-leaf', makeBaseReport({ recommendedFixtureFilename: undefined }), 'recommendedFixtureFilename must be present'],
    ['ios-safari-leaf', makeBaseReport({ environment: { videoCodecProbeResults: undefined } }), 'environment.videoCodecProbeResults must be present'],
    ['ios-safari-leaf', makeBaseReport({ environment: { relayEligibilityReason: undefined } }), 'environment.relayEligibilityReason must be present'],
    ['ios-safari-leaf', makeBaseReport({ serverMediaCapabilities: { localRelayEligibilityReason: undefined } }), 'serverMediaCapabilities.localRelayEligibilityReason must be present'],
    ['ios-safari-leaf', makeBaseReport({
      environment: {
        videoCodecProbeResults: [
          { codec: 'avc1.42E01F', target: 'h264', supported: true, source: 'webcodecs' },
          { codec: 'hvc1.1.6.L120.B0', target: 'h265', supported: false, source: 'webcodecs' }
        ]
      }
    }), 'environment.videoCodecProbeResults must include supported h265 probe'],
    ['ios-safari-leaf', makeBaseReport({ recommendedFixtureFilename: 'android-chrome-relay.json' }), 'recommendedFixtureFilename must be ios-safari-leaf.json'],
    ['ios-safari-leaf', makeBaseReport({ encodedFramesForwarded: 1 }), 'encodedFramesForwarded must be 0 for leaf viewers'],
    ['ios-safari-leaf', makeBaseReport({
      observedMediaManifests: [
        { protocol: 'vds-media-encoded-v1', videoCodec: 'h264', videoPayloadFormat: 'annexb', audioCodec: 'opus', audioPayloadFormat: 'opus-raw', count: 1, decodedVideoFrames: 5, decodedAudioBlocks: 5, forwardedVideoFrames: 1, forwardedAudioFrames: 0 },
        { protocol: 'vds-media-encoded-v1', videoCodec: 'h265', videoPayloadFormat: 'annexb', audioCodec: 'aac', audioPayloadFormat: 'aac-adts', count: 1, decodedVideoFrames: 5, decodedAudioBlocks: 5, forwardedVideoFrames: 0, forwardedAudioFrames: 0 }
      ]
    }), 'observedMediaManifests forwarded counters must be 0 for leaf viewers'],
    ['android-chrome-relay', makeBaseReport({ environment: { platform: 'android', browserFamily: 'safari' } }), 'environment.browserFamily must be chromium'],
    ['android-chrome-relay', makeBaseReport({
      environment: { platform: 'android', browserFamily: 'chromium', androidChromium: true, androidChrome: true, relayCapable: true, maxDirectDownstreams: 1 },
      serverMediaCapabilities: { relayCapable: true, platform: 'android', browserFamily: 'safari', androidChrome: true, maxDirectDownstreams: 1, relayEligibilityReason: 'relay-ready' },
      encodedFramesForwarded: 5,
      encodedAudioFramesForwarded: 5
    }), 'serverMediaCapabilities.browserFamily must be chromium'],
    ['ios-safari-leaf', makeBaseReport({ diagnosticsGeneratedAt: 'not-a-date' }), 'diagnosticsGeneratedAt must be a valid ISO timestamp'],
    ['ios-safari-leaf', makeBaseReport({ serverMediaCapabilities: { webViewer: false } }), 'serverMediaCapabilities.webViewer must be true'],
    ['ios-safari-leaf', makeBaseReport({ reencodePathUsed: true }), 'reencodePathUsed must be false'],
    ['ios-safari-leaf', makeBaseReport({ environment: { iosWebKit: false } }), 'environment.iosWebKit must be true'],
    ['ios-safari-leaf', makeBaseReport({ serverMediaCapabilities: { browserFamily: 'chromium' } }), 'serverMediaCapabilities.browserFamily must be safari'],
    ['ios-safari-leaf', makeBaseReport({ environment: { secureContext: false } }), 'environment.secureContext must be true'],
    ['ios-safari-leaf', makeBaseReport({ environment: { lanHttpAllowed: undefined } }), 'environment.lanHttpAllowed must be boolean'],
    ['ios-safari-leaf', makeBaseReport({ environment: { webCodecsAudioDecoder: false } }), 'environment.webCodecsAudioDecoder must be true'],
    ['ios-safari-leaf', makeBaseReport({ environment: { ok: false, reasons: ['nope'] } }), 'environment.ok must be true'],
    ['ios-safari-leaf', makeBaseReport({ environment: { reasons: ['stale reason'] } }), 'environment.reasons must be empty'],
    ['ios-safari-leaf', makeBaseReport({ webDecodedAudioBlocks: 0 }), 'webDecodedAudioBlocks must be >= 1'],
    ['ios-safari-leaf', makeBaseReport({ environment: { mobile: false } }), 'environment.mobile must be true'],
    ['ios-safari-leaf', makeBaseReport({
      observedMediaManifests: [
        { protocol: 'vds-media-encoded-v1', videoCodec: 'h264', videoPayloadFormat: 'annexb', audioCodec: 'opus', audioPayloadFormat: 'opus-raw', count: 1 }
      ]
    }), 'observedMediaManifests must include observed video codec h265'],
    ['ios-safari-leaf', makeBaseReport({
      observedMediaManifests: [
        { protocol: 'vds-media-encoded-v1', videoCodec: 'h264', videoPayloadFormat: 'annexb', audioCodec: 'opus', audioPayloadFormat: 'opus-raw', count: 1, decodedVideoFrames: 5, decodedAudioBlocks: 5, forwardedVideoFrames: 0, forwardedAudioFrames: 0 },
        { protocol: 'vds-media-encoded-v1', videoCodec: 'h265', videoPayloadFormat: 'annexb', audioCodec: 'aac', audioPayloadFormat: 'aac-adts', count: 1, decodedVideoFrames: 0, decodedAudioBlocks: 5, forwardedVideoFrames: 0, forwardedAudioFrames: 0 }
      ]
    }), 'observedMediaManifests must include decoded video frames for h265'],
    ['ios-safari-leaf', makeBaseReport({
      environment: {
        platform: 'ios',
        browserFamily: 'safari',
        iosSafari: true,
        androidChrome: false,
        audioOutput: false,
        relayCapable: false,
        maxDirectDownstreams: 0,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts']
      }
    }), 'environment.audioOutput must be true'],
    ['ios-safari-leaf', makeBaseReport({
      environment: {
        platform: 'ios',
        browserFamily: 'safari',
        iosSafari: true,
        androidChrome: false,
        audioOutput: true,
        relayCapable: false,
        maxDirectDownstreams: 0,
        supportedVideoCodecs: ['h264'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts']
      }
    }), 'environment.supportedVideoCodecs must include h264 and h265'],
    ['android-chrome-relay', makeBaseReport({
      environment: {
        platform: 'android',
        browserFamily: 'chromium',
        iosSafari: false,
        androidChrome: true,
        audioOutput: true,
        relayCapable: true,
        maxDirectDownstreams: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts']
      },
      serverMediaCapabilities: {
        relayCapable: true,
        platform: 'android',
        androidChrome: true,
        maxDirectDownstreams: 1,
        relayEligibilityReason: 'relay-ready'
      },
      encodedFramesForwarded: 0,
      encodedAudioFramesForwarded: 5
    }), 'encodedFramesForwarded must be >= 1'],
    ['android-chrome-relay', makeBaseReport({
      recommendedFixtureFilename: 'android-chrome-relay.json',
      environment: {
        platform: 'android',
        browserFamily: 'chromium',
        iosSafari: false,
        androidChromium: true,
        androidChrome: true,
        audioOutput: true,
        relayCapable: true,
        maxDirectDownstreams: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts']
      },
      serverMediaCapabilities: {
        relayCapable: true,
        platform: 'android',
        browserFamily: 'chromium',
        androidChrome: true,
        maxDirectDownstreams: 1,
        relayEligibilityReason: 'relay-ready'
      },
      encodedFramesForwarded: 5,
      encodedAudioFramesForwarded: 5,
      webDecodedAudioBlocks: 0
    }), 'webDecodedAudioBlocks must be >= 1'],
    ['android-chrome-relay', makeBaseReport({
      environment: {
        platform: 'android',
        browserFamily: 'chromium',
        iosSafari: false,
        androidChrome: true,
        audioOutput: true,
        relayCapable: true,
        maxDirectDownstreams: 2,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts']
      },
      serverMediaCapabilities: {
        relayCapable: true,
        platform: 'android',
        androidChrome: true,
        maxDirectDownstreams: 1,
        relayEligibilityReason: 'relay-ready'
      },
      encodedFramesForwarded: 5,
      encodedAudioFramesForwarded: 5
    }), 'environment.maxDirectDownstreams must be 1'],
    ['android-chrome-relay', makeBaseReport({
      environment: {
        platform: 'android',
        browserFamily: 'chromium',
        iosSafari: false,
        androidChrome: true,
        audioOutput: true,
        relayCapable: true,
        maxDirectDownstreams: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts']
      },
      serverMediaCapabilities: {
        relayCapable: true,
        platform: 'android',
        androidChrome: true,
        maxDirectDownstreams: 2,
        relayEligibilityReason: 'relay-ready'
      },
      encodedFramesForwarded: 5,
      encodedAudioFramesForwarded: 5
    }), 'serverMediaCapabilities.maxDirectDownstreams must be 1'],
    ['android-chrome-relay', makeBaseReport({
      environment: {
        platform: 'android',
        browserFamily: 'chromium',
        iosSafari: false,
        androidChrome: true,
        audioOutput: true,
        relayCapable: true,
        maxDirectDownstreams: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts']
      },
      serverMediaCapabilities: {
        relayCapable: true,
        platform: 'android',
        androidChrome: false,
        maxDirectDownstreams: 1,
        relayEligibilityReason: 'relay-ready'
      },
      encodedFramesForwarded: 5,
      encodedAudioFramesForwarded: 5
    }), 'serverMediaCapabilities.androidChrome must be true'],
    ['android-chrome-relay', makeBaseReport({
      environment: {
        platform: 'android',
        browserFamily: 'chromium',
        iosSafari: false,
        androidChrome: true,
        audioOutput: true,
        relayCapable: true,
        maxDirectDownstreams: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts']
      },
      serverMediaCapabilities: {
        relayCapable: true,
        platform: 'android',
        androidChrome: true,
        maxDirectDownstreams: 1,
        relayEligibilityReason: 'relay-ready',
        encodedMediaDataChannel: { protocolVersion: 2 }
      },
      encodedFramesForwarded: 5,
      encodedAudioFramesForwarded: 5
    }), 'serverMediaCapabilities.encodedMediaDataChannel.protocolVersion must be 1'],
    ['android-chrome-relay', makeBaseReport({
      environment: {
        platform: 'android',
        browserFamily: 'chromium',
        iosSafari: false,
        androidChromium: true,
        androidChrome: true,
        audioOutput: true,
        relayCapable: true,
        maxDirectDownstreams: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts']
      },
      serverMediaCapabilities: {
        relayCapable: true,
        platform: 'android',
        androidChrome: true,
        maxDirectDownstreams: 1,
        relayEligibilityReason: 'relay-ready'
      },
      observedMediaManifests: [
        { protocol: 'vds-media-encoded-v1', videoCodec: 'h264', videoPayloadFormat: 'annexb', audioCodec: 'opus', audioPayloadFormat: 'opus-raw', count: 1, decodedVideoFrames: 5, decodedAudioBlocks: 5, forwardedVideoFrames: 5, forwardedAudioFrames: 5 },
        { protocol: 'vds-media-encoded-v1', videoCodec: 'h265', videoPayloadFormat: 'annexb', audioCodec: 'aac', audioPayloadFormat: 'aac-adts', count: 1, decodedVideoFrames: 5, decodedAudioBlocks: 5, forwardedVideoFrames: 0, forwardedAudioFrames: 5 }
      ],
      encodedFramesForwarded: 5,
      encodedAudioFramesForwarded: 5
    }), 'observedMediaManifests must include forwarded video frames for h265'],
    ['android-chrome-relay', makeBaseReport({
      environment: {
        platform: 'android',
        browserFamily: 'chromium',
        iosSafari: false,
        androidChrome: true,
        audioOutput: true,
        relayCapable: true,
        maxDirectDownstreams: 1,
        supportedVideoCodecs: ['h264'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts']
      },
      serverMediaCapabilities: {
        relayCapable: true,
        platform: 'android',
        androidChrome: true,
        maxDirectDownstreams: 1,
        relayEligibilityReason: 'relay-ready'
      },
      mediaManifest: {
        protocol: 'vds-media-encoded-v1',
        video: { codec: 'h265', payloadFormat: 'annexb' },
        audio: { codec: 'aac', payloadFormat: 'aac-adts' }
      },
      encodedFramesForwarded: 5,
      encodedAudioFramesForwarded: 5
    }), 'environment.supportedVideoCodecs must include manifest video codec h265']
    ,['android-chrome-relay', makeBaseReport({
      environment: {
        platform: 'android',
        browserFamily: 'chromium',
        iosSafari: false,
        androidChrome: true,
        audioOutput: true,
        relayCapable: true,
        maxDirectDownstreams: 1,
        supportedVideoCodecs: ['h264', 'h265'],
        supportedAudioCodecs: ['opus', 'aac'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw', 'aac-adts']
      },
      serverMediaCapabilities: {
        relayCapable: true,
        platform: 'android',
        androidChrome: true,
        maxDirectDownstreams: 1,
        relayEligibilityReason: 'relay-ready',
        encodedMediaDataChannel: {
          supportedVideoCodecs: ['h264'],
          supportedAudioPayloadFormats: ['opus-raw', 'raw']
        }
      },
      mediaManifest: {
        protocol: 'vds-media-encoded-v1',
        video: { codec: 'h265', payloadFormat: 'annexb' },
        audio: { codec: 'aac', payloadFormat: 'aac-adts' }
      },
      encodedFramesForwarded: 5,
      encodedAudioFramesForwarded: 5
    }), 'serverMediaCapabilities.encodedMediaDataChannel.supportedVideoCodecs must include manifest video codec h265'],
    ['android-non-chrome-leaf', makeBaseReport({
      environment: {
        platform: 'android',
        browserFamily: 'chromium',
        iosSafari: false,
        androidChrome: false,
        audioOutput: true,
        relayCapable: false,
        maxDirectDownstreams: 0,
        supportedVideoCodecs: ['h264'],
        supportedAudioCodecs: ['opus'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw']
      },
      serverMediaCapabilities: {
        relayCapable: false,
        platform: 'android',
        androidChrome: false,
        maxDirectDownstreams: 0,
        relayEligibilityReason: 'android-non-chrome-leaf'
      },
      encodedAudioFramesForwarded: 1
    }), 'encodedAudioFramesForwarded must be 0 for leaf viewers']
    ,['android-non-chrome-leaf', makeBaseReport({
      recommendedFixtureFilename: 'android-non-chrome-leaf.json',
      environment: {
        platform: 'android',
        browserFamily: 'firefox',
        iosSafari: false,
        androidChrome: false,
        audioOutput: true,
        relayCapable: false,
        maxDirectDownstreams: 0,
        supportedVideoCodecs: ['h264'],
        supportedAudioCodecs: ['opus'],
        supportedVideoPayloadFormats: ['annexb', 'avcc'],
        supportedAudioPayloadFormats: ['opus-raw', 'raw']
      },
      serverMediaCapabilities: {
        relayCapable: false,
        platform: 'android',
        androidChrome: false,
        maxDirectDownstreams: 0,
        relayEligibilityReason: 'android-non-chrome-leaf',
        localRelayEligibilityReason: 'android-non-chrome-leaf'
      },
      mediaManifest: {
        protocol: 'vds-media-encoded-v1',
        video: { codec: 'h264', payloadFormat: 'annexb' },
        audio: { codec: 'opus', payloadFormat: 'opus-raw' }
      },
      observedMediaManifests: [
        { protocol: 'vds-media-encoded-v1', videoCodec: 'h264', videoPayloadFormat: 'annexb', audioCodec: 'opus', audioPayloadFormat: 'opus-raw', count: 1, decodedVideoFrames: 0, decodedAudioBlocks: 5, forwardedVideoFrames: 0, forwardedAudioFrames: 0 }
      ]
    }), 'observedMediaManifests must include decoded video frames for manifest video codec h264']
  ];
  for (const [scenario, report, expectedFailure] of negativeCases) {
    const failures = validateScenario(scenario, report);
    if (!failures.some((failure) => failure.includes(expectedFailure))) {
      throw new Error(`negative self-test did not catch ${expectedFailure}: ${failures.join('; ')}`);
    }
  }
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return 0;
  }
  if (argv.includes('--self-test')) {
    runSelfTest();
    console.log('web mobile diagnostics self-test passed');
    return 0;
  }
  const [scenario, filePath] = argv;
  if (!SCENARIOS.has(scenario) || !filePath) {
    console.error(usage());
    return 2;
  }

  const failures = validateFile(scenario, filePath);
  if (failures.length > 0) {
    console.error(`web mobile diagnostics check failed for ${scenario}:`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    return 1;
  }
  console.log(`web mobile diagnostics check passed for ${scenario}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { validateScenario };
