const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');

function loadTsModule(relativePath, globals = {}) {
  const absolutePath = path.join(repoRoot, relativePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove
    },
    fileName: absolutePath
  });

  const module = { exports: {} };
  const fn = new Function(
    'module',
    'exports',
    'require',
    ...Object.keys(globals),
    `${transpiled.outputText}\nreturn module.exports;`
  );
  return fn(
    module,
    module.exports,
    require,
    ...Object.values(globals)
  );
}

function makeFramePayload() {
  return new Uint8Array([
    0, 0, 0, 1,
    0x67, 0x42, 0xe0, 0x1f, 0x89, 0x8b,
    0, 0, 0, 1,
    0x68, 0xce, 0x3c, 0x80,
    0, 0, 0, 1,
    0x65, 0x88, 0x84
  ]).buffer;
}

function makeHevcFramePayload() {
  return new Uint8Array([
    0, 0, 0, 1,
    0x42, 0x01, 0x01, 0x01,
    0, 0, 0, 1,
    0x44, 0x01, 0x01, 0x01, 0x01, 0x5d, 0x5d,
    0, 0, 0, 1,
    0x4e, 0x01, 0x01, 0x01,
    0, 0, 0, 1,
    0x26, 0x01, 0x80, 0x88, 0x84
  ]).buffer;
}

async function testMobileCapabilityPolicies() {
  const capabilitiesModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      webkitAudioContext: function FakeWebkitAudioContext() {}
    }
  });
  const iosSafari = await capabilitiesModule.detectCapabilitiesAsync();
  assert.strictEqual(iosSafari.ok, true);
  assert.strictEqual(iosSafari.platform, 'ios');
  assert.strictEqual(iosSafari.browserFamily, 'safari');
  assert.strictEqual(iosSafari.iosSafari, true);
  assert.strictEqual(iosSafari.iosWebKit, true);
  assert.strictEqual(iosSafari.audioOutput, true);
  assert.strictEqual(iosSafari.relayCapable, false);
  assert.strictEqual(iosSafari.maxDirectDownstreams, 0);
  assert.strictEqual(iosSafari.relayEligibilityReason, 'ios-leaf');
  assert.deepStrictEqual(iosSafari.supportedVideoCodecs, ['h264', 'h265']);
  assert.deepStrictEqual(iosSafari.supportedAudioCodecs, ['opus', 'aac']);

  const ipadSafariModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      webkitAudioContext: function FakeWebkitAudioContext() {}
    }
  });
  const ipadSafari = await ipadSafariModule.detectCapabilitiesAsync();
  assert.strictEqual(ipadSafari.ok, true);
  assert.strictEqual(ipadSafari.platform, 'ios');
  assert.strictEqual(ipadSafari.browser, 'Safari 18.0');
  assert.strictEqual(ipadSafari.browserFamily, 'safari');
  assert.strictEqual(ipadSafari.iosSafari, true);
  assert.strictEqual(ipadSafari.iosWebKit, true);
  assert.strictEqual(ipadSafari.relayCapable, false);
  assert.strictEqual(ipadSafari.maxDirectDownstreams, 0);

  const iosChromeModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      webkitAudioContext: function FakeWebkitAudioContext() {}
    }
  });
  const iosChrome = await iosChromeModule.detectCapabilitiesAsync();
  assert.strictEqual(iosChrome.ok, false);
  assert.strictEqual(iosChrome.platform, 'ios');
  assert.strictEqual(iosChrome.browser, 'Chrome iOS 126.0.0.0');
  assert.strictEqual(iosChrome.browserFamily, 'chromium');
  assert.strictEqual(iosChrome.iosSafari, false);
  assert.strictEqual(iosChrome.iosWebKit, true);
  assert.strictEqual(iosChrome.relayCapable, false);
  assert.strictEqual(iosChrome.maxDirectDownstreams, 0);
  assert.ok(iosChrome.reasons.some((reason) => reason.includes('iOS Safari')));

  const iosEdgeModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/126.0.0.0 Mobile/15E148 Safari/604.1'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      webkitAudioContext: function FakeWebkitAudioContext() {}
    }
  });
  const iosEdge = await iosEdgeModule.detectCapabilitiesAsync();
  assert.strictEqual(iosEdge.ok, false);
  assert.strictEqual(iosEdge.platform, 'ios');
  assert.strictEqual(iosEdge.browser, 'Edge iOS 126.0.0.0');
  assert.strictEqual(iosEdge.browserFamily, 'chromium');
  assert.strictEqual(iosEdge.iosSafari, false);
  assert.strictEqual(iosEdge.iosWebKit, true);
  assert.strictEqual(iosEdge.relayCapable, false);
  assert.strictEqual(iosEdge.maxDirectDownstreams, 0);

  const androidModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioContext: function FakeAudioContext() {}
    }
  });
  const androidChrome = await androidModule.detectCapabilitiesAsync();
  assert.strictEqual(androidChrome.ok, true);
  assert.strictEqual(androidChrome.platform, 'android');
  assert.strictEqual(androidChrome.androidChromium, true);
  assert.strictEqual(androidChrome.androidChrome, true);
  assert.strictEqual(androidChrome.audioOutput, true);
  assert.strictEqual(androidChrome.relayCapable, true);
  assert.strictEqual(androidChrome.maxDirectDownstreams, 1);
  assert.strictEqual(androidChrome.relayEligibilityReason, 'relay-ready');
  assert.deepStrictEqual(androidChrome.supportedVideoCodecs, ['h264', 'h265']);
  assert.deepStrictEqual(androidChrome.supportedAudioCodecs, ['opus', 'aac']);

  const androidChromeLanHttpModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { protocol: 'http:', hostname: '192.168.5.10' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    },
    window: {
      isSecureContext: false,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioContext: function FakeAudioContext() {}
    }
  });
  const androidChromeLanHttp = await androidChromeLanHttpModule.detectCapabilitiesAsync();
  assert.strictEqual(androidChromeLanHttp.ok, true);
  assert.strictEqual(androidChromeLanHttp.secureContext, true);
  assert.strictEqual(androidChromeLanHttp.lanHttpAllowed, true);
  assert.strictEqual(androidChromeLanHttp.relayCapable, true);

  const desktopChromeModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioContext: function FakeAudioContext() {}
    }
  });
  const desktopChrome = await desktopChromeModule.detectCapabilitiesAsync();
  assert.strictEqual(desktopChrome.ok, true);
  assert.strictEqual(desktopChrome.platform, 'desktop');
  assert.strictEqual(desktopChrome.chromeOrEdge, true);
  assert.strictEqual(desktopChrome.androidChrome, false);
  assert.strictEqual(desktopChrome.relayCapable, true);
  assert.strictEqual(desktopChrome.maxDirectDownstreams, 1);

  const hvc1OnlyModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: {
        isConfigSupported: async (config) => ({ supported: config.codec === 'avc1.42E01F' || config.codec === 'hvc1.1.6.L120.B0' })
      },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      webkitAudioContext: function FakeWebkitAudioContext() {}
    }
  });
  const hvc1OnlySafari = await hvc1OnlyModule.detectCapabilitiesAsync();
  assert.strictEqual(hvc1OnlySafari.ok, true);
  assert.deepStrictEqual(hvc1OnlySafari.supportedVideoCodecs, ['h264', 'h265']);

  const highProfileOnlyModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: {
        isConfigSupported: async (config) => ({ supported: config.codec === 'avc1.640028' || config.codec === 'hev1.1.6.L150.B0' })
      },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioContext: function FakeAudioContext() {}
    }
  });
  const highProfileOnly = await highProfileOnlyModule.detectCapabilitiesAsync();
  assert.strictEqual(highProfileOnly.ok, true);
  assert.deepStrictEqual(highProfileOnly.supportedVideoCodecs, ['h264', 'h265']);
  assert.ok(highProfileOnly.videoCodecProbeResults.some((probe) => probe.codec === 'avc1.640028' && probe.supported === true));
  assert.ok(highProfileOnly.videoCodecProbeResults.some((probe) => probe.codec === 'hev1.1.6.L150.B0' && probe.supported === true));
  assert.strictEqual(highProfileOnly.relayCapable, true);

  const mediaCapabilitiesFallbackModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      mediaCapabilities: {
        decodingInfo: async (configuration) => ({
          supported: /avc1\.640028|hvc1\.1\.6\.L150\.B0|opus|mp4a\.40\.2/.test(JSON.stringify(configuration))
        })
      }
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: {},
      AudioDecoder: {},
      AudioContext: function FakeAudioContext() {}
    }
  });
  const mediaCapabilitiesFallback = await mediaCapabilitiesFallbackModule.detectCapabilitiesAsync();
  assert.strictEqual(mediaCapabilitiesFallback.ok, true);
  assert.ok(mediaCapabilitiesFallback.videoCodecProbeResults.some((probe) => probe.codec.includes('avc1.640028') && probe.source === 'media-capabilities' && probe.supported === true));
  assert.ok(mediaCapabilitiesFallback.videoCodecProbeResults.some((probe) => probe.codec.includes('hvc1.1.6.L150.B0') && probe.source === 'media-capabilities' && probe.supported === true));
  assert.strictEqual(mediaCapabilitiesFallback.relayCapable, true);
  assert.deepStrictEqual(mediaCapabilitiesFallback.supportedVideoCodecs, ['h264', 'h265']);
  assert.deepStrictEqual(mediaCapabilitiesFallback.supportedAudioCodecs, ['opus', 'aac']);

  const samsungInternetModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/126.0.0.0 Mobile Safari/537.36'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioContext: function FakeAudioContext() {}
    }
  });
  const samsungInternet = await samsungInternetModule.detectCapabilitiesAsync();
  assert.strictEqual(samsungInternet.ok, true);
  assert.strictEqual(samsungInternet.androidChromium, true);
  assert.strictEqual(samsungInternet.androidChrome, false);
  assert.strictEqual(samsungInternet.relayCapable, false);
  assert.strictEqual(samsungInternet.maxDirectDownstreams, 0);

  const androidOperaModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 OPR/84.0.0.0'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioContext: function FakeAudioContext() {}
    }
  });
  const androidOpera = await androidOperaModule.detectCapabilitiesAsync();
  assert.strictEqual(androidOpera.ok, true);
  assert.strictEqual(androidOpera.browser, 'Opera 84.0.0.0');
  assert.strictEqual(androidOpera.platform, 'android');
  assert.strictEqual(androidOpera.browserFamily, 'chromium');
  assert.strictEqual(androidOpera.androidChromium, true);
  assert.strictEqual(androidOpera.androidChrome, false);
  assert.strictEqual(androidOpera.relayCapable, false);
  assert.strictEqual(androidOpera.maxDirectDownstreams, 0);

  const androidEdgeModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.0.0'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioContext: function FakeAudioContext() {}
    }
  });
  const androidEdge = await androidEdgeModule.detectCapabilitiesAsync();
  assert.strictEqual(androidEdge.ok, true);
  assert.strictEqual(androidEdge.browser, 'Edge Android 126.0.0.0');
  assert.strictEqual(androidEdge.platform, 'android');
  assert.strictEqual(androidEdge.browserFamily, 'chromium');
  assert.strictEqual(androidEdge.androidChromium, true);
  assert.strictEqual(androidEdge.androidChrome, false);
  assert.strictEqual(androidEdge.relayCapable, false);
  assert.strictEqual(androidEdge.maxDirectDownstreams, 0);

  const androidWebViewModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.240905.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioContext: function FakeAudioContext() {}
    }
  });
  const androidWebView = await androidWebViewModule.detectCapabilitiesAsync();
  assert.strictEqual(androidWebView.ok, true);
  assert.strictEqual(androidWebView.browser, 'Android WebView 126.0.0.0');
  assert.strictEqual(androidWebView.platform, 'android');
  assert.strictEqual(androidWebView.browserFamily, 'chromium');
  assert.strictEqual(androidWebView.androidChromium, true);
  assert.strictEqual(androidWebView.androidChrome, false);
  assert.strictEqual(androidWebView.relayCapable, false);
  assert.strictEqual(androidWebView.maxDirectDownstreams, 0);

  const huaweiBrowserModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; HUAWEI) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 HuaweiBrowser/15.0.0.0'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioContext: function FakeAudioContext() {}
    }
  });
  const huaweiBrowser = await huaweiBrowserModule.detectCapabilitiesAsync();
  assert.strictEqual(huaweiBrowser.ok, true);
  assert.strictEqual(huaweiBrowser.browser, 'Huawei Browser 15.0.0.0');
  assert.strictEqual(huaweiBrowser.androidChromium, true);
  assert.strictEqual(huaweiBrowser.androidChrome, false);
  assert.strictEqual(huaweiBrowser.relayCapable, false);
  assert.strictEqual(huaweiBrowser.maxDirectDownstreams, 0);

  const androidFirefoxModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Android 15; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioContext: function FakeAudioContext() {}
    }
  });
  const androidFirefox = await androidFirefoxModule.detectCapabilitiesAsync();
  assert.strictEqual(androidFirefox.ok, true);
  assert.strictEqual(androidFirefox.platform, 'android');
  assert.strictEqual(androidFirefox.browserFamily, 'firefox');
  assert.strictEqual(androidFirefox.androidChromium, false);
  assert.strictEqual(androidFirefox.androidChrome, false);
  assert.strictEqual(androidFirefox.relayCapable, false);
  assert.strictEqual(androidFirefox.maxDirectDownstreams, 0);
  assert.deepStrictEqual(androidFirefox.supportedVideoCodecs, ['h264', 'h265']);
  assert.deepStrictEqual(androidFirefox.supportedAudioCodecs, ['opus', 'aac']);

  const partialAndroidChromeModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async (config) => ({ supported: String(config.codec || '').startsWith('avc1.') }) },
      AudioDecoder: { isConfigSupported: async (config) => ({ supported: config.codec === 'opus' }) },
      AudioContext: function FakeAudioContext() {}
    }
  });
  const partialAndroidChrome = await partialAndroidChromeModule.detectCapabilitiesAsync();
  assert.strictEqual(partialAndroidChrome.ok, true);
  assert.strictEqual(partialAndroidChrome.androidChrome, true);
  assert.deepStrictEqual(partialAndroidChrome.supportedVideoCodecs, ['h264']);
  assert.deepStrictEqual(partialAndroidChrome.supportedAudioCodecs, ['opus']);
  assert.strictEqual(partialAndroidChrome.relayCapable, false);
  assert.strictEqual(partialAndroidChrome.maxDirectDownstreams, 0);
  assert.strictEqual(partialAndroidChrome.relayEligibilityReason, 'missing-android-relay-codec-matrix');

  const noStaticCodecProbeModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: {},
      AudioDecoder: {},
      AudioContext: function FakeAudioContext() {}
    }
  });
  const noStaticCodecProbe = await noStaticCodecProbeModule.detectCapabilitiesAsync();
  assert.strictEqual(noStaticCodecProbe.ok, false);
  assert.strictEqual(noStaticCodecProbe.relayCapable, false);
  assert.deepStrictEqual(noStaticCodecProbe.supportedVideoCodecs, []);
  assert.deepStrictEqual(noStaticCodecProbe.supportedAudioCodecs, []);
  assert.match(noStaticCodecProbe.reasons.join(' '), /浏览器缺少可用的视频解码格式/);
  assert.match(noStaticCodecProbe.reasons.join(' '), /浏览器缺少可用的音频解码格式/);
}

