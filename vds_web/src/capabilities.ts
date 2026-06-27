export type CapabilityReport = {
  browser: string;
  userAgent: string;
  secureContext: boolean;
  lanHttpAllowed: boolean;
  chromeOrEdge: boolean;
  browserFamily: 'chromium' | 'safari' | 'firefox' | 'other';
  platform: 'ios' | 'android' | 'desktop' | 'unknown';
  mobile: boolean;
  iosSafari: boolean;
  iosWebKit: boolean;
  androidChromium: boolean;
  androidChrome: boolean;
  relayCapable: boolean;
  maxDirectDownstreams: number;
  relayEligibilityReason: string;
  webRtc: boolean;
  webCodecsVideoDecoder: boolean;
  webCodecsAudioDecoder: boolean;
  audioOutput: boolean;
  supportedVideoCodecs: string[];
  supportedAudioCodecs: string[];
  videoCodecProbeResults: CodecProbeResult[];
  audioCodecProbeResults: CodecProbeResult[];
  ok: boolean;
  reasons: string[];
};

export type CodecProbeResult = {
  codec: string;
  target: string;
  supported: boolean;
  source: 'webcodecs' | 'media-capabilities';
};

type VideoDecoderSupport = {
  isConfigSupported?: (config: VideoDecoderConfig) => Promise<{ supported: boolean; config?: unknown }>;
};

type AudioDecoderSupport = {
  isConfigSupported?: (config: AudioDecoderConfig) => Promise<{ supported: boolean; config?: unknown }>;
};

type CapabilityWindow = Window & {
  VideoDecoder?: VideoDecoderSupport;
  AudioDecoder?: AudioDecoderSupport;
  EncodedVideoChunk?: unknown;
  EncodedAudioChunk?: unknown;
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
};

type MediaCapabilitiesSupport = {
  decodingInfo?: (configuration: unknown) => Promise<{ supported?: boolean }>;
};

type BaseCapabilities = Omit<CapabilityReport, 'supportedVideoCodecs' | 'supportedAudioCodecs' | 'videoCodecProbeResults' | 'audioCodecProbeResults' | 'relayCapable' | 'maxDirectDownstreams' | 'relayEligibilityReason' | 'ok'>;

export function detectCapabilities(): CapabilityReport {
  const base = detectBaseCapabilities();
  const supportedVideoCodecs: string[] = [];
  const supportedAudioCodecs: string[] = [];
  const videoCodecProbeResults: CodecProbeResult[] = [];
  const audioCodecProbeResults: CodecProbeResult[] = [];
  return {
    ...base,
    supportedVideoCodecs,
    supportedAudioCodecs,
    videoCodecProbeResults,
    audioCodecProbeResults,
    ...buildRelayPolicy(base, supportedVideoCodecs, supportedAudioCodecs),
    ok: base.reasons.length === 0,
    reasons: base.reasons
  };
}

export async function detectCapabilitiesAsync(): Promise<CapabilityReport> {
  const base = detectBaseCapabilities();
  const videoProbe = base.webCodecsVideoDecoder ? await detectVideoCodecs() : { supportedCodecs: [], probeResults: [] };
  const audioProbe = base.webCodecsAudioDecoder ? await detectAudioCodecs() : { supportedCodecs: [], probeResults: [] };
  const supportedVideoCodecs = videoProbe.supportedCodecs;
  const supportedAudioCodecs = audioProbe.supportedCodecs;
  const reasons = [...base.reasons];

  if (base.webCodecsVideoDecoder && supportedVideoCodecs.length === 0) {
    reasons.push('浏览器缺少可用的视频解码格式。');
  }
  if (base.webCodecsAudioDecoder && supportedAudioCodecs.length === 0) {
    reasons.push('浏览器缺少可用的音频解码格式。');
  }

  return {
    ...base,
    supportedVideoCodecs,
    supportedAudioCodecs,
    videoCodecProbeResults: videoProbe.probeResults,
    audioCodecProbeResults: audioProbe.probeResults,
    ...buildRelayPolicy(base, supportedVideoCodecs, supportedAudioCodecs),
    ok: reasons.length === 0,
    reasons
  };
}

