export type CapabilityReport = {
  browser: string;
  userAgent: string;
  secureContext: boolean;
  chromeOrEdge: boolean;
  webRtc: boolean;
  webCodecsVideoDecoder: boolean;
  webCodecsAudioDecoder: boolean;
  ok: boolean;
  reasons: string[];
};

export function detectCapabilities(): CapabilityReport {
  const userAgent = navigator.userAgent || '';
  const chromeOrEdge = /\b(Chrome|Edg)\//.test(userAgent) && !/\b(Firefox|OPR)\//.test(userAgent);
  const secureContext = window.isSecureContext || ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  const webRtc = typeof RTCPeerConnection !== 'undefined';
  const webCodecsVideoDecoder = typeof window.VideoDecoder !== 'undefined' && typeof window.EncodedVideoChunk !== 'undefined';
  const webCodecsAudioDecoder = typeof window.AudioDecoder !== 'undefined' && typeof window.EncodedAudioChunk !== 'undefined';
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
    ok: reasons.length === 0,
    reasons
  };
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