async function testAacCapabilityProbeUsesAudioSpecificConfig() {
  const capabilitiesModule = loadTsModule('vds_web/src/capabilities.ts', {
    RTCPeerConnection: function FakeRTCPeerConnection() {},
    location: { hostname: 'example.com' },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    },
    window: {
      isSecureContext: true,
      EncodedVideoChunk: function FakeEncodedVideoChunk() {},
      EncodedAudioChunk: function FakeEncodedAudioChunk() {},
      VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
      AudioDecoder: {
        isConfigSupported: async (config) => ({
          supported: config.codec === 'opus' ||
            (config.codec === 'mp4a.40.2' && Array.from(config.description || []).join(',') === '17,144')
        })
      },
      AudioContext: function FakeAudioContext() {}
    }
  });
  const report = await capabilitiesModule.detectCapabilitiesAsync();
  assert.deepStrictEqual(report.supportedAudioCodecs, ['opus', 'aac']);
  assert.strictEqual(report.relayCapable, true);
}

function testEncodedMediaCapabilitiesRequireDetectedCodecTargets() {
  const protocol = loadTsModule('vds_web/src/datachannel-protocol.ts');
  const capabilities = protocol.webEncodedMediaCapabilities();
  assert.deepStrictEqual(capabilities.supportedVideoCodecs, []);
  assert.deepStrictEqual(capabilities.supportedAudioCodecs, []);
  assert.deepStrictEqual(capabilities.supportedVideoPayloadFormats, []);
  assert.deepStrictEqual(capabilities.supportedAudioPayloadFormats, []);
  const detectedCapabilities = protocol.webEncodedMediaCapabilities({
    supportedVideoCodecs: ['h264', 'h265'],
    supportedAudioCodecs: ['opus', 'aac']
  });
  assert.deepStrictEqual(detectedCapabilities.supportedVideoCodecs, ['h264', 'h265']);
  assert.deepStrictEqual(detectedCapabilities.supportedAudioCodecs, ['opus', 'aac']);
  assert.deepStrictEqual(detectedCapabilities.supportedVideoPayloadFormats, ['annexb', 'avcc']);
  assert.deepStrictEqual(detectedCapabilities.supportedAudioPayloadFormats, ['opus-raw', 'raw', 'aac-adts']);
  const realCodecStringCapabilities = protocol.webEncodedMediaCapabilities({
    supportedVideoCodecs: ['avc1.640028', 'hvc1.1.6.L120.B0', 'hev1.1.6.L150.B0', 'avc3.42E01F'],
    supportedAudioCodecs: ['opus', 'mp4a.40.2']
  });
  assert.deepStrictEqual(realCodecStringCapabilities.supportedVideoCodecs, ['h264', 'h265']);
  assert.deepStrictEqual(realCodecStringCapabilities.supportedAudioCodecs, ['opus', 'aac']);
  assert.deepStrictEqual(realCodecStringCapabilities.supportedAudioPayloadFormats, ['opus-raw', 'raw', 'aac-adts']);
  const hello = protocol.helloMessage('relay', undefined, {
    supportedVideoCodecs: ['h265'],
    supportedAudioCodecs: ['aac']
  });
  assert.deepStrictEqual(hello.supportedVideoCodecs, ['h265']);
  assert.deepStrictEqual(hello.supportedAudioCodecs, ['aac']);
  assert.deepStrictEqual(hello.supportedVideoPayloadFormats, ['annexb', 'avcc']);
  assert.deepStrictEqual(hello.supportedAudioPayloadFormats, ['aac-adts', 'raw']);
}