function detectBaseCapabilities(): BaseCapabilities {
  const userAgent = navigator.userAgent || '';
  const platform = detectPlatform(userAgent);
  const browserFamily = detectBrowserFamily(userAgent);
  const chromeOrEdge = browserFamily === 'chromium' && /\b(Chrome|Edg|EdgA)\//.test(userAgent) && !/\b(Firefox|OPR)\//.test(userAgent);
  const iosWebKit = platform === 'ios';
  const iosSafari = iosWebKit && browserFamily === 'safari';
  const androidChromium = platform === 'android' && browserFamily === 'chromium';
  const androidChrome = androidChromium && isAndroidChromeUserAgent(userAgent);
  const mobile = platform === 'ios' || platform === 'android';
  const lanHttpAllowed = location.protocol === 'http:' && isPrivateLanHostname(location.hostname);
  const secureContext = window.isSecureContext || ['localhost', '127.0.0.1', '::1'].includes(location.hostname) || lanHttpAllowed;
  const webRtc = typeof RTCPeerConnection !== 'undefined';
  const capabilityWindow = window as CapabilityWindow;
  const webCodecsVideoDecoder = typeof capabilityWindow.VideoDecoder !== 'undefined' && typeof capabilityWindow.EncodedVideoChunk !== 'undefined';
  const webCodecsAudioDecoder = typeof capabilityWindow.AudioDecoder !== 'undefined' && typeof capabilityWindow.EncodedAudioChunk !== 'undefined';
  const audioOutput = typeof capabilityWindow.AudioContext !== 'undefined' || typeof capabilityWindow.webkitAudioContext !== 'undefined';
  const reasons: string[] = [];

  if (!isSupportedBrowserTarget({ platform, browserFamily, iosSafari, androidChromium, chromeOrEdge })) {
    reasons.push('当前浏览器不在支持范围内。请使用 iOS Safari，或支持 WebRTC/WebCodecs/Web Audio 的安卓浏览器；向后 relay 仅承诺 Android Chrome。');
  }
  if (!secureContext) {
    reasons.push('需要 HTTPS、localhost，或局域网 HTTP 地址。');
  }
  if (!webRtc) {
    reasons.push('浏览器缺少 WebRTC 支持。');
  }
  if (!webCodecsVideoDecoder) {
    reasons.push('浏览器缺少 WebCodecs 视频播放能力。');
  }
  if (!webCodecsAudioDecoder) {
    reasons.push('浏览器缺少 WebCodecs 音频播放能力。');
  }
  if (!audioOutput) {
    reasons.push('浏览器缺少 Web Audio 输出能力。');
  }

  return {
    browser: browserName(userAgent),
    userAgent,
    secureContext,
    lanHttpAllowed,
    chromeOrEdge,
    browserFamily,
    platform,
    mobile,
    iosSafari,
    iosWebKit,
    androidChromium,
    androidChrome,
    webRtc,
    webCodecsVideoDecoder,
    webCodecsAudioDecoder,
    audioOutput,
    reasons
  };
}

async function detectVideoCodecs(): Promise<{ supportedCodecs: string[]; probeResults: CodecProbeResult[] }> {
  const decoder = (window as CapabilityWindow).VideoDecoder;
  if (!decoder?.isConfigSupported) {
    return detectVideoCodecsWithMediaCapabilities();
  }

  const candidates: Array<[string, VideoDecoderConfig[]]> = [
    ['h264', [
      { codec: 'avc1.42E01F', codedWidth: 1280, codedHeight: 720 },
      { codec: 'avc1.4D401F', codedWidth: 1280, codedHeight: 720 },
      { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 }
    ]],
    ['h265', [
      { codec: 'hev1.1.6.L93.B0', codedWidth: 1280, codedHeight: 720 },
      { codec: 'hvc1.1.6.L93.B0', codedWidth: 1280, codedHeight: 720 },
      { codec: 'hev1.1.6.L120.B0', codedWidth: 1280, codedHeight: 720 },
      { codec: 'hvc1.1.6.L120.B0', codedWidth: 1280, codedHeight: 720 },
      { codec: 'hev1.1.6.L123.B0', codedWidth: 1920, codedHeight: 1080 },
      { codec: 'hvc1.1.6.L123.B0', codedWidth: 1920, codedHeight: 1080 },
      { codec: 'hev1.1.6.L150.B0', codedWidth: 1920, codedHeight: 1080 },
      { codec: 'hvc1.1.6.L150.B0', codedWidth: 1920, codedHeight: 1080 }
    ]]
  ];
  const supported: string[] = [];
  const probeResults: CodecProbeResult[] = [];
  for (const [name, configs] of candidates) {
    for (const config of configs) {
      const result = await decoder.isConfigSupported(config).catch(() => ({ supported: false }));
      probeResults.push({ codec: config.codec, target: name, supported: result.supported === true, source: 'webcodecs' });
      if (result.supported) {
        supported.push(name);
        break;
      }
    }
  }
  return { supportedCodecs: supported, probeResults };
}

