# Web Mobile Device QA

This checklist verifies the mobile Web viewer target:

- iOS Safari can watch H.264/H.265 + Opus/AAC as a leaf viewer.
- Android Chrome can watch and relay H.264/H.265 + Opus/AAC to one downstream viewer.
- Other Android browsers can watch as leaf viewers only when WebRTC, WebCodecs, Web Audio, and codec probing pass.
- iOS Safari is not selected as a relay upstream.
- Web relay requires explicit `relayCapable: true`; missing or false must not be treated as relay-capable.

## Preconditions

- Serve the app over localhost, LAN HTTP such as `http://192.168.x.x:3000`, or HTTPS. LAN HTTP is allowed for local phone QA; if a specific browser hides WebRTC/WebCodecs on LAN HTTP, diagnostics must show the concrete missing API. HTTPS can be enabled with `VDS_HTTPS_KEY_PATH` and `VDS_HTTPS_CERT_PATH` when needed.
- Use a host build that advertises `vds-media-encoded-v1` media manifests.
- Keep the Web diagnostics panel available and copy diagnostics after each scenario.
- Keep the 3010 admin dashboard open when testing topology decisions.
- Test at least one H.264 session and one H.265 session when the host hardware encoder supports both.
- Test at least one Opus session and one AAC/OBS ingest session when available.

## Required Diagnostics Fields

For every mobile run, copied diagnostics must show:

```text
diagnosticsSchemaVersion: 2
diagnosticsGeneratedAt: current ISO timestamp for the copied report
environment.platform: ios | android
environment.browserFamily: safari | chromium | firefox | other
environment.mobile: true
environment.secureContext: true
environment.lanHttpAllowed: true when testing through `http://192.168.x.x`, otherwise false
environment.webRtc: true
environment.webCodecsVideoDecoder: true
environment.webCodecsAudioDecoder: true
environment.ok: true
environment.reasons: []
environment.videoCodecProbeResults / audioCodecProbeResults: per-codec-string probe details for WebCodecs or MediaCapabilities
environment.iosSafari: true on iOS Safari
environment.iosWebKit: true on iOS Safari/iPadOS Safari
environment.androidChromium: true on Android Chromium-family browsers
environment.androidChrome: true on Android Chrome relay tests
environment.audioOutput: true when Web Audio output is available
environment.supportedVideoCodecs includes h264 and/or h265 after async probing
environment.supportedAudioCodecs includes opus and/or aac after async probing
environment.supportedVideoPayloadFormats includes annexb/avcc when video codecs are supported
environment.supportedAudioPayloadFormats includes opus-raw/raw for Opus and aac-adts/raw for AAC
environment.relayCapable: false on iOS Safari, true on Android Chrome only when WebRTC/WebCodecs/Web Audio and the full H.264/H.265 + Opus/AAC codec and payload-format target matrix are available
environment.maxDirectDownstreams: 0 on iOS Safari, 1 on Android Chrome when relay-capable
environment.relayEligibilityReason: local relay decision reason, aligned with server reason names where possible
serverMediaCapabilities.relayCapable: server-sanitized final relay decision
serverMediaCapabilities.webViewer: true
serverMediaCapabilities.platform / androidChrome: server-sanitized UA-derived platform and Android Chrome decision
serverMediaCapabilities.browserFamily: safari for iOS Safari leaf evidence
serverMediaCapabilities.maxDirectDownstreams: server-sanitized final downstream capacity, 0 for leaf mobile Web and 1 for Android Chrome relay
serverMediaCapabilities.relayEligibilityReason: relay-ready | ios-leaf | android-non-chrome-leaf | missing-android-relay-codec-matrix | invalid-encoded-protocol | missing-audio-output | missing-* reason
serverMediaCapabilities.localRelayEligibilityReason: local Web-side reason echoed by the server for 3010/admin comparison
serverMediaCapabilities.encodedMediaDataChannel.protocol: vds-media-encoded-v1
serverMediaCapabilities.encodedMediaDataChannel.protocolVersion: 1
serverMediaCapabilities.encodedMediaDataChannel.supportedVideoCodecs includes the current manifest video codec
serverMediaCapabilities.encodedMediaDataChannel.supportedAudioCodecs includes the current manifest audio codec
serverMediaCapabilities.encodedMediaDataChannel.supportedVideoPayloadFormats includes the current manifest video payload format
serverMediaCapabilities.encodedMediaDataChannel.supportedAudioPayloadFormats includes the current manifest audio payload format
observedMediaManifests includes observed H.264, H.265, Opus, and AAC manifest entries for iOS Safari and Android Chrome relay target verification
observedMediaManifests decodedVideoFrames/decodedAudioBlocks prove iOS Safari actually decoded each target codec family
observedMediaManifests forwardedVideoFrames/forwardedAudioFrames prove Android Chrome actually relayed each target codec family
observedMediaSummary provides a short human-readable per-manifest decoded/forwarded counter summary
```

The top capability summary should match diagnostics: `platform/browser` when a concrete browser name is available, otherwise `platform/browserFamily`; it should also show `relay xN` or `leaf only`, video codecs, audio codecs, and `audio out` or `no audio out`.

The 3010 admin dashboard should also show Web node payload format pills: `vf annexb/avcc` for video and `af ...` for supported audio formats.
It should also show the same relay eligibility reason as copied Web diagnostics, such as `relay-ready`, `ios-leaf`, `android-non-chrome-leaf`, `missing-android-relay-codec-matrix`, `invalid-encoded-protocol`, or `missing-audio-output`.
When `localRelayEligibilityReason` differs from `relayEligibilityReason`, treat it as a useful clue: the browser made one local decision, while the server downgraded or accepted the node after UA and capability sanitization.

On mobile layouts, the diagnostics panel must be visible so copied reports can be collected without desktop devtools.

## Diagnostic Checker

After copying diagnostics from a mobile browser, save the JSON to a file and run one of these checks:
On mobile, the diagnostics panel also has a `保存` button whose tooltip/accessibility label shows the expected fixture filename for the detected browser.
The exported JSON includes `recommendedFixtureFilename`, and the checker fails if that field does not match the selected scenario.
The checker requires `diagnosticsSchemaVersion: 2`; if this fails, reload the Web page from the current build before collecting evidence.
It also requires a valid `diagnosticsGeneratedAt` timestamp so stale phone exports are easier to spot.

```powershell
node scripts/check-web-mobile-diagnostics.js ios-safari-leaf path\to\ios-safari.json
node scripts/check-web-mobile-diagnostics.js android-chrome-relay path\to\android-chrome-relay.json
node scripts/check-web-mobile-diagnostics.js android-non-chrome-leaf path\to\android-leaf.json
```

Do not commit raw phone diagnostics unless they have been explicitly sanitized; they can include user agent, room, session, and network details.

The checker validates the copied `environment` fields, server-sanitized `serverMediaCapabilities`, current `mediaManifest` codec/payload compatibility, decoded/forwarded counters, and `reencodePathUsed` for the selected scenario.
It also requires `environment.videoCodecProbeResults` and `environment.audioCodecProbeResults`, so failed mobile codec probes include the exact codec strings and probe source.
For iOS Safari and Android Chrome relay target scenarios, those probe details must include `supported:true` entries for H.264, H.265, Opus, and AAC.
It also validates `serverMediaCapabilities.encodedMediaDataChannel` against the current manifest, so a server-cleaned codec/payload/protocol mismatch fails even if the local browser environment looks capable.
For `ios-safari-leaf` and `android-chrome-relay`, it also validates `observedMediaManifests` so a report that only observed H.264/Opus does not count as proof for the H.264/H.265 + Opus/AAC target matrix.
For iOS Safari, those observed entries must include decoded video/audio counters; for Android Chrome relay, they must include both decoded counters for local playback and forwarded counters for downstream relay.
Use `observedMediaSummary` as the quick phone-side readout, then rely on `observedMediaManifests` for the machine check.
For `ios-safari-leaf` and `android-chrome-relay`, the checker requires the full target matrix: H.264, H.265, Opus, AAC, and the declared payload formats needed by those codecs.
All mobile scenarios require `audioOutput: true`, so codec support without Web Audio output does not count as Opus/AAC playback support.
Leaf scenarios require both video and audio decode counters to prove H.264/H.265 plus Opus/AAC playback, not just video display.
Leaf scenarios also require `encodedFramesForwarded`, `encodedAudioFramesForwarded`, and every `observedMediaManifests` forwarded counter to stay `0`, proving the node watched only and was not used as an upstream relay.
Use `npm run check:web-mobile-diagnostics` to run the checker self-test.
Use `npm run check:web-mobile-code` to verify code-level mobile Web gates before starting manual phone QA; it intentionally does not require real-device fixture JSON.

## Case 1: iOS Safari Leaf Viewer

1. Open the Web viewer in iOS Safari.
2. Confirm capability detection passes.
3. Join a native-host room.
4. Verify video starts and audio plays after a tap gesture if needed.
5. Copy diagnostics and confirm:
   - `platform` is `ios`
   - `browserFamily` is `safari`
   - `iosSafari` is `true`
   - `iosWebKit` is `true`
   - `secureContext`, `webRtc`, `webCodecsVideoDecoder`, and `webCodecsAudioDecoder` are all `true`
   - `ok` is `true` and `reasons` is empty
   - `audioOutput` is `true`
   - `relayCapable` is `false`
   - `maxDirectDownstreams` is `0`
   - `supportedVideoCodecs` includes both `h264` and `h265`
   - `supportedAudioCodecs` includes both `opus` and `aac`
   - `supportedVideoPayloadFormats` includes `annexb` and `avcc`
   - `supportedAudioPayloadFormats` includes `opus-raw`, `raw`, and `aac-adts`
   - `serverMediaCapabilities.relayCapable` is `false`
   - `serverMediaCapabilities.platform` is `ios`
   - `serverMediaCapabilities.browserFamily` is `safari`
   - `serverMediaCapabilities.androidChrome` is `false`
   - `serverMediaCapabilities.maxDirectDownstreams` is `0`
   - `serverMediaCapabilities.relayEligibilityReason` is `ios-leaf`
   - `serverMediaCapabilities.localRelayEligibilityReason` is `ios-leaf`
   - `webDecodedVideoFrames` and `webDecodedAudioBlocks` are both greater than `0`
   - `encodedFramesForwarded` and `encodedAudioFramesForwarded` are both `0`
   - `observedMediaManifests[].forwardedVideoFrames` and `observedMediaManifests[].forwardedAudioFrames` stay `0`
6. Add another viewer after iOS joined. Confirm the new viewer is not assigned to the iOS viewer as upstream.
7. Open the 3010 admin dashboard and confirm the iOS node shows `ios/safari`, `web leaf`, `audio out`, and the detected codec list.

Pass criteria: iOS Safari watches successfully, never receives `connect-to-next`, and reports no forwarded audio/video counters.

## Case 2: Android Chrome Viewer

1. Open the Web viewer in Android Chrome.
2. Confirm capability detection passes.
3. Join a native-host room.
4. Verify H.264 video and Opus audio playback.
5. Repeat with H.265 and AAC when host capability is available.
6. Copy diagnostics and confirm:
   - `platform` is `android`
   - `browserFamily` is `chromium`
   - `androidChromium` is `true`
   - `androidChrome` is `true`
   - `secureContext`, `webRtc`, `webCodecsVideoDecoder`, and `webCodecsAudioDecoder` are all `true`
   - `ok` is `true` and `reasons` is empty
   - `audioOutput` is `true`
   - `relayCapable` is `true` only when `supportedVideoCodecs` includes both `h264` and `h265`, `supportedAudioCodecs` includes both `opus` and `aac`, `supportedVideoPayloadFormats` includes `annexb`/`avcc`, and `supportedAudioPayloadFormats` includes `opus-raw`/`raw`/`aac-adts`
   - `maxDirectDownstreams` is `1`
   - `serverMediaCapabilities.relayCapable` is `true`
   - `serverMediaCapabilities.platform` is `android`
   - `serverMediaCapabilities.browserFamily` is `chromium`
   - `serverMediaCapabilities.androidChrome` is `true`
   - `serverMediaCapabilities.maxDirectDownstreams` is `1`
   - `serverMediaCapabilities.relayEligibilityReason` is `relay-ready`
   - `serverMediaCapabilities.localRelayEligibilityReason` is `relay-ready`
7. Confirm the top capability summary shows `android/chromium`, `relay x1`, the detected video codecs, the detected audio codecs, and `audio out`.
8. Open the 3010 admin dashboard and confirm the Android node shows `android/chromium`, `android chrome`, `web relay`, `audio out`, and the same codec list.

Pass criteria: Android Chrome watches successfully with the expected codec matrix.

## Case 2b: Other Android Browser Leaf Viewer

1. Open the Web viewer in a non-Chrome Android browser, such as Samsung Internet, Opera Android, Edge Android, Android WebView, Huawei Browser, or Firefox Android.
2. Confirm capability detection passes only if WebRTC, WebCodecs, Web Audio, and codec probing are available.
3. Join a native-host room.
4. Verify supported H.264/H.265 and Opus/AAC playback according to the detected codec list.
5. Copy diagnostics and confirm:
   - `platform` is `android`
   - `androidChrome` is `false`
   - `relayCapable` is `false`
   - `maxDirectDownstreams` is `0`
   - `serverMediaCapabilities.relayCapable` is `false`
   - `serverMediaCapabilities.platform` is `android`
   - `serverMediaCapabilities.androidChrome` is `false`
   - `serverMediaCapabilities.maxDirectDownstreams` is `0`
   - `serverMediaCapabilities.relayEligibilityReason` explains the leaf decision, such as `android-non-chrome-leaf`
   - `serverMediaCapabilities.localRelayEligibilityReason` is `android-non-chrome-leaf`
   - `webDecodedVideoFrames` and `webDecodedAudioBlocks` are both greater than `0` when audio is expected
   - `observedMediaManifests` includes decoded video/audio counters for the current room manifest
   - `encodedFramesForwarded` and `encodedAudioFramesForwarded` are both `0`
   - `observedMediaManifests[].forwardedVideoFrames` and `observedMediaManifests[].forwardedAudioFrames` stay `0`
6. Add another viewer after this Android browser joined. Confirm the new viewer is not assigned to this browser as upstream.
7. Open the 3010 admin dashboard and confirm the node shows the concrete browser name when available, `web leaf`, `audio out` when available, and the detected codec list.

Pass criteria: non-Chrome Android browsers can watch when capable, never receive `connect-to-next`, and report no forwarded audio/video counters.

## Case 3: Android Chrome Relay

1. Start a native-host room.
2. Join Android Chrome as viewer 1.
3. Join another viewer as viewer 2.
4. Confirm server assigns viewer 2 upstream to Android viewer 1 when host/downstream limits make chain relay applicable.
5. Verify viewer 2 receives video/audio through viewer 1.
6. Copy diagnostics from Android viewer 1 and confirm:
   - `downstreamPeerId` is populated
   - `dataChannelFramesForwarded` increases
   - `encodedFramesForwarded` increases for video
   - `encodedAudioFramesForwarded` increases for Opus/AAC audio
   - `webDecodedVideoFrames` and `webDecodedAudioBlocks` are both greater than `0` on Android viewer 1 itself
   - `observedMediaManifests` includes decoded and forwarded counters for H.264/H.265 plus Opus/AAC
   - `relayProtocolState` reaches `datachannel-ready` or `forwarding-*`
   - `reencodePathUsed` remains `false`
   - `serverMediaCapabilities.relayEligibilityReason` remains `relay-ready`
   - `serverMediaCapabilities.localRelayEligibilityReason` remains `relay-ready`
7. Confirm server topology uses Android viewer 1 only when its stored `mediaCapabilities.relayCapable` is `true`; missing or `false` must keep downstream viewers on host or another relay-capable upstream.

Pass criteria: Android Chrome watches locally and relays encoded media without browser re-encode.

## Case 4: Mobile Suspend Cleanup

1. Join from Android Chrome as relay-capable viewer.
2. Add a downstream viewer.
3. Background Android Chrome or lock the device.
4. Confirm the Web viewer leaves promptly or server reselects upstream for downstream viewer.
5. Repeat on iOS Safari and confirm it leaves as a leaf viewer without being treated as relay-capable.

Pass criteria: backgrounded mobile viewers do not remain stale relay upstreams.

## Case 5: Codec Probe Fallback

1. In Android Chrome, iOS Safari, and at least one non-Chrome Android browser, copy diagnostics before joining a room.
2. Confirm `supportedVideoCodecs` and `supportedAudioCodecs` are populated only after asynchronous capability detection finishes.
3. If a browser exposes WebCodecs but does not expose `VideoDecoder.isConfigSupported()` / `AudioDecoder.isConfigSupported()`, confirm `navigator.mediaCapabilities.decodingInfo()` determines the codec list.
   H.264/H.265 probing uses multiple common profile/level strings, including H.264 baseline/main/high and H.265 hvc1/hev1 at mobile-friendly levels, so a device should not be rejected only because one exact codec string is unsupported.
4. If neither WebCodecs static codec probing nor MediaCapabilities probing is available, confirm capability detection fails instead of reporting H.264/H.265 + Opus/AAC support.

Pass criteria: the Web viewer never advertises codec support that was not explicitly detected.

## Case 6: Failure Evidence

If a run fails, capture:

- Copied Web diagnostics.
- Host native P2P/capture diagnostics.
- Server topology/admin snapshot if available.
- 3010 node pills for platform/browser, `web relay` or `web leaf`, `audio out` or `no audio out`, and codec lists.
- `serverMediaCapabilities.relayEligibilityReason` from copied Web diagnostics and the matching 3010 node pill.
- Browser console error text.
- Device model, OS version, browser version, and whether Low Power Mode / battery saver is enabled.

Treat these as release blockers when reproducible:

- iOS Safari reports `relayCapable: true`.
- Android Chrome reports `relayCapable: true` without the full H.264/H.265 + Opus/AAC codec and payload-format target matrix, or reports `relayCapable: false` when the full matrix is supported.
- Samsung Internet or another non-Chrome Android browser reports `relayCapable: true`.
- Any Web viewer is selected as relay upstream without explicitly reporting `relayCapable: true`.
- Copied diagnostics report `audioOutput: false` while audio playback is expected to work.
- Android relay uses re-encode instead of encoded DataChannel forwarding.
- H.265 manifest is accepted but all frames fail `webcodecs-h265-config-unsupported` on a device that reported H.265 support.
- Diagnostics show missing payload format support for the manifest currently being sent, such as no `annexb`/`avcc` for video or no `aac-adts` for AAC.
- `environment.relayCapable` and `serverMediaCapabilities.relayCapable` disagree without a clear `relayEligibilityReason` explaining why the server downgraded the node.
- AAC manifest is accepted but audio never decodes after a user gesture.