function testWebJoinPayloadIncludesMobileRelayCapabilities() {
  const source = fs.readFileSync(path.join(repoRoot, 'vds_web/src/main.ts'), 'utf8');
  const html = fs.readFileSync(path.join(repoRoot, 'vds_web/index.html'), 'utf8');
  assert.match(source, /let capabilityDetectionComplete = false/);
  assert.match(source, /capabilityDetectionComplete = true;[\s\S]*?renderCapability\(capability\);/);
  assert.match(source, /if \(!capabilityDetectionComplete\) \{[\s\S]*?浏览器能力检测尚未完成/);
  assert.match(source, /pending \|\| !capabilityDetectionComplete \|\| !capability\.ok/);
  assert.match(source, /if \(!capability\.ok\) \{[\s\S]*?if \(session\) \{[\s\S]*?resetLocalViewerSession\(\);[\s\S]*?\} else \{[\s\S]*?clearStoredSession\(\);/);
  assert.match(source, /setJoinPending\(false\);\s*void bootstrap\(\);/);
  assert.match(html, /id="joinButton"[^>]*disabled/);
  assert.match(html, /id="refreshRoomsButton"[^>]*disabled/);
  assert.match(source, /type:\s*'join-room'/);
  assert.match(source, /maxDirectDownstreams:\s*capability\.maxDirectDownstreams/);
  assert.match(source, /mobile:\s*capability\.mobile/);
  assert.match(source, /platform:\s*capability\.platform/);
  assert.match(source, /browser:\s*capability\.browser/);
  assert.match(source, /browserFamily:\s*capability\.browserFamily/);
  assert.match(source, /androidChrome:\s*capability\.androidChrome/);
  assert.match(source, /audioOutput:\s*capability\.audioOutput/);
  assert.match(source, /relayCapable:\s*capability\.relayCapable/);
  assert.match(source, /relayEligibilityReason:\s*capability\.relayEligibilityReason/);
  assert.match(source, /relayEligibilityReason/);
  assert.match(source, /encodedMediaDataChannel:\s*getWebEncodedMediaCapabilities\(\)/);
  assert.match(fs.readFileSync(path.join(repoRoot, 'vds_web/src/datachannel-protocol.ts'), 'utf8'), /supportedVideoPayloadFormats:\s*supportedVideoCodecs\.length > 0 \? \['annexb', 'avcc'\] : \[\]/);
  assert.match(fs.readFileSync(path.join(repoRoot, 'vds_web/src/datachannel-protocol.ts'), 'utf8'), /supportedAudioPayloadFormats:\s*getSupportedAudioPayloadFormats\(supportedAudioCodecs\)/);
  assert.match(source, /if \(!capability\.relayCapable\) \{/);
  assert.match(source, /relayFailureReason:\s*'web-mobile-relay-disabled'/);
  assert.match(source, /async function handleConnectToNext\(message: SignalMessage\): Promise<void> \{[\s\S]*?const manifestFailure = getManifestCompatibilityFailure\(message\.mediaManifest\);[\s\S]*?downstreamPeerId = String\(message\.nextViewerId \|\| message\.targetId \|\| ''\);/);
  assert.match(source, /web-video-payload-format-unsupported:\$\{videoPayloadFormat \|\| 'unknown'\}/);
  assert.match(source, /raw\.startsWith\('avc1'\)/);
  assert.match(source, /raw\.startsWith\('avc3'\)/);
  assert.match(source, /raw\.startsWith\('hvc1'\)/);
  assert.match(source, /raw\.startsWith\('hev1'\)/);
  assert.match(source, /compact === 'mp4a402'/);
  assert.match(source, /normalizedAudioCodec === 'opus' && audioPayloadFormat !== 'opus-raw' && audioPayloadFormat !== 'raw'/);
  assert.match(source, /normalizedAudioCodec === 'aac' && audioPayloadFormat !== 'aac-adts' && audioPayloadFormat !== 'raw'/);
  assert.match(source, /web-audio-payload-format-unsupported:\$\{audioPayloadFormat \|\| 'unknown'\}/);
  assert.match(source, /document\.addEventListener\('pointerdown', unlockAudioFromUserGesture/);
  assert.match(source, /document\.addEventListener\('touchend', unlockAudioFromUserGesture/);
  assert.match(source, /function unlockAudioFromUserGesture\(\)/);
  assert.match(source, /document\.addEventListener\('visibilitychange', handleVisibilityChange\)/);
  assert.match(source, /window\.addEventListener\('pagehide', \(\) => handleMobilePageSuspended\('pagehide', true\)\)/);
  assert.match(source, /if \(document\.visibilityState === 'hidden'\) \{[\s\S]*?handleMobilePageSuspended\('visibility-hidden', false\);/);
  assert.match(source, /mobileSuspendTimer = window\.setTimeout\(leave, 1500\)/);
  assert.match(source, /function clearMobileSuspendTimer\(\): void \{[\s\S]*?window\.clearTimeout\(mobileSuspendTimer\);/);
  assert.match(source, /relayFailureReason:\s*capability\.relayCapable \? 'mobile-relay-suspended' : undefined/);
  assert.match(source, /syncFullscreenAvailability\(\)/);
  assert.match(source, /function isFullscreenSupported\(\)/);
  assert.match(source, /fullscreenButton\.classList\.toggle\('hidden', !isFullscreenSupported\(\)\)/);
  assert.match(source, /function createClientUuid\(\): string \{/);
  assert.match(source, /typeof cryptoApi\?\.randomUUID === 'function'/);
  assert.match(source, /typeof cryptoApi\?\.getRandomValues === 'function'/);
  assert.match(source, /cryptoApi\.getRandomValues\(bytes\)/);
  assert.match(source, /Math\.random\(\)\.toString\(36\)/);
  assert.match(source, /const capabilitySummary = getElement<HTMLParagraphElement>\('capabilitySummary'\)/);
  assert.match(source, /const browserText = report\.browser \|\| report\.browserFamily/);
  assert.match(source, /const platformText = `\$\{report\.platform\}\/\$\{browserText\}`/);
  assert.match(source, /capabilitySummary\.textContent = `\$\{platformText\} · \$\{relayText\} · \$\{report\.relayEligibilityReason\} · \$\{videoText\} · \$\{audioText\} · \$\{outputText\}`/);
}

function testMobileViewportAndSafeAreaStylesArePresent() {
  const html = fs.readFileSync(path.join(repoRoot, 'vds_web/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(repoRoot, 'vds_web/src/styles.css'), 'utf8');
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /id="capabilitySummary"/);
  assert.match(html, /id="downloadDiagnosticsButton"/);
  assert.match(css, /env\(safe-area-inset-top/);
  assert.match(css, /100dvh/);
  assert.match(css, /touch-action:\s*manipulation/);
  assert.match(css, /@media \(max-width:\s*520px\)/);
  assert.match(css, /\.viewer-capability-summary/);
  assert.match(css, /@media \(max-width:\s*900px\)[\s\S]*?\.diagnostics-panel \{[\s\S]*?display:\s*block;/);
  assert.match(css, /grid-template-columns:\s*minmax\(0, 1fr\) 56px 56px/);
  assert.match(css, /\.diagnostics-panel textarea \{[\s\S]*?max-height:\s*220px;/);
}

function testRelayKeepsLocalPlaybackWhileForwarding() {
  const source = fs.readFileSync(path.join(repoRoot, 'vds_web/src/main.ts'), 'utf8');
  const inboundFrameHandler = /function handleInboundEncodedFrame\([\s\S]*?\n}\n\nfunction scheduleVideoFrameDecode/.exec(source);
  assert.ok(inboundFrameHandler, 'handleInboundEncodedFrame block should be present');
  assert.match(inboundFrameHandler[0], /if \(decoded\.header\.streamType === 'audio'\) \{\s*void dataChannelAudioPlayer\.pushFrame\(decoded\.header, decoded\.payload\);\s*\} else \{\s*scheduleVideoFrameDecode\(decoded\.header, decoded\.payload\);\s*\}\s*forwardDecodedDataChannelFrame\(decoded\.header, decoded\.payload\);/);
  assert.doesNotMatch(source, /forward-only audio|skipLocalAudio|suppressLocalAudio|relayOnlyAudio/);
}

function testDiagnosticsReportIncludesMobileEnvironmentSummary() {
  const diagnosticsModule = loadTsModule('vds_web/src/diagnostics.ts');
  const store = new diagnosticsModule.DiagnosticsStore({
    browser: 'Safari 18.0',
    userAgent: 'mobile-safari',
    secureContext: true,
    lanHttpAllowed: false,
    chromeOrEdge: false,
    browserFamily: 'safari',
    platform: 'ios',
    mobile: true,
    iosSafari: true,
    iosWebKit: true,
    androidChromium: false,
    androidChrome: false,
    audioOutput: true,
    relayCapable: false,
    maxDirectDownstreams: 0,
    relayEligibilityReason: 'ios-leaf',
    webRtc: true,
    webCodecsVideoDecoder: true,
    webCodecsAudioDecoder: true,
    supportedVideoCodecs: ['h264', 'h265'],
    supportedAudioCodecs: ['opus', 'aac'],
    videoCodecProbeResults: [{ codec: 'avc1.640028', target: 'h264', supported: true, source: 'webcodecs' }],
    audioCodecProbeResults: [{ codec: 'mp4a.40.2', target: 'aac', supported: true, source: 'webcodecs' }],
    ok: true,
    reasons: []
  }, 'web-client');
  store.update({ sessionToken: '0123456789abcdef' });
  store.update({
    serverMediaCapabilities: {
      webViewer: true,
      relayCapable: false,
      browserFamily: 'safari',
      relayEligibilityReason: 'ios-leaf',
      localRelayEligibilityReason: 'ios-leaf'
    }
  });
  store.update({
    mediaManifest: {
      protocol: 'vds-media-encoded-v1',
      video: { codec: 'h264', payloadFormat: 'annexb' },
      audio: { codec: 'opus', payloadFormat: 'opus-raw' }
    }
  });
  store.incrementCounter('webDecodedVideoFrames', 3);
  store.incrementCounter('webDecodedAudioBlocks', 4);
  store.incrementCounter('encodedFramesForwarded', 5);
  store.incrementCounter('encodedAudioFramesForwarded', 6);
  store.update({
    mediaManifest: {
      protocol: 'vds-media-encoded-v1',
      video: { codec: 'h265', payloadFormat: 'annexb' },
      audio: { codec: 'aac', payloadFormat: 'aac-adts' }
    }
  });
  store.incrementCounter('webDecodedVideoFrames', 7);
  store.incrementCounter('webDecodedAudioBlocks', 8);
  store.incrementCounter('encodedFramesForwarded', 9);
  store.incrementCounter('encodedAudioFramesForwarded', 10);
  store.update({
    mediaManifest: {
      protocol: 'vds-media-encoded-v1',
      video: { codec: 'h265', payloadFormat: 'annexb' },
      audio: { codec: 'aac', payloadFormat: 'aac-adts' }
    }
  });
  const report = JSON.parse(store.format());
  assert.strictEqual(report.diagnosticsSchemaVersion, 2);
  assert.ok(Number.isFinite(Date.parse(report.diagnosticsGeneratedAt)));
  assert.strictEqual(report.recommendedFixtureFilename, 'ios-safari-leaf.json');
  assert.strictEqual(report.environment.platform, 'ios');
  assert.strictEqual(report.environment.browserFamily, 'safari');
  assert.strictEqual(report.environment.secureContext, true);
  assert.strictEqual(report.environment.lanHttpAllowed, false);
  assert.strictEqual(report.environment.webRtc, true);
  assert.strictEqual(report.environment.webCodecsVideoDecoder, true);
  assert.strictEqual(report.environment.webCodecsAudioDecoder, true);
  assert.strictEqual(report.environment.ok, true);
  assert.deepStrictEqual(report.environment.reasons, []);
  assert.strictEqual(report.environment.iosWebKit, true);
  assert.strictEqual(report.environment.androidChrome, false);
  assert.strictEqual(report.environment.audioOutput, true);
  assert.strictEqual(report.environment.relayCapable, false);
  assert.strictEqual(report.environment.relayEligibilityReason, 'ios-leaf');
  assert.deepStrictEqual(report.environment.supportedVideoCodecs, ['h264', 'h265']);
  assert.deepStrictEqual(report.environment.supportedAudioCodecs, ['opus', 'aac']);
  assert.deepStrictEqual(report.environment.videoCodecProbeResults, [{ codec: 'avc1.640028', target: 'h264', supported: true, source: 'webcodecs' }]);
  assert.deepStrictEqual(report.environment.audioCodecProbeResults, [{ codec: 'mp4a.40.2', target: 'aac', supported: true, source: 'webcodecs' }]);
  assert.deepStrictEqual(report.environment.supportedVideoPayloadFormats, ['annexb', 'avcc']);
  assert.deepStrictEqual(report.environment.supportedAudioPayloadFormats, ['opus-raw', 'raw', 'aac-adts']);
  assert.strictEqual(report.serverMediaCapabilities.webViewer, true);
  assert.strictEqual(report.serverMediaCapabilities.relayCapable, false);
  assert.strictEqual(report.serverMediaCapabilities.browserFamily, 'safari');
  assert.strictEqual(report.serverMediaCapabilities.relayEligibilityReason, 'ios-leaf');
  assert.strictEqual(report.serverMediaCapabilities.localRelayEligibilityReason, 'ios-leaf');
  assert.deepStrictEqual(report.observedMediaManifests, [
    { protocol: 'vds-media-encoded-v1', videoCodec: 'h264', videoPayloadFormat: 'annexb', audioCodec: 'opus', audioPayloadFormat: 'opus-raw', count: 1, decodedVideoFrames: 3, decodedAudioBlocks: 4, forwardedVideoFrames: 5, forwardedAudioFrames: 6 },
    { protocol: 'vds-media-encoded-v1', videoCodec: 'h265', videoPayloadFormat: 'annexb', audioCodec: 'aac', audioPayloadFormat: 'aac-adts', count: 2, decodedVideoFrames: 7, decodedAudioBlocks: 8, forwardedVideoFrames: 9, forwardedAudioFrames: 10 }
  ]);
  assert.deepStrictEqual(report.observedMediaSummary, [
    'h264/annexb+opus/opus-raw seen=1 decoded=v3/a4 forwarded=v5/a6',
    'h265/annexb+aac/aac-adts seen=2 decoded=v7/a8 forwarded=v9/a10'
  ]);
  const qaDoc = fs.readFileSync(path.join(repoRoot, 'docs/WEB_MOBILE_DEVICE_QA.md'), 'utf8');
  assert.match(qaDoc, /serverMediaCapabilities\.relayCapable/);
  assert.match(qaDoc, /serverMediaCapabilities\.relayEligibilityReason/);
  assert.match(qaDoc, /serverMediaCapabilities\.localRelayEligibilityReason/);
  assert.match(qaDoc, /`serverMediaCapabilities\.localRelayEligibilityReason` is `ios-leaf`/);
  assert.match(qaDoc, /`serverMediaCapabilities\.localRelayEligibilityReason` is `relay-ready`/);
  assert.match(qaDoc, /`serverMediaCapabilities\.localRelayEligibilityReason` is `android-non-chrome-leaf`/);
  assert.match(qaDoc, /`serverMediaCapabilities\.platform` is `ios`/);
  assert.match(qaDoc, /`serverMediaCapabilities\.platform` is `android`/);
  assert.match(qaDoc, /`serverMediaCapabilities\.androidChrome` is `true`/);
  assert.match(qaDoc, /`serverMediaCapabilities\.androidChrome` is `false`/);
  assert.match(qaDoc, /missing-android-relay-codec-matrix/);
  assert.match(qaDoc, /check-web-mobile-diagnostics\.js ios-safari-leaf/);
  assert.match(qaDoc, /webDecodedVideoFrames` and `webDecodedAudioBlocks/);
  assert.match(qaDoc, /mediaManifest` codec\/payload compatibility/);
  assert.match(qaDoc, /observedMediaManifests/);
  assert.match(qaDoc, /observedMediaSummary/);
  assert.match(qaDoc, /profile\/level strings/);
  assert.match(qaDoc, /`保存` button/);
  const webSource = fs.readFileSync(path.join(repoRoot, 'vds_web/src/main.ts'), 'utf8');
  assert.match(webSource, /function diagnosticsFixtureFilename\(content: string\): string/);
  assert.match(webSource, /recommendedFixtureFilename/);
  assert.match(webSource, /relayEligibilityReason/);
  assert.match(webSource, /function syncDiagnosticsDownloadHint\(content: string\): void/);
  assert.match(webSource, /downloadDiagnosticsButton\.title = `保存为 \$\{filename\}`/);
  assert.match(webSource, /保存诊断为 \$\{filename\}/);
  assert.match(webSource, /URL\.createObjectURL\(blob\)/);
  const diagnosticsSource = fs.readFileSync(path.join(repoRoot, 'vds_web/src/diagnostics.ts'), 'utf8');
  assert.match(diagnosticsSource, /recommendedFixtureFilename: recommendedFixtureFilename\(capability\)/);
  assert.match(diagnosticsSource, /ios-safari-leaf\.json/);
  assert.match(diagnosticsSource, /android-chrome-relay\.json/);
  assert.match(diagnosticsSource, /android-non-chrome-leaf\.json/);
  const diagnosticsChecker = fs.readFileSync(path.join(repoRoot, 'scripts/check-web-mobile-diagnostics.js'), 'utf8');
  assert.match(diagnosticsChecker, /diagnosticsSchemaVersion must be 2/);
  assert.match(diagnosticsChecker, /diagnosticsGeneratedAt must be a valid ISO timestamp/);
  assert.match(diagnosticsChecker, /recommendedFixtureFilename must be present/);
  assert.match(diagnosticsChecker, /recommendedFixtureFilename must be/);
  assert.match(diagnosticsChecker, /serverMediaCapabilities\.webViewer must be true/);
  assert.match(diagnosticsChecker, /serverMediaCapabilities\.localRelayEligibilityReason must be present/);
  assert.match(diagnosticsChecker, /environment\.iosWebKit must be true/);
  assert.match(diagnosticsChecker, /serverMediaCapabilities\.browserFamily must be safari/);
  assert.match(diagnosticsChecker, /environment\.browserFamily must be chromium/);
  assert.match(diagnosticsChecker, /serverMediaCapabilities\.browserFamily must be chromium/);
  assert.match(diagnosticsChecker, /environment\.secureContext must be true/);
  assert.match(diagnosticsChecker, /environment\.webCodecsAudioDecoder must be true/);
  assert.match(diagnosticsChecker, /environment\.ok must be true/);
  assert.match(diagnosticsChecker, /environment\.reasons must be empty/);
  assert.match(diagnosticsChecker, /webDecodedAudioBlocks must be >= 1/);
  assert.match(diagnosticsChecker, /function validateManifestCompatibility/);
  assert.match(diagnosticsChecker, /function validateObservedTargetMatrix/);
  assert.match(diagnosticsChecker, /observedMediaManifests must include observed video codec h265/);
  assert.match(diagnosticsChecker, /environment\.supportedVideoCodecs must include manifest video codec/);
  assert.match(diagnosticsChecker, /const negativeCases = \[/);
  assert.match(diagnosticsChecker, /negative self-test did not catch/);
  assert.match(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'), /"check:web-mobile-diagnostics":\s*"node scripts\/check-web-mobile-diagnostics\.js --self-test"/);
  assert.doesNotMatch(fs.readFileSync(path.join(repoRoot, 'scripts/release-check.js'), 'utf8'), /check:web-mobile-fixtures/);
  assert.match(fs.readFileSync(path.join(repoRoot, 'scripts/release-check.js'), 'utf8'), /Release \$\{mode\} check failed/);
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /npm run build:release/);
  assert.match(readme, /manual QA evidence/);
  assert.match(readme, /check:web-mobile-code/);
  assert.strictEqual(report.encodedAudioFramesForwarded, 16);
  assert.match(fs.readFileSync(path.join(repoRoot, 'vds_web/src/main.ts'), 'utf8'), /incrementCounter\('encodedAudioFramesForwarded'\)/);
  assert.match(fs.readFileSync(path.join(repoRoot, 'vds_web/src/main.ts'), 'utf8'), /serverMediaCapabilities:\s*message\.mediaCapabilities/);
  assert.strictEqual(report.sessionToken, '012345...');
}

function testNativeOfferChecksWebCodecCompatibilityBeforeSignaling() {
  const source = fs.readFileSync(path.join(repoRoot, 'server/public/native/native-peer-controller.js'), 'utf8');
  assert.match(source, /function getDataChannelEncodedMediaUnsupportedReason\(mediaCapabilities, mediaManifest\)/);
  assert.match(source, /getManifestCodecCompatibilityFailure\(mediaCapabilities, mediaManifest \|\| getCurrentMediaManifestSnapshot\(\)\)/);
  assert.match(source, /web-video-codec-capability-missing/);
  assert.match(source, /web-audio-codec-capability-missing/);
  assert.match(source, /web-video-codec-unsupported:\$\{videoCodec \|\| 'unknown'\}/);
  assert.match(source, /web-audio-codec-unsupported:\$\{audioCodec \|\| 'unknown'\}/);
  assert.match(source, /web-video-payload-format-unsupported:\$\{videoPayloadFormat \|\| 'unknown'\}/);
  assert.match(source, /supportedVideoPayloadFormats\.length > 0 && !supportedVideoPayloadFormats\.includes\(videoPayloadFormat\)/);
  assert.match(source, /audioCodec === 'opus' && audioPayloadFormat !== 'opus-raw' && audioPayloadFormat !== 'raw'/);
  assert.match(source, /audioCodec === 'aac' && audioPayloadFormat !== 'aac-adts' && audioPayloadFormat !== 'raw'/);
  assert.match(source, /web-audio-payload-format-unsupported:\$\{audioPayloadFormat \|\| 'unknown'\}/);
  assert.match(source, /supportedAudioPayloadFormats\.length > 0 && !supportedAudioPayloadFormats\.includes\(audioPayloadFormat\)/);
  assert.match(source, /offerOptions\.viewerMediaCapabilities/);
  assert.match(source, /nextViewerMediaCapabilities/);
  assert.match(source, /throw createNonRetryableRelayError\(unsupportedReason\)/);
}

function testNativeTransportEnforcesAdvertisedEncodedFrameLimit() {
  const source = fs.readFileSync(path.join(repoRoot, 'media-agent/src/peer_transport.cpp'), 'utf8');
  assert.match(source, /constexpr std::size_t kEncodedMediaMaxFrameBytes = 2 \* 1024 \* 1024;/);
  assert.match(source, /maxFrameBytes\\\":" \+ std::to_string\(kEncodedMediaMaxFrameBytes\)/);
  assert.match(source, /parsed\.payload\.size\(\) > kEncodedMediaMaxFrameBytes/);
  assert.match(source, /parsed\.frame_payload_bytes > kEncodedMediaMaxFrameBytes/);
  assert.match(source, /frame\.payload\.size\(\) > kEncodedMediaMaxFrameBytes/);
  assert.match(source, /throw std::runtime_error\("datachannel-frame-too-large"\)/);
}

function testDataChannelFrameEnvelope() {
  const protocol = loadTsModule('vds_web/src/datachannel-protocol.ts');
  const payload = makeFramePayload();
  const encoded = protocol.encodeFrameMessage({
    protocol: protocol.ENCODED_MEDIA_PROTOCOL,
    type: 'frame',
    streamType: 'video',
    codec: 'h264',
    payloadFormat: 'annexb',
    timestampUs: 123456,
    sequence: 7,
    keyframe: true,
    config: true
  }, payload);

  const decoded = protocol.decodeFrameMessage(encoded);
  assert.strictEqual(decoded.header.protocol, protocol.ENCODED_MEDIA_PROTOCOL);
  assert.strictEqual(decoded.header.streamType, 'video');
  assert.strictEqual(decoded.header.codec, 'h264');
  assert.strictEqual(decoded.header.timestampUs, 123456);
  assert.strictEqual(decoded.header.sequence, 7);
  assert.strictEqual(decoded.header.keyframe, true);
  assert.deepStrictEqual(Array.from(new Uint8Array(decoded.payload)), Array.from(new Uint8Array(payload)));
}

function testDataChannelFrameRejection() {
  const protocol = loadTsModule('vds_web/src/datachannel-protocol.ts');
  assert.throws(
    () => protocol.decodeFrameMessage(new Uint8Array([0x42, 0x41, 0x44, 0x21]).buffer),
    /datachannel-frame-invalid/
  );
}

function testDataChannelRejectsInvalidChunkSize() {
  const protocol = loadTsModule('vds_web/src/datachannel-protocol.ts');
  const reassembler = new protocol.EncodedFrameReassembler();
  const firstChunk = new Uint8Array(protocol.DATA_CHANNEL_CHUNK_PAYLOAD_BYTES - 1);
  const encoded = protocol.encodeFrameMessage({
    protocol: protocol.ENCODED_MEDIA_PROTOCOL,
    type: 'chunk',
    streamType: 'video',
    codec: 'h264',
    payloadFormat: 'annexb',
    timestampUs: 123,
    sequence: 1,
    keyframe: true,
    config: true,
    frameId: 'invalid-short-first-chunk',
    chunkIndex: 0,
    chunkCount: 2,
    framePayloadBytes: protocol.DATA_CHANNEL_CHUNK_PAYLOAD_BYTES + 1
  }, firstChunk.buffer);

  assert.throws(
    () => reassembler.push(encoded),
    /datachannel-chunk-invalid-header/
  );
}

function testDataChannelRejectsOversizedChunkPayload() {
  const protocol = loadTsModule('vds_web/src/datachannel-protocol.ts');
  const reassembler = new protocol.EncodedFrameReassembler();
  const oversizedChunk = new Uint8Array(protocol.DATA_CHANNEL_CHUNK_PAYLOAD_BYTES + 1);
  const encoded = protocol.encodeFrameMessage({
    protocol: protocol.ENCODED_MEDIA_PROTOCOL,
    type: 'chunk',
    streamType: 'video',
    codec: 'h264',
    payloadFormat: 'annexb',
    timestampUs: 124,
    sequence: 2,
    keyframe: true,
    config: true,
    frameId: 'invalid-oversized-chunk',
    chunkIndex: 0,
    chunkCount: 1,
    framePayloadBytes: oversizedChunk.byteLength
  }, oversizedChunk.buffer);

  assert.throws(
    () => reassembler.push(encoded),
    /datachannel-chunk-invalid-header/
  );
}

function testDataChannelIgnoresDuplicateChunk() {
  const protocol = loadTsModule('vds_web/src/datachannel-protocol.ts');
  const reassembler = new protocol.EncodedFrameReassembler();
  const payload = new Uint8Array(protocol.DATA_CHANNEL_CHUNK_PAYLOAD_BYTES + 5);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = index % 251;
  }
  const messages = protocol.encodeFrameMessages({
    protocol: protocol.ENCODED_MEDIA_PROTOCOL,
    type: 'frame',
    streamType: 'video',
    codec: 'h264',
    payloadFormat: 'annexb',
    timestampUs: 125,
    sequence: 3,
    keyframe: true,
    config: true
  }, payload.buffer);

  assert.strictEqual(reassembler.push(messages[0]), null);
  assert.strictEqual(reassembler.push(messages[0]), null);
  const decoded = reassembler.push(messages[1]);
  assert.ok(decoded);
  assert.deepStrictEqual(Array.from(new Uint8Array(decoded.payload)), Array.from(payload));
}

function testDataChannelReassemblerClearDropsPendingChunks() {
  const protocol = loadTsModule('vds_web/src/datachannel-protocol.ts');
  const reassembler = new protocol.EncodedFrameReassembler();
  const payload = new Uint8Array(protocol.DATA_CHANNEL_CHUNK_PAYLOAD_BYTES + 5);
  const messages = protocol.encodeFrameMessages({
    protocol: protocol.ENCODED_MEDIA_PROTOCOL,
    type: 'frame',
    streamType: 'video',
    codec: 'h264',
    payloadFormat: 'annexb',
    timestampUs: 126,
    sequence: 4,
    keyframe: true,
    config: true
  }, payload.buffer);

  assert.strictEqual(reassembler.push(messages[0]), null);
  reassembler.clear();
  assert.strictEqual(reassembler.push(messages[1]), null);
}

function testDataChannelFrameChunking() {
  const protocol = loadTsModule('vds_web/src/datachannel-protocol.ts');
  const payload = new Uint8Array(protocol.DATA_CHANNEL_CHUNK_PAYLOAD_BYTES * 2 + 17);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = index % 251;
  }

  const messages = protocol.encodeFrameMessages({
    protocol: protocol.ENCODED_MEDIA_PROTOCOL,
    type: 'frame',
    streamType: 'video',
    codec: 'h264',
    payloadFormat: 'annexb',
    timestampUs: 987654,
    sequence: 9,
    keyframe: true,
    config: true
  }, payload.buffer);
  assert.ok(messages.length > 1);

  const reassembler = new protocol.EncodedFrameReassembler();
  let decoded = null;
  for (const message of messages) {
    decoded = reassembler.push(message) || decoded;
  }
  assert.ok(decoded);
  assert.strictEqual(decoded.header.type, 'frame');
  assert.strictEqual(decoded.header.timestampUs, 987654);
  assert.deepStrictEqual(Array.from(new Uint8Array(decoded.payload)), Array.from(payload));
}

async function testWebCodecsPlayerDecodePath() {
  const decodedChunks = [];
  const renderedFrames = [];
  const states = [];
  const drops = [];
  const formats = [];

  class FakeEncodedVideoChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeVideoDecoder {
    static async isConfigSupported(config) {
      assert.strictEqual(config.codec, 'avc1.42E01F');
      assert.deepStrictEqual(config.avc, { format: 'annexb' });
      return { supported: true };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
    }

    configure(config) {
      this.config = config;
      this.state = 'configured';
    }

    decode(chunk) {
      decodedChunks.push(chunk.init);
      this.init.output({
        displayWidth: 1280,
        displayHeight: 720,
        close: () => renderedFrames.push('closed')
      });
    }

    close() {
      this.state = 'closed';
    }
  }

  const fakeCanvas = {
    width: 1,
    height: 1,
    getContext: () => ({
      drawImage: () => renderedFrames.push('drawn')
    })
  };

  const previousWindow = global.window;
  global.window = {
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk
  };

  try {
    const playerModule = loadTsModule('vds_web/src/webcodecs-player.ts');
    const player = new playerModule.WebCodecsVideoPlayer(fakeCanvas, {
      onState: (state) => states.push(state),
      onDecodedFrame: () => renderedFrames.push('decoded'),
      onDroppedFrame: (reason) => drops.push(reason),
      onPayloadFormat: (format) => formats.push(format)
    });

    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'video',
      codec: 'h264',
      payloadFormat: 'annexb',
      timestampUs: 9000,
      sequence: 1,
      keyframe: true,
      config: true
    }, makeFramePayload());

    assert.strictEqual(decodedChunks.length, 1);
    assert.strictEqual(decodedChunks[0].type, 'key');
    assert.strictEqual(decodedChunks[0].timestamp, 9000);
    assert.strictEqual(fakeCanvas.width, 1280);
    assert.strictEqual(fakeCanvas.height, 720);
    assert.ok(states.includes('webcodecs-configured-avc1.42E01F-annexb'));
    assert.ok(renderedFrames.includes('decoded'));
    assert.deepStrictEqual(drops, []);
    assert.ok(formats.includes('annexb:annexb'));
  } finally {
    global.window = previousWindow;
  }
}

async function testWebCodecsVideoAvccFallbackPath() {
  const decodedChunks = [];
  const seenFormats = [];
  const states = [];
  const formats = [];
  const drops = [];

  class FakeEncodedVideoChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeVideoDecoder {
    static async isConfigSupported(config) {
      seenFormats.push(config.avc && config.avc.format);
      return { supported: config.avc && config.avc.format === 'avc' };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
    }

    configure(config) {
      this.config = config;
      this.state = 'configured';
    }

    decode(chunk) {
      decodedChunks.push(chunk.init);
      this.init.output({
        displayWidth: 1280,
        displayHeight: 720,
        close: () => {}
      });
    }

    close() {
      this.state = 'closed';
    }
  }

  const fakeCanvas = {
    width: 1,
    height: 1,
    getContext: () => ({
      drawImage: () => {}
    })
  };

  const previousWindow = global.window;
  global.window = {
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk
  };

  try {
    const playerModule = loadTsModule('vds_web/src/webcodecs-player.ts');
    const player = new playerModule.WebCodecsVideoPlayer(fakeCanvas, {
      onState: (state) => states.push(state),
      onDecodedFrame: () => {},
      onDroppedFrame: (reason) => drops.push(reason),
      onPayloadFormat: (format) => formats.push(format)
    });
    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'video',
      codec: 'h264',
      payloadFormat: 'annexb',
      timestampUs: 9000,
      sequence: 1,
      keyframe: true,
      config: true
    }, makeFramePayload());

    assert.ok(seenFormats.includes('annexb'));
    assert.ok(seenFormats.includes('avc'));
    assert.ok(states.includes('webcodecs-configured-avc1.42E01F-avcc'));
    assert.ok(formats.includes('annexb:avcc'));
    const outputBytes = new Uint8Array(decodedChunks[0].data);
    const firstUnitLength = new DataView(outputBytes.buffer, outputBytes.byteOffset, outputBytes.byteLength).getUint32(0, false);
    assert.ok(firstUnitLength > 0);
    assert.notDeepStrictEqual(Array.from(outputBytes.slice(0, 4)), [0, 0, 0, 1]);
    assert.deepStrictEqual(drops, []);
  } finally {
    global.window = previousWindow;
  }
}

async function testWebCodecsHevcHvc1AvccFallbackPath() {
  const decodedChunks = [];
  const seenConfigs = [];
  const states = [];
  const formats = [];
  const drops = [];

  class FakeEncodedVideoChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeVideoDecoder {
    static async isConfigSupported(config) {
      seenConfigs.push(config);
      return { supported: /^hvc1\./.test(config.codec) && config.hevc && config.hevc.format === 'hevc' };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
    }

    configure(config) {
      this.config = config;
      this.state = 'configured';
    }

    decode(chunk) {
      decodedChunks.push(chunk.init);
      this.init.output({
        displayWidth: 1280,
        displayHeight: 720,
        close: () => {}
      });
    }

    close() {
      this.state = 'closed';
    }
  }

  const fakeCanvas = {
    width: 1,
    height: 1,
    getContext: () => ({
      drawImage: () => {}
    })
  };

  const previousWindow = global.window;
  global.window = {
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk
  };

  try {
    const playerModule = loadTsModule('vds_web/src/webcodecs-player.ts');
    const player = new playerModule.WebCodecsVideoPlayer(fakeCanvas, {
      onState: (state) => states.push(state),
      onDecodedFrame: () => {},
      onDroppedFrame: (reason) => drops.push(reason),
      onPayloadFormat: (format) => formats.push(format)
    });
    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'video',
      codec: 'h265',
      payloadFormat: 'annexb',
      timestampUs: 9000,
      sequence: 1,
      keyframe: true,
      config: true
    }, makeHevcFramePayload());

    assert.ok(seenConfigs.some((config) => /^hev1\./.test(config.codec) && config.hevc && config.hevc.format === 'annexb'));
    assert.ok(seenConfigs.some((config) => /^hvc1\./.test(config.codec) && config.hevc && config.hevc.format === 'hevc'));
    assert.ok(states.some((state) => /^webcodecs-configured-hvc1\..*-avcc$/.test(state)));
    assert.ok(formats.includes('annexb:avcc'));
    const outputBytes = new Uint8Array(decodedChunks[0].data);
    const firstUnitLength = new DataView(outputBytes.buffer, outputBytes.byteOffset, outputBytes.byteLength).getUint32(0, false);
    assert.ok(firstUnitLength > 0);
    assert.notDeepStrictEqual(Array.from(outputBytes.slice(0, 4)), [0, 0, 0, 1]);
    assert.deepStrictEqual(drops, []);
  } finally {
    global.window = previousWindow;
  }
}

async function testWebCodecsHevc2kLevelSelection() {
  const states = [];
  const drops = [];
  const supportedCodecs = [];

  class FakeEncodedVideoChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeVideoDecoder {
    static async isConfigSupported(config) {
      supportedCodecs.push(config.codec);
      assert.deepStrictEqual(config.hevc, { format: 'annexb' });
      if (config.codec === 'hev1.1.6.L150.B0') {
        assert.strictEqual(config.codedWidth, 2560);
        assert.strictEqual(config.codedHeight, 1440);
        assert.strictEqual(config.displayAspectWidth, 2560);
        assert.strictEqual(config.displayAspectHeight, 1440);
      }
      return { supported: config.codec === 'hev1.1.6.L150.B0' };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
    }

    configure(config) {
      this.config = config;
      this.state = 'configured';
    }

    decode() {
      this.init.output({
        displayWidth: 2560,
        displayHeight: 1440,
        codedWidth: 2560,
        codedHeight: 1440,
        visibleRect: { x: 0, y: 0, width: 2560, height: 1440 },
        close: () => {}
      });
    }

    close() {
      this.state = 'closed';
    }
  }

  const fakeCanvas = {
    width: 1,
    height: 1,
    getContext: () => ({
      drawImage: () => {}
    })
  };

  const previousWindow = global.window;
  global.window = {
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk
  };

  try {
    const playerModule = loadTsModule('vds_web/src/webcodecs-player.ts');
    const player = new playerModule.WebCodecsVideoPlayer(fakeCanvas, {
      onState: (state) => states.push(state),
      onDecodedFrame: () => {},
      onDroppedFrame: (reason) => drops.push(reason),
      onPayloadFormat: () => {}
    });
    player.setExpectedDisplaySize(2560, 1440);

    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'video',
      codec: 'h265',
      payloadFormat: 'annexb',
      timestampUs: 9000,
      sequence: 1,
      keyframe: true,
      config: true
    }, makeHevcFramePayload());

    assert.strictEqual(supportedCodecs[0], 'hev1.1.6.L150.B0');
    assert.ok(states.includes('webcodecs-configured-hev1.1.6.L150.B0-annexb'));
    assert.strictEqual(fakeCanvas.width, 2560);
    assert.strictEqual(fakeCanvas.height, 1440);
    assert.deepStrictEqual(drops, []);
  } finally {
    global.window = previousWindow;
  }
}

async function testWebCodecsHevc1080pCodedDimensionAlignment() {
  const seenConfigs = [];

  class FakeEncodedVideoChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeVideoDecoder {
    static async isConfigSupported(config) {
      seenConfigs.push(config);
      return { supported: config.codec === 'hev1.1.6.L123.B0' };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
    }

    configure(config) {
      this.config = config;
      this.state = 'configured';
    }

    decode() {
      this.init.output({
        displayWidth: 1920,
        displayHeight: 1080,
        codedWidth: 1920,
        codedHeight: 1088,
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        close: () => {}
      });
    }

    close() {
      this.state = 'closed';
    }
  }

  const fakeCanvas = {
    width: 1,
    height: 1,
    getContext: () => ({
      drawImage: () => {}
    })
  };

  const previousWindow = global.window;
  global.window = {
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk
  };

  try {
    const playerModule = loadTsModule('vds_web/src/webcodecs-player.ts');
    const player = new playerModule.WebCodecsVideoPlayer(fakeCanvas, {
      onState: () => {},
      onDecodedFrame: () => {},
      onDroppedFrame: () => {},
      onPayloadFormat: () => {}
    });
    player.setExpectedDisplaySize(1920, 1080);

    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'video',
      codec: 'h265',
      payloadFormat: 'annexb',
      timestampUs: 9000,
      sequence: 1,
      keyframe: true,
      config: true
    }, makeHevcFramePayload());

    assert.strictEqual(seenConfigs[0].codec, 'hev1.1.6.L123.B0');
    assert.strictEqual(seenConfigs[0].codedWidth, 1920);
    assert.strictEqual(seenConfigs[0].codedHeight, 1088);
    assert.strictEqual(seenConfigs[0].displayAspectWidth, 1920);
    assert.strictEqual(seenConfigs[0].displayAspectHeight, 1080);
  } finally {
    global.window = previousWindow;
  }
}

async function testWebCodecsHevcUsesDecodedSizeWhenStreamIsSmallerThanManifest() {
  const frameInfos = [];

  class FakeEncodedVideoChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeVideoDecoder {
    static async isConfigSupported(config) {
      return { supported: config.codec === 'hev1.1.6.L123.B0' };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
    }

    configure(config) {
      this.config = config;
      this.state = 'configured';
    }

    decode() {
      this.init.output({
        displayWidth: 1280,
        displayHeight: 720,
        codedWidth: 1280,
        codedHeight: 720,
        visibleRect: { x: 0, y: 0, width: 1280, height: 720 },
        close: () => {}
      });
    }

    close() {
      this.state = 'closed';
    }
  }

  const fakeCanvas = {
    width: 1,
    height: 1,
    getContext: () => ({
      drawImage: () => {}
    })
  };

  const previousWindow = global.window;
  global.window = {
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk
  };

  try {
    const playerModule = loadTsModule('vds_web/src/webcodecs-player.ts');
    const player = new playerModule.WebCodecsVideoPlayer(fakeCanvas, {
      onState: () => {},
      onDecodedFrame: () => {},
      onDroppedFrame: () => {},
      onPayloadFormat: () => {},
      onVideoFrameInfo: (info) => frameInfos.push(info)
    });
    player.setExpectedDisplaySize(1920, 1080);

    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'video',
      codec: 'h265',
      payloadFormat: 'annexb',
      timestampUs: 9000,
      sequence: 1,
      keyframe: true,
      config: true
    }, makeHevcFramePayload());

    assert.strictEqual(fakeCanvas.width, 1280);
    assert.strictEqual(fakeCanvas.height, 720);
    assert.strictEqual(frameInfos[0].sourceWidth, 1280);
    assert.strictEqual(frameInfos[0].sourceHeight, 720);
  } finally {
    global.window = previousWindow;
  }
}

async function testWebCodecsAudioDecodePath() {
  const decodedChunks = [];
  const states = [];
  const drops = [];
  const decodedBlocks = [];
  const starts = [];

  class FakeEncodedAudioChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeAudioDecoder {
    static async isConfigSupported(config) {
      assert.strictEqual(config.codec, 'opus');
      assert.strictEqual(config.sampleRate, 48000);
      assert.strictEqual(config.numberOfChannels, 2);
      return { supported: true };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
    }

    configure(config) {
      this.config = config;
      this.state = 'configured';
    }

    decode(chunk) {
      decodedChunks.push(chunk.init);
      this.init.output({
        sampleRate: 48000,
        numberOfChannels: 2,
        numberOfFrames: 2,
        copyTo: (target) => {
          target[0] = 0;
          target[1] = 0;
        },
        close: () => decodedBlocks.push('closed')
      });
    }

    close() {
      this.state = 'closed';
    }
  }

  class FakeAudioContext {
    constructor(init) {
      this.sampleRate = init.sampleRate;
      this.destination = {};
      this.state = 'running';
      this.currentTime = 10;
    }

    createBuffer(channels, frames, sampleRate) {
      assert.strictEqual(channels, 2);
      assert.strictEqual(frames, 2);
      assert.strictEqual(sampleRate, 48000);
      return {
        duration: frames / sampleRate,
        getChannelData: () => new Float32Array(frames)
      };
    }

    createBufferSource() {
      return {
        connect: () => {},
        start: (when) => {
          starts.push(when);
          decodedBlocks.push('started');
        }
      };
    }

    createGain() {
      return {
        gain: { value: 1 },
        connect: () => {}
      };
    }
  }

  const previousWindow = global.window;
  const previousAudioContext = global.AudioContext;
  global.window = {
    AudioDecoder: FakeAudioDecoder,
    EncodedAudioChunk: FakeEncodedAudioChunk,
    webkitAudioContext: FakeAudioContext
  };

  try {
    const audioModule = loadTsModule('vds_web/src/webcodecs-audio-player.ts');
    const player = new audioModule.WebCodecsAudioPlayer({
      onState: (state) => states.push(state),
      onDecodedBlock: () => decodedBlocks.push('decoded'),
      onDroppedBlock: (reason) => drops.push(reason)
    });
    player.setDelayMs(120);
    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'audio',
      codec: 'opus',
      payloadFormat: 'raw',
      timestampUs: 20000,
      sequence: 1,
      keyframe: true,
      config: false
    }, new Uint8Array([1, 2, 3, 4]).buffer);
    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'audio',
      codec: 'opus',
      payloadFormat: 'raw',
      timestampUs: 40000,
      sequence: 2,
      keyframe: true,
      config: false
    }, new Uint8Array([1, 2, 3, 4]).buffer);

    assert.strictEqual(decodedChunks.length, 2);
    assert.strictEqual(decodedChunks[0].timestamp, 20000);
    assert.ok(states.includes('webcodecs-audio-configured-opus'));
    assert.ok(decodedBlocks.includes('decoded'));
    assert.strictEqual(starts[0], 10.12);
    assert.strictEqual(starts[1], 10.12 + (2 / 48000));
    assert.deepStrictEqual(drops, []);
  } finally {
    global.window = previousWindow;
    global.AudioContext = previousAudioContext;
  }
}

async function testWebCodecsAacAdtsDecodePath() {
  const decodedChunks = [];
  const states = [];
  const drops = [];
  const decodedBlocks = [];

  class FakeEncodedAudioChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeAudioDecoder {
    static async isConfigSupported(config) {
      assert.strictEqual(config.codec, 'mp4a.40.2');
      assert.strictEqual(config.sampleRate, 44100);
      assert.strictEqual(config.numberOfChannels, 2);
      assert.deepStrictEqual(Array.from(new Uint8Array(config.description)), [0x12, 0x10]);
      return { supported: true };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
    }

    configure(config) {
      assert.deepStrictEqual(Array.from(new Uint8Array(config.description)), [0x12, 0x10]);
      this.config = config;
      this.state = 'configured';
    }

    decode(chunk) {
      decodedChunks.push(chunk.init);
      this.init.output({
        sampleRate: 44100,
        numberOfChannels: 2,
        numberOfFrames: 2,
        copyTo: (target) => {
          target[0] = 0;
          target[1] = 0;
        },
        close: () => decodedBlocks.push('closed')
      });
    }

    close() {
      this.state = 'closed';
    }
  }

  class FakeAudioContext {
    constructor(init) {
      this.sampleRate = init.sampleRate;
      this.destination = {};
      this.state = 'running';
      this.currentTime = 1;
    }

    createBuffer(channels, frames, sampleRate) {
      assert.strictEqual(channels, 2);
      assert.strictEqual(frames, 2);
      assert.strictEqual(sampleRate, 44100);
      return {
        duration: frames / sampleRate,
        getChannelData: () => new Float32Array(frames)
      };
    }

    createBufferSource() {
      return { connect: () => {}, start: () => decodedBlocks.push('started') };
    }

    createGain() {
      return { gain: { value: 1 }, connect: () => {} };
    }
  }

  const previousWindow = global.window;
  const previousAudioContext = global.AudioContext;
  global.window = {
    AudioDecoder: FakeAudioDecoder,
    EncodedAudioChunk: FakeEncodedAudioChunk,
    AudioContext: FakeAudioContext
  };

  try {
    const audioModule = loadTsModule('vds_web/src/webcodecs-audio-player.ts');
    const player = new audioModule.WebCodecsAudioPlayer({
      onState: (state) => states.push(state),
      onDecodedBlock: () => decodedBlocks.push('decoded'),
      onDroppedBlock: (reason) => drops.push(reason)
    });
    player.setFormat(44100, 2);
    const adtsPayload = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc, 0x11, 0x22, 0x33]).buffer;
    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'audio',
      codec: 'aac',
      payloadFormat: 'aac-adts',
      timestampUs: 12345,
      sequence: 1,
      keyframe: true,
      config: false
    }, adtsPayload);

    assert.strictEqual(decodedChunks.length, 1);
    assert.strictEqual(decodedChunks[0].timestamp, 12345);
    assert.deepStrictEqual(Array.from(new Uint8Array(decodedChunks[0].data)), [0x11, 0x22, 0x33]);
    assert.ok(states.includes('webcodecs-audio-configured-mp4a.40.2'));
    assert.ok(decodedBlocks.includes('decoded'));
    assert.deepStrictEqual(drops, []);
  } finally {
    global.window = previousWindow;
    global.AudioContext = previousAudioContext;
  }
}

async function testWebCodecsAacDescriptionChangeReconfiguresDecoder() {
  const configDescriptions = [];
  const drops = [];

  class FakeEncodedAudioChunk {
    constructor(init) {
      this.init = init;
    }
  }

  class FakeAudioDecoder {
    static async isConfigSupported(config) {
      configDescriptions.push(Array.from(new Uint8Array(config.description)).join(','));
      return { supported: true };
    }

    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
    }

    configure(config) {
      this.config = config;
      this.state = 'configured';
    }

    decode() {
      this.init.output({
        sampleRate: 44100,
        numberOfChannels: 2,
        numberOfFrames: 1,
        copyTo: () => {},
        close: () => {}
      });
    }

    close() {
      this.state = 'closed';
    }
  }

  class FakeAudioContext {
    constructor() {
      this.destination = {};
      this.state = 'running';
      this.currentTime = 1;
    }

    createBuffer() {
      return { duration: 0, getChannelData: () => new Float32Array(1) };
    }

    createBufferSource() {
      return { connect: () => {}, start: () => {} };
    }

    createGain() {
      return { gain: { value: 1 }, connect: () => {} };
    }
  }

  const previousWindow = global.window;
  global.window = {
    AudioDecoder: FakeAudioDecoder,
    EncodedAudioChunk: FakeEncodedAudioChunk,
    AudioContext: FakeAudioContext
  };

  try {
    const audioModule = loadTsModule('vds_web/src/webcodecs-audio-player.ts');
    const player = new audioModule.WebCodecsAudioPlayer({
      onState: () => {},
      onDecodedBlock: () => {},
      onDroppedBlock: (reason) => drops.push(reason)
    });
    player.setFormat(44100, 2);
    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'audio',
      codec: 'aac',
      payloadFormat: 'aac-adts',
      timestampUs: 1,
      sequence: 1,
      keyframe: true,
      config: false
    }, new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc, 0x11]).buffer);
    await player.pushFrame({
      protocol: 'vds-media-encoded-v1',
      type: 'frame',
      streamType: 'audio',
      codec: 'aac',
      payloadFormat: 'aac-adts',
      timestampUs: 2,
      sequence: 2,
      keyframe: true,
      config: false
    }, new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0x02, 0x1f, 0xfc, 0x22]).buffer);

    assert.deepStrictEqual(configDescriptions, ['18,16', '17,144']);
    assert.deepStrictEqual(drops, []);
  } finally {
    global.window = previousWindow;
  }
}

async function main() {
  await testMobileCapabilityPolicies();
  await testAacCapabilityProbeUsesAudioSpecificConfig();
  testEncodedMediaCapabilitiesRequireDetectedCodecTargets();
  testWebJoinPayloadIncludesMobileRelayCapabilities();
  testMobileViewportAndSafeAreaStylesArePresent();
  testRelayKeepsLocalPlaybackWhileForwarding();
  testDiagnosticsReportIncludesMobileEnvironmentSummary();
  testNativeOfferChecksWebCodecCompatibilityBeforeSignaling();
  testNativeTransportEnforcesAdvertisedEncodedFrameLimit();
  testDataChannelFrameEnvelope();
  testDataChannelFrameRejection();
  testDataChannelRejectsInvalidChunkSize();
  testDataChannelRejectsOversizedChunkPayload();
  testDataChannelIgnoresDuplicateChunk();
  testDataChannelReassemblerClearDropsPendingChunks();
  testDataChannelFrameChunking();
  await testWebCodecsPlayerDecodePath();
  await testWebCodecsVideoAvccFallbackPath();
  await testWebCodecsHevcHvc1AvccFallbackPath();
  await testWebCodecsHevc2kLevelSelection();
  await testWebCodecsHevc1080pCodedDimensionAlignment();
  await testWebCodecsHevcUsesDecodedSizeWhenStreamIsSmallerThanManifest();
  await testWebCodecsAudioDecodePath();
  await testWebCodecsAacAdtsDecodePath();
  await testWebCodecsAacDescriptionChangeReconfiguresDecoder();
  console.log('vds-web protocol tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