async function detectAudioCodecs(): Promise<{ supportedCodecs: string[]; probeResults: CodecProbeResult[] }> {
  const decoder = (window as CapabilityWindow).AudioDecoder;
  if (!decoder?.isConfigSupported) {
    return detectAudioCodecsWithMediaCapabilities();
  }

  const candidates: Array<[string, AudioDecoderConfig]> = [
    ['opus', { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }],
    ['aac', { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: buildAacLcAudioSpecificConfig() }]
  ];
  const supported: string[] = [];
  const probeResults: CodecProbeResult[] = [];
  for (const [name, config] of candidates) {
    const result = await decoder.isConfigSupported(config).catch(() => ({ supported: false }));
    probeResults.push({ codec: config.codec, target: name, supported: result.supported === true, source: 'webcodecs' });
    if (result.supported) {
      supported.push(name);
    }
  }
  return { supportedCodecs: supported, probeResults };
}

function buildAacLcAudioSpecificConfig(): Uint8Array {
  // AAC LC, 48 kHz, stereo. Some WebCodecs implementations reject AAC config probing without AudioSpecificConfig.
  return new Uint8Array([0x11, 0x90]);
}

async function detectVideoCodecsWithMediaCapabilities(): Promise<{ supportedCodecs: string[]; probeResults: CodecProbeResult[] }> {
  const candidates: Array<[string, string[]]> = [
    ['h264', [
      'video/mp4; codecs="avc1.42E01F"',
      'video/mp4; codecs="avc1.4D401F"',
      'video/mp4; codecs="avc1.640028"'
    ]],
    ['h265', [
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
      'video/mp4; codecs="hev1.1.6.L93.B0"',
      'video/mp4; codecs="hvc1.1.6.L120.B0"',
      'video/mp4; codecs="hev1.1.6.L120.B0"',
      'video/mp4; codecs="hvc1.1.6.L123.B0"',
      'video/mp4; codecs="hev1.1.6.L123.B0"',
      'video/mp4; codecs="hvc1.1.6.L150.B0"',
      'video/mp4; codecs="hev1.1.6.L150.B0"'
    ]]
  ];
  const supported: string[] = [];
  const probeResults: CodecProbeResult[] = [];
  for (const [name, contentTypes] of candidates) {
    for (const contentType of contentTypes) {
      const result = await queryMediaCapabilities({
        type: 'file',
        video: {
          contentType,
          width: 1280,
          height: 720,
          bitrate: 2500000,
          framerate: 30
        }
      });
      probeResults.push({ codec: contentType, target: name, supported: result, source: 'media-capabilities' });
      if (result) {
        supported.push(name);
        break;
      }
    }
  }
  return { supportedCodecs: supported, probeResults };
}

async function detectAudioCodecsWithMediaCapabilities(): Promise<{ supportedCodecs: string[]; probeResults: CodecProbeResult[] }> {
  const candidates: Array<[string, string[]]> = [
    ['opus', ['audio/webm; codecs="opus"', 'audio/ogg; codecs="opus"']],
    ['aac', ['audio/mp4; codecs="mp4a.40.2"']]
  ];
  const supported: string[] = [];
  const probeResults: CodecProbeResult[] = [];
  for (const [name, contentTypes] of candidates) {
    for (const contentType of contentTypes) {
      const result = await queryMediaCapabilities({
        type: 'file',
        audio: {
          contentType,
          channels: 2,
          bitrate: 128000,
          samplerate: 48000
        }
      });
      probeResults.push({ codec: contentType, target: name, supported: result, source: 'media-capabilities' });
      if (result) {
        supported.push(name);
        break;
      }
    }
  }
  return { supportedCodecs: supported, probeResults };
}

