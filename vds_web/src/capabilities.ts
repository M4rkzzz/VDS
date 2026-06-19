export type CapabilityReport = {
  browser: string;
  userAgent: string;
  secureContext: boolean;
  chromeOrEdge: boolean;
  webRtc: boolean;
  webCodecsVideoDecoder: boolean;
  webCodecsAudioDecoder: boolean;
  supportedVideoCodecs: string[];
  supportedAudioCodecs: string[];
  ok: boolean;
  reasons: string[];
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
};

export function detectCapabilities(): CapabilityReport {
  const base = detectBaseCapabilities();
  return {
    ...base,
    supportedVideoCodecs: base.webCodecsVideoDecoder ? ['h264'] : [],
    supportedAudioCodecs: base.webCodecsAudioDecoder ? ['opus'] : [],
    ok: base.reasons.length === 0,
    reasons: base.reasons
  };
}

export async function detectCapabilitiesAsync(): Promise<CapabilityReport> {
  const base = detectBaseCapabilities();
  const supportedVideoCodecs = base.webCodecsVideoDecoder ? await detectVideoCodecs() : [];
  const supportedAudioCodecs = base.webCodecsAudioDecoder ? await detectAudioCodecs() : [];
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
    ok: reasons.length === 0,
    reasons
  };
}

function detectBaseCapabilities(): Omit<CapabilityReport, 'supportedVideoCodecs' | 'supportedAudioCodecs' | 'ok'> {
  const userAgent = navigator.userAgent || '';
  const chromeOrEdge = /\b(Chrome|Edg)\//.test(userAgent) && !/\b(Firefox|OPR)\//.test(userAgent);
  const secureContext = window.isSecureContext || ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  const webRtc = typeof RTCPeerConnection !== 'undefined';
  const capabilityWindow = window as CapabilityWindow;
  const webCodecsVideoDecoder = typeof capabilityWindow.VideoDecoder !== 'undefined' && typeof capabilityWindow.EncodedVideoChunk !== 'undefined';
  const webCodecsAudioDecoder = typeof capabilityWindow.AudioDecoder !== 'undefined' && typeof capabilityWindow.EncodedAudioChunk !== 'undefined';
  const reasons: string[] = [];

  if (!chromeOrEdge) {
    reasons.push('仅支持 Chrome / Edge。');
  }
  if (!secureContext) {
    reasons.push('需要 HTTPS 或 localhost。');
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

  return {
    browser: browserName(userAgent),
    userAgent,
    secureContext,
    chromeOrEdge,
    webRtc,
    webCodecsVideoDecoder,
    webCodecsAudioDecoder,
    reasons
  };
}

async function detectVideoCodecs(): Promise<string[]> {
  const decoder = (window as CapabilityWindow).VideoDecoder;
  if (!decoder?.isConfigSupported) {
    return ['h264'];
  }

  const candidates: Array<[string, VideoDecoderConfig]> = [
    ['h264', { codec: 'avc1.42E01F', codedWidth: 1280, codedHeight: 720 }],
    ['h265', { codec: 'hev1.1.6.L120.B0', codedWidth: 1280, codedHeight: 720 }]
  ];
  const supported: string[] = [];
  for (const [name, config] of candidates) {
    const result = await decoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (result.supported) {
      supported.push(name);
    }
  }
  return supported;
}

async function detectAudioCodecs(): Promise<string[]> {
  const decoder = (window as CapabilityWindow).AudioDecoder;
  if (!decoder?.isConfigSupported) {
    return ['opus'];
  }

  const candidates: Array<[string, AudioDecoderConfig]> = [
    ['opus', { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }],
    ['aac', { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 }]
  ];
  const supported: string[] = [];
  for (const [name, config] of candidates) {
    const result = await decoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (result.supported) {
      supported.push(name);
    }
  }
  return supported;
}

function browserName(userAgent: string): string {
  const edge = /\bEdg\/([\d.]+)/.exec(userAgent);
  if (edge) {
    return `Edge ${edge[1]}`;
  }
  const chrome = /\bChrome\/([\d.]+)/.exec(userAgent);
  if (chrome) {
    return `Chrome ${chrome[1]}`;
  }
  const firefox = /\bFirefox\/([\d.]+)/.exec(userAgent);
  if (firefox) {
    return `Firefox ${firefox[1]}`;
  }
  return 'Unknown';
}