async function queryMediaCapabilities(configuration: unknown): Promise<boolean> {
  const capabilities = (navigator as Navigator & { mediaCapabilities?: MediaCapabilitiesSupport }).mediaCapabilities;
  if (!capabilities?.decodingInfo) {
    return false;
  }
  const result = await capabilities.decodingInfo(configuration).catch(() => ({ supported: false }));
  return result.supported === true;
}

function buildRelayPolicy(
  base: Pick<CapabilityReport, 'androidChrome' | 'platform' | 'chromeOrEdge' | 'webRtc' | 'webCodecsVideoDecoder' | 'webCodecsAudioDecoder' | 'audioOutput'>,
  supportedVideoCodecs: string[],
  supportedAudioCodecs: string[]
): Pick<CapabilityReport, 'relayCapable' | 'maxDirectDownstreams' | 'relayEligibilityReason'> {
  const targetReason = getRelayTargetRejectionReason(base);
  if (targetReason) {
    return { relayCapable: false, maxDirectDownstreams: 0, relayEligibilityReason: targetReason };
  }
  const missingMediaReason = getMissingMediaCapabilityReason(base, supportedVideoCodecs, supportedAudioCodecs);
  if (missingMediaReason) {
    return { relayCapable: false, maxDirectDownstreams: 0, relayEligibilityReason: missingMediaReason };
  }
  const hasAndroidChromeRelayMatrix = supportedVideoCodecs.includes('h264') &&
    supportedVideoCodecs.includes('h265') &&
    supportedAudioCodecs.includes('opus') &&
    supportedAudioCodecs.includes('aac');
  if (base.androidChrome && !hasAndroidChromeRelayMatrix) {
    return { relayCapable: false, maxDirectDownstreams: 0, relayEligibilityReason: 'missing-android-relay-codec-matrix' };
  }
  return {
    relayCapable: true,
    maxDirectDownstreams: 1,
    relayEligibilityReason: 'relay-ready'
  };
}

function getRelayTargetRejectionReason(
  base: Pick<CapabilityReport, 'androidChrome' | 'platform' | 'chromeOrEdge'>
): string {
  if (base.platform === 'ios') {
    return 'ios-leaf';
  }
  if (base.platform === 'android' && base.androidChrome !== true) {
    return 'android-non-chrome-leaf';
  }
  if (base.platform === 'desktop' && base.chromeOrEdge !== true) {
    return 'desktop-non-chrome-leaf';
  }
  if (base.platform !== 'android' && base.platform !== 'desktop') {
    return 'platform-leaf';
  }
  return '';
}

function getMissingMediaCapabilityReason(
  base: Pick<CapabilityReport, 'webRtc' | 'webCodecsVideoDecoder' | 'webCodecsAudioDecoder' | 'audioOutput'>,
  supportedVideoCodecs: string[],
  supportedAudioCodecs: string[]
): string {
  if (!base.webRtc) {
    return 'missing-webrtc';
  }
  if (!base.webCodecsVideoDecoder) {
    return 'missing-video-decoder';
  }
  if (!base.webCodecsAudioDecoder) {
    return 'missing-audio-decoder';
  }
  if (!base.audioOutput) {
    return 'missing-audio-output';
  }
  if (supportedVideoCodecs.length === 0) {
    return 'missing-video-codec';
  }
  if (supportedAudioCodecs.length === 0) {
    return 'missing-audio-codec';
  }
  return '';
}

function isSupportedBrowserTarget(target: {
  platform: CapabilityReport['platform'];
  browserFamily: CapabilityReport['browserFamily'];
  iosSafari: boolean;
  androidChromium: boolean;
  chromeOrEdge: boolean;
}): boolean {
  if (target.iosSafari || target.androidChromium) {
    return true;
  }
  if (target.platform === 'desktop' && target.chromeOrEdge) {
    return true;
  }
  return target.platform === 'android' && target.browserFamily !== 'other';
}

function isAndroidChromeUserAgent(userAgent: string): boolean {
  if (!/\bChrome\//i.test(userAgent)) {
    return false;
  }
  return !/\b(Edg|EdgA|OPR|SamsungBrowser|HuaweiBrowser|MiuiBrowser|HeyTapBrowser|VivoBrowser|Quark)\/|;\s*wv\b|\bVersion\/4\.0\b/i.test(userAgent);
}

function isPrivateLanHostname(hostname: string): boolean {
  const value = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost') {
    return true;
  }
  if (value.endsWith('.local')) {
    return true;
  }
  const parts = value.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts;
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254);
}

function detectPlatform(userAgent: string): CapabilityReport['platform'] {
  if (/\b(iPhone|iPad|iPod)\b/i.test(userAgent) || (/\bMacintosh\b/i.test(userAgent) && /\bMobile\/\w+\b/i.test(userAgent))) {
    return 'ios';
  }
  if (/\bAndroid\b/i.test(userAgent)) {
    return 'android';
  }
  if (userAgent) {
    return 'desktop';
  }
  return 'unknown';
}

function detectBrowserFamily(userAgent: string): CapabilityReport['browserFamily'] {
  if (/\b(Firefox|FxiOS)\//i.test(userAgent)) {
    return 'firefox';
  }
  if (/\b(Chrome|CriOS|Edg|EdgA|EdgiOS|SamsungBrowser|OPR)\//i.test(userAgent)) {
    return 'chromium';
  }
  if (/\bSafari\//i.test(userAgent) && !/\b(Chrome|CriOS|Edg|EdgA|EdgiOS|FxiOS|OPR|SamsungBrowser)\//i.test(userAgent)) {
    return 'safari';
  }
  return 'other';
}

function browserName(userAgent: string): string {
  const opera = /\bOPR\/([\d.]+)/.exec(userAgent);
  if (opera) {
    return `Opera ${opera[1]}`;
  }
  const samsung = /\bSamsungBrowser\/([\d.]+)/.exec(userAgent);
  if (samsung) {
    return `Samsung Internet ${samsung[1]}`;
  }
  const huawei = /\bHuaweiBrowser\/([\d.]+)/.exec(userAgent);
  if (huawei) {
    return `Huawei Browser ${huawei[1]}`;
  }
  const miui = /\bMiuiBrowser\/([\d.]+)/.exec(userAgent);
  if (miui) {
    return `MIUI Browser ${miui[1]}`;
  }
  const heyTap = /\bHeyTapBrowser\/([\d.]+)/.exec(userAgent);
  if (heyTap) {
    return `HeyTap Browser ${heyTap[1]}`;
  }
  const vivo = /\bVivoBrowser\/([\d.]+)/.exec(userAgent);
  if (vivo) {
    return `Vivo Browser ${vivo[1]}`;
  }
  const quark = /\bQuark\/([\d.]+)/.exec(userAgent);
  if (quark) {
    return `Quark ${quark[1]}`;
  }
  const crios = /\bCriOS\/([\d.]+)/.exec(userAgent);
  if (crios) {
    return `Chrome iOS ${crios[1]}`;
  }
  const edgios = /\bEdgiOS\/([\d.]+)/.exec(userAgent);
  if (edgios) {
    return `Edge iOS ${edgios[1]}`;
  }
  const edgeAndroid = /\bEdgA\/([\d.]+)/.exec(userAgent);
  if (edgeAndroid) {
    return `Edge Android ${edgeAndroid[1]}`;
  }
  const edge = /\bEdg\/([\d.]+)/.exec(userAgent);
  if (edge) {
    return `Edge ${edge[1]}`;
  }
  const webViewChrome = /\bChrome\/([\d.]+)/.exec(userAgent);
  if (webViewChrome && (/;\s*wv\b/i.test(userAgent) || /\bVersion\/4\.0\b/i.test(userAgent))) {
    return `Android WebView ${webViewChrome[1]}`;
  }
  const chrome = /\bChrome\/([\d.]+)/.exec(userAgent);
  if (chrome) {
    return `Chrome ${chrome[1]}`;
  }
  const firefox = /\bFirefox\/([\d.]+)/.exec(userAgent);
  if (firefox) {
    return `Firefox ${firefox[1]}`;
  }
  const safari = /\bVersion\/([\d.]+).*\bSafari\//.exec(userAgent);
  if (safari) {
    return `Safari ${safari[1]}`;
  }
  return 'Unknown';
}
