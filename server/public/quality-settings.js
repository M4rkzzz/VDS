(function () {
  const VDS = window.VDS = window.VDS || {};

  const OBS_INGEST_PREFS_STORAGE_KEY = 'vds-obs-ingest-prefs';

  var DEFAULT_OBS_INGEST_PORT = 61080;
  var OBS_INGEST_PORT_MIN = 1024;
  var OBS_INGEST_PORT_MAX = 65535;

  var QUALITY_BITRATE_MIN = 1000;
  var QUALITY_BITRATE_MAX = 80000;
  var QUALITY_BITRATE_STEP = 1000;
  var QUALITY_CODEC_OPTIONS = [
    { value: 'h264', label: 'H.264' },
    { value: 'h265', label: 'H.265' }
  ];
  var QUALITY_RESOLUTION_OPTIONS = [
    { value: '360p', label: '360p', width: 640, height: 360 },
    { value: '480p', label: '480p', width: 854, height: 480 },
    { value: '720p', label: '720p', width: 1280, height: 720 },
    { value: '1080p', label: '1080p', width: 1920, height: 1080 },
    { value: '2k', label: '2k', width: 2560, height: 1440 },
    { value: '4k', label: '4k', width: 3840, height: 2160 }
  ];
  var QUALITY_FPS_OPTIONS = [
    { value: 5, label: '5' },
    { value: 30, label: '30' },
    { value: 60, label: '60' },
    { value: 90, label: '90' }
  ];
  var QUALITY_PRESET_OPTIONS = [
    { value: 'quality', label: '质量' },
    { value: 'balanced', label: '均衡' },
    { value: 'speed', label: '速度' }
  ];
  var QUALITY_TUNE_OPTIONS = [
    { value: 'none', label: '默认' },
    { value: 'fastdecode', label: 'fastdecode' },
    { value: 'zerolatency', label: 'zerolatency' }
  ];
  var QUALITY_KEYFRAME_OPTIONS = [
    { value: '2s', label: '2s' },
    { value: '1s', label: '1s' },
    { value: '0.5s', label: '0.5s' },
    { value: 'all-intra', label: 'All-Intra', badge: '高带宽，高负载' }
  ];
  var QUALITY_HARDWARE_ENCODER_PATTERN = /(?:_amf|_mf|_qsv|_nvenc|videotoolbox|_d3d12va)/i;

  function parseObsIngestPort(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    const normalized = Math.round(numeric);
    if (normalized < OBS_INGEST_PORT_MIN || normalized > OBS_INGEST_PORT_MAX) {
      return null;
    }
    return normalized;
  }

  function normalizeObsIngestPort(value, fallback = DEFAULT_OBS_INGEST_PORT) {
    const parsed = parseObsIngestPort(value);
    return parsed === null ? fallback : parsed;
  }

  function normalizeObsIngestPrefs(nextPrefs) {
    return {
      port: normalizeObsIngestPort(nextPrefs && nextPrefs.port, DEFAULT_OBS_INGEST_PORT),
      customPortEnabled: nextPrefs && nextPrefs.customPortEnabled === true
    };
  }

  function readObsIngestPrefs() {
    try {
      const raw = window.localStorage.getItem(OBS_INGEST_PREFS_STORAGE_KEY);
      if (!raw) {
        return normalizeObsIngestPrefs(null);
      }
      return normalizeObsIngestPrefs(JSON.parse(raw));
    } catch (_error) {
      return normalizeObsIngestPrefs(null);
    }
  }

  function persistObsIngestPrefs() {
    try {
      window.localStorage.setItem(OBS_INGEST_PREFS_STORAGE_KEY, JSON.stringify({
        port: normalizeObsIngestPort(qualitySettings && qualitySettings.obsIngestPort, DEFAULT_OBS_INGEST_PORT),
        customPortEnabled: Boolean(qualitySettings && qualitySettings.obsIngestCustomPortEnabled)
      }));
    } catch (_error) {
      // Ignore storage failures.
    }
  }

  const initialObsIngestPrefs = readObsIngestPrefs();

  var qualitySettings = {
    hostBackend: 'native',
    obsIngestPort: initialObsIngestPrefs.port,
    obsIngestCustomPortEnabled: initialObsIngestPrefs.customPortEnabled,
    codecPreference: 'h264',
    resolutionPreset: '1080p',
    width: 1920,
    height: 1080,
    bitrate: 10000,
    frameRate: 30,
    previewEnabled: true,
    hardwareAcceleration: true,
    hardwareEncoderPreference: 'auto',
    encoderPreset: 'balanced',
    encoderTune: 'none',
    publicRoomEnabled: false,
    keyframePolicy: '2s'
  };
  var qualityCapabilities = null;
  var qualityCapabilitiesPromise = null;
  var qualityCapabilitiesChecked = false;

  function getResolutionPreset(value) {
    return QUALITY_RESOLUTION_OPTIONS.find((option) => option.value === value) || QUALITY_RESOLUTION_OPTIONS[3];
  }

  function setQualityResolutionPreset(value) {
    const preset = getResolutionPreset(value);
    qualitySettings.resolutionPreset = preset.value;
    qualitySettings.width = preset.width;
    qualitySettings.height = preset.height;
  }

  function setQualityBitrate(value) {
    const numeric = Number(value);
    const safeValue = Number.isFinite(numeric) ? numeric : qualitySettings.bitrate;
    const stepped = Math.round(safeValue / QUALITY_BITRATE_STEP) * QUALITY_BITRATE_STEP;
    qualitySettings.bitrate = Math.max(QUALITY_BITRATE_MIN, Math.min(QUALITY_BITRATE_MAX, stepped));
  }

  function normalizeHostBackend(value) {
    return String(value || '').trim().toLowerCase() === 'obs-ingest' ? 'obs-ingest' : 'native';
  }

  function getSelectedHostBackend() {
    return normalizeHostBackend(qualitySettings.hostBackend || 'native');
  }

  function isObsIngestCustomPortEnabled() {
    return Boolean(qualitySettings.obsIngestCustomPortEnabled);
  }

  function setObsIngestCustomPortEnabled(enabled, options = {}) {
    const { persist = true } = options;
    qualitySettings.obsIngestCustomPortEnabled = Boolean(enabled);
    if (persist) {
      persistObsIngestPrefs();
    }
    return qualitySettings.obsIngestCustomPortEnabled;
  }

  function getSelectedObsIngestPort() {
    return normalizeObsIngestPort(qualitySettings.obsIngestPort, DEFAULT_OBS_INGEST_PORT);
  }

  function getEffectiveObsIngestPort() {
    return isObsIngestCustomPortEnabled()
      ? getSelectedObsIngestPort()
      : DEFAULT_OBS_INGEST_PORT;
  }

  function setSelectedObsIngestPort(value, options = {}) {
    const { persist = true } = options;
    qualitySettings.obsIngestPort = normalizeObsIngestPort(value, DEFAULT_OBS_INGEST_PORT);
    if (persist) {
      persistObsIngestPrefs();
    }
    return qualitySettings.obsIngestPort;
  }

  function getObsIngestPortForPrepare(requestedPort = null) {
    if (requestedPort != null) {
      return normalizeObsIngestPort(requestedPort, DEFAULT_OBS_INGEST_PORT);
    }
    return getEffectiveObsIngestPort();
  }

  function buildObsIngestPublishUrl(port) {
    const normalizedPort = normalizeObsIngestPort(port, DEFAULT_OBS_INGEST_PORT);
    return `srt://127.0.0.1:${normalizedPort}?mode=caller&transtype=live`;
  }

  function isObsHostBackendAvailable() {
    const hostBackends = qualityCapabilities && Array.isArray(qualityCapabilities.hostBackends)
      ? qualityCapabilities.hostBackends.map((value) => String(value || '').trim().toLowerCase())
      : [];
    if (hostBackends.length === 0) {
      return true;
    }
    return hostBackends.includes('obs-ingest');
  }

  function buildHostBackendOptions() {
    return [
      { value: 'native', label: '原生推流' },
      {
        value: 'obs-ingest',
        label: 'OBS 推流',
        disabled: !isObsHostBackendAvailable()
      }
    ];
  }

  function getRequestedCodecPreference() {
    return qualitySettings.codecPreference === 'h265' ? 'h265' : 'h264';
  }

  function getEffectiveCodecPreference() {
    return getRequestedCodecPreference();
  }

  function getEnumeratedVideoEncoders() {
    const ffmpegCapabilities = qualityCapabilities && qualityCapabilities.ffmpeg
      ? qualityCapabilities.ffmpeg
      : null;
    const encoders = ffmpegCapabilities && Array.isArray(ffmpegCapabilities.videoEncoders)
      ? ffmpegCapabilities.videoEncoders
      : [];
    return encoders.map((entry) => String(entry || '').trim()).filter(Boolean);
  }

  function getValidatedVideoEncoders() {
    const ffmpegCapabilities = qualityCapabilities && qualityCapabilities.ffmpeg
      ? qualityCapabilities.ffmpeg
      : null;
    const encoders = ffmpegCapabilities && Array.isArray(ffmpegCapabilities.validatedVideoEncoders)
      ? ffmpegCapabilities.validatedVideoEncoders
      : [];
    return encoders.map((entry) => String(entry || '').trim()).filter(Boolean);
  }

  function getAvailableVideoEncoders() {
    const validatedEncoders = getValidatedVideoEncoders();
    return validatedEncoders.length > 0 ? validatedEncoders : getEnumeratedVideoEncoders();
  }

  function getLaunchableVideoEncoders() {
    return getAvailableVideoEncoders();
  }

  function filterHardwareVideoEncoders(encoders) {
    return (encoders || []).filter((encoder) => QUALITY_HARDWARE_ENCODER_PATTERN.test(encoder));
  }

  function getHardwareVideoEncoders() {
    return filterHardwareVideoEncoders(getAvailableVideoEncoders());
  }

  function getVideoEncoderProbes() {
    const ffmpegCapabilities = qualityCapabilities && qualityCapabilities.ffmpeg
      ? qualityCapabilities.ffmpeg
      : null;
    const probes = ffmpegCapabilities && Array.isArray(ffmpegCapabilities.videoEncoderProbes)
      ? ffmpegCapabilities.videoEncoderProbes
      : [];
    return probes
      .filter((probe) => probe && typeof probe === 'object')
      .map((probe) => ({
        name: String(probe.name || '').trim(),
        validated: probe.validated === true,
        hardware: probe.hardware === true,
        priority: Number.isFinite(Number(probe.priority)) ? Number(probe.priority) : 999,
        reason: String(probe.reason || '').trim(),
        error: String(probe.error || '').trim()
      }))
      .filter((probe) => probe.name);
  }

  function getAvailableH265VideoEncoders() {
    return getAvailableVideoEncoders().filter((encoder) => /(?:265|hevc)/i.test(encoder));
  }

  function getHardwareH265VideoEncoders() {
    return getAvailableH265VideoEncoders().filter((encoder) => QUALITY_HARDWARE_ENCODER_PATTERN.test(encoder));
  }

  function filterCodecEncoders(encoders, codec) {
    const normalizedCodec = codec === 'h265' ? 'h265' : 'h264';
    return (encoders || []).filter((encoder) => {
      const lowered = String(encoder || '').toLowerCase();
      if (normalizedCodec === 'h265') {
        return /(?:265|hevc)/i.test(lowered);
      }
      return /264/i.test(lowered) && !/(?:265|hevc)/i.test(lowered);
    });
  }

  function getValidatedHardwareEncoderProbes(codecPreference = getEffectiveCodecPreference()) {
    const codec = codecPreference === 'h265' ? 'h265' : 'h264';
    return getVideoEncoderProbes()
      .filter((probe) => probe.validated && probe.hardware)
      .filter((probe) => filterCodecEncoders([probe.name], codec).length > 0)
      .sort((left, right) => {
        if (left.priority !== right.priority) {
          return left.priority - right.priority;
        }
        return left.name.localeCompare(right.name);
      });
  }

  function getSelectedHardwareEncoderPreference() {
    const value = String(qualitySettings.hardwareEncoderPreference || 'auto').trim().toLowerCase();
    return value || 'auto';
  }

  function getHardwareEncoderSelectOptions(codecPreference = getEffectiveCodecPreference()) {
    const probes = getValidatedHardwareEncoderProbes(codecPreference);
    const options = [{ value: 'auto', label: '自动选择' }];
    probes.forEach((probe, index) => {
      options.push({
        value: probe.name,
        label: `${probe.name}（可用 ${index + 1}）`
      });
    });
    return options;
  }

  function getManualHardwareEncoder(codecPreference = getEffectiveCodecPreference()) {
    if (!qualitySettings.hardwareAcceleration) {
      return '';
    }
    const selected = getSelectedHardwareEncoderPreference();
    if (selected === 'auto') {
      return '';
    }
    const options = getHardwareEncoderSelectOptions(codecPreference);
    return options.some((option) => option.value === selected) ? selected : '';
  }

  function isH265CodecAvailable() {
    return getAvailableH265VideoEncoders().length > 0;
  }

  function buildCodecOptions() {
    return QUALITY_CODEC_OPTIONS.map((option) => {
      if (option.value !== 'h265') {
        return option;
      }
      if (isH265CodecAvailable()) {
        return option;
      }
      return {
        ...option,
        disabled: true,
        badge: 'unavailable'
      };
    });
  }

  function getLikelyVideoEncoder(codecPreference, hardwareAcceleration) {
    const codec = codecPreference === 'h265' ? 'h265' : 'h264';
    const manualHardwareEncoder = getManualHardwareEncoder(codec);
    if (hardwareAcceleration && manualHardwareEncoder) {
      return manualHardwareEncoder;
    }
    const availableEncoders = getLaunchableVideoEncoders();
    if (availableEncoders.length === 0) {
      return '';
    }
    const preferredEncoders = codec === 'h265'
      ? (hardwareAcceleration
        ? ['hevc_nvenc', 'hevc_amf', 'hevc_qsv', 'hevc_d3d12va', 'hevc_mf', 'libx265']
        : ['libx265'])
      : (hardwareAcceleration
        ? ['h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_d3d12va', 'h264_mf', 'libx264', 'libopenh264']
        : ['libx264', 'libopenh264']);
    return preferredEncoders.find((encoder) => availableEncoders.includes(encoder)) || '';
  }

  function getPresetMappingForEncoder(encoderName) {
    const encoder = String(encoderName || '').toLowerCase();
    if (!encoder) {
      return null;
    }
    if (encoder.includes('_nvenc')) {
      return { quality: 'p7', balanced: 'p4', speed: 'p1' };
    }
    if (encoder.includes('_amf')) {
      return { quality: 'quality', balanced: 'balanced', speed: 'speed' };
    }
    if (encoder.startsWith('libx264') || encoder.startsWith('libx265')) {
      return { quality: 'slow', balanced: 'medium', speed: 'ultrafast' };
    }
    return null;
  }

  function buildCodecNoteText() {
    const requestedCodec = getRequestedCodecPreference();
    const effectiveCodec = getEffectiveCodecPreference();
    const likelyEncoder = getLikelyVideoEncoder(effectiveCodec, qualitySettings.hardwareAcceleration);
    const availableH265Encoders = getAvailableH265VideoEncoders();
    const hardwareH265Encoders = getHardwareH265VideoEncoders();
    if (requestedCodec === 'h265') {
      if (availableH265Encoders.length === 0) {
        return '当前设备未检测到可用的 H.265 编码器，H.265 选项会保持禁用。';
      }
      if (!qualitySettings.hardwareAcceleration) {
        return likelyEncoder
          ? `当前预计使用 ${likelyEncoder}。H.265 可用，已关闭硬件加速，将走软件编码。`
          : 'H.265 可用，已关闭硬件加速，将走软件编码。';
      }
      if (hardwareH265Encoders.length > 0) {
        return likelyEncoder
          ? `当前预计使用 ${likelyEncoder}。检测到 HEVC 硬件编码器：${hardwareH265Encoders.join('、')}。`
          : `检测到 HEVC 硬件编码器：${hardwareH265Encoders.join('、')}。`;
      }
      return likelyEncoder
        ? `当前预计使用 ${likelyEncoder}。H.265 可用，但未检测到 HEVC 硬件编码器，将走软件编码。`
        : 'H.265 可用，但未检测到 HEVC 硬件编码器，将走软件编码。';
    }
    if (likelyEncoder) {
      return `当前预计使用 ${likelyEncoder}。`;
    }
    if (!qualitySettings.hardwareAcceleration && getAvailableVideoEncoders().length > 0) {
      return '关闭硬件加速后未检测到可用的软件编码器，当前配置可能无法启动。';
    }
    return '当前直播链路将按所选编码启动。';
  }

  function buildHardwareSupportText() {
    const requestedCodec = getRequestedCodecPreference();
    const manualHardwareEncoder = getManualHardwareEncoder(requestedCodec);
    const availableHardwareEncoders = getHardwareVideoEncoders();
    const enumeratedHardwareEncoders = filterHardwareVideoEncoders(getEnumeratedVideoEncoders());
    const relevantHardwareEncoders = requestedCodec === 'h265'
      ? getHardwareH265VideoEncoders()
      : availableHardwareEncoders.filter((encoder) => /264/i.test(encoder) && !/(?:265|hevc)/i.test(encoder));
    const enumeratedRelevantHardwareEncoders = filterCodecEncoders(enumeratedHardwareEncoders, requestedCodec);
    const unvalidatedRelevantHardwareEncoders = enumeratedRelevantHardwareEncoders
      .filter((encoder) => !relevantHardwareEncoders.includes(encoder));
    const otherHardwareEncoders = availableHardwareEncoders.filter((encoder) => !relevantHardwareEncoders.includes(encoder));
    if (!qualityCapabilitiesChecked && window.isElectron && window.electronAPI && window.electronAPI.mediaEngine) {
      return '正在检测设备支持的硬件编码器…';
    }
    const selectedText = manualHardwareEncoder ? `手动指定：${manualHardwareEncoder}；` : '';
    if (requestedCodec === 'h265') {
      if (relevantHardwareEncoders.length > 0) {
        const prefix = '设备支持的硬件编码器：';
        const suffix = unvalidatedRelevantHardwareEncoders.length > 0
          ? `；未通过自检：${unvalidatedRelevantHardwareEncoders.join('、')}`
          : '';
        return `${selectedText}${prefix}${relevantHardwareEncoders.join('、')}${suffix}`;
      }
      if (unvalidatedRelevantHardwareEncoders.length > 0) {
        return `${selectedText}未通过自检：${unvalidatedRelevantHardwareEncoders.join('、')}`;
      }
      if (otherHardwareEncoders.length > 0) {
        return `${selectedText}设备支持的其他硬件编码器：${otherHardwareEncoders.join('、')}`;
      }
      return `${selectedText}未检测到可用的硬件编码器。`;
    }
    if (relevantHardwareEncoders.length === 0) {
      if (unvalidatedRelevantHardwareEncoders.length > 0) {
        return `${selectedText}未通过自检：${unvalidatedRelevantHardwareEncoders.join('、')}`;
      }
      return `${selectedText}未检测到可用的硬件编码器。`;
    }
    const prefix = '设备支持的硬件编码器：';
    const suffix = unvalidatedRelevantHardwareEncoders.length > 0
      ? `；未通过自检：${unvalidatedRelevantHardwareEncoders.join('、')}`
      : '';
    return `${selectedText}${prefix}${relevantHardwareEncoders.join('、')}${suffix}`;
  }

  function buildPresetNoteText() {
    const likelyEncoder = getLikelyVideoEncoder(getEffectiveCodecPreference(), qualitySettings.hardwareAcceleration);
    const mapping = getPresetMappingForEncoder(likelyEncoder);
    if (mapping) {
      return `预计编码器：${likelyEncoder}。质量→${mapping.quality}，均衡→${mapping.balanced}，速度→${mapping.speed}。`;
    }
    if (likelyEncoder) {
      return `预计编码器：${likelyEncoder}。当前编码器不暴露固定三挡预设，将按低延迟默认参数处理。`;
    }
    if (!qualitySettings.hardwareAcceleration && getAvailableVideoEncoders().length > 0) {
      return '关闭硬件加速后未检测到可用的软件编码器，预设参数当前不会生效。';
    }
    return '默认均衡，将按实际编码器映射到对应预设。';
  }

  function buildSegmentGroupMarkup(options, activeValue) {
    return options.map((option) => {
      const value = String(option.value);
      const active = String(activeValue) === value;
      const disabled = Boolean(option.disabled);
      return `
        <span class="quality-segment-item">
          <button
            type="button"
            class="quality-segment-btn${active ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}"
            data-value="${value}"
            ${disabled ? 'disabled' : ''}
            aria-pressed="${active ? 'true' : 'false'}"
            aria-disabled="${disabled ? 'true' : 'false'}"
          >${option.label}</button>
          ${option.badge ? `<span class="quality-segment-badge">${option.badge}</span>` : ''}
        </span>
      `;
    }).join('');
  }

  async function refreshCapabilities({ force = false, getMediaEngine, debugLog, onChange } = {}) {
    if (!force && qualityCapabilities) {
      return qualityCapabilities;
    }
    if (qualityCapabilitiesPromise) {
      return qualityCapabilitiesPromise;
    }
    qualityCapabilitiesPromise = (async () => {
      const mediaEngine = typeof getMediaEngine === 'function' ? getMediaEngine() : null;
      if (!mediaEngine) {
        qualityCapabilities = null;
        return null;
      }
      try {
        if (typeof mediaEngine.getCapabilities === 'function') {
          qualityCapabilities = await mediaEngine.getCapabilities();
        } else {
          qualityCapabilities = null;
        }
      } catch (error) {
        qualityCapabilities = null;
        if (typeof debugLog === 'function') {
          debugLog('video', 'Failed to query native media capabilities:', error.message);
        }
      } finally {
        qualityCapabilitiesChecked = true;
        if (typeof onChange === 'function') {
          onChange();
        }
      }
      return qualityCapabilities;
    })();
    try {
      return await qualityCapabilitiesPromise;
    } finally {
      qualityCapabilitiesPromise = null;
    }
  }

  function createController({
    elements,
    showError,
    commitObsIngestPortInput,
    getMediaEngine
  }) {
    if (!elements) {
      throw new Error('quality-controller-elements-required');
    }
    let obsIngestPreview = null;
    let obsIngestPreparePromise = null;
    let obsIngestPrepareRequestPort = 0;
    let obsIngestPrepareSeq = 0;

    const getPreview = () => {
      return obsIngestPreview;
    };

    const getPrepareState = () => {
      return {
        pending: Boolean(obsIngestPreparePromise),
        requestPort: obsIngestPrepareRequestPort
      };
    };

    const notifyError = (error, fallbackMessage) => {
      if (typeof showError === 'function') {
        showError(error && error.message ? error.message : fallbackMessage);
      }
    };

    async function prepareObsIngestPreview(forceRefresh = false, requestedPort = null) {
      const mediaEngine = typeof getMediaEngine === 'function' ? getMediaEngine() : null;
      if (!mediaEngine) {
        const preview = {
          prepared: false,
          port: getSelectedObsIngestPort(),
          url: '',
          lastError: '当前环境不支持 OBS 本地推流接入'
        };
        obsIngestPreview = preview;
        render();
        return preview;
      }

      if (typeof mediaEngine.prepareObsIngest !== 'function') {
        const preview = {
          prepared: false,
          port: getSelectedObsIngestPort(),
          url: '',
          lastError: '当前构建未启用 OBS ingest'
        };
        obsIngestPreview = preview;
        render();
        return preview;
      }

      const targetPort = getObsIngestPortForPrepare(requestedPort);
      if (requestedPort != null && isObsIngestCustomPortEnabled()) {
        setSelectedObsIngestPort(targetPort);
      }

      if (
        !forceRefresh &&
        obsIngestPreview &&
        obsIngestPreview.prepared &&
        obsIngestPreview.url &&
        Number(obsIngestPreview.port) === targetPort
      ) {
        return obsIngestPreview;
      }

      if (obsIngestPreparePromise && !forceRefresh && obsIngestPrepareRequestPort === targetPort) {
        return obsIngestPreparePromise;
      }

      const requestSeq = obsIngestPrepareSeq + 1;
      obsIngestPrepareSeq = requestSeq;
      const request = (async () => {
        try {
          const mediaSessionId = typeof window.__vdsEnsureCurrentHostMediaSessionId === 'function'
            ? window.__vdsEnsureCurrentHostMediaSessionId()
            : (typeof window.__vdsGetCurrentHostMediaSessionId === 'function' ? window.__vdsGetCurrentHostMediaSessionId() : '');
          const result = await mediaEngine.prepareObsIngest({
            refresh: Boolean(forceRefresh),
            port: targetPort,
            mediaSessionId
          });
          const preview = result && result.obsIngest
            ? result.obsIngest
            : (result || null);
          if (requestSeq === obsIngestPrepareSeq) {
            obsIngestPreview = preview;
            if (preview && Number(preview.port) > 0) {
              setSelectedObsIngestPort(Number(preview.port));
            }
          }
          return preview;
        } catch (error) {
          const preview = {
            prepared: false,
            port: targetPort,
            url: '',
            lastError: error && error.message ? error.message : String(error)
          };
          if (requestSeq === obsIngestPrepareSeq) {
            obsIngestPreview = preview;
          }
          throw error;
        } finally {
          if (requestSeq === obsIngestPrepareSeq) {
            render();
          }
        }
      })();

      obsIngestPreparePromise = request;
      obsIngestPrepareRequestPort = targetPort;
      try {
        return await request;
      } finally {
        if (obsIngestPreparePromise === request) {
          obsIngestPreparePromise = null;
          obsIngestPrepareRequestPort = 0;
          render();
        }
      }
    }

    function render() {
      if (!elements.qualityModal) {
        return;
      }

      if (getSelectedHostBackend() === 'obs-ingest' && !isObsHostBackendAvailable()) {
        qualitySettings.hostBackend = 'native';
      }

      if (qualitySettings.codecPreference === 'h265' && !isH265CodecAvailable()) {
        qualitySettings.codecPreference = 'h264';
      }

      setQualityResolutionPreset(qualitySettings.resolutionPreset);
      setQualityBitrate(qualitySettings.bitrate);
      setSelectedObsIngestPort(qualitySettings.obsIngestPort, { persist: false });
      setObsIngestCustomPortEnabled(qualitySettings.obsIngestCustomPortEnabled, { persist: false });

      if (elements.qualityBackendOptions) {
        elements.qualityBackendOptions.innerHTML = buildSegmentGroupMarkup(
          buildHostBackendOptions(),
          getSelectedHostBackend()
        );
      }

      if (elements.qualityNativePanel) {
        elements.qualityNativePanel.classList.toggle('hidden', getSelectedHostBackend() !== 'native');
      }

      if (elements.qualityObsPanel) {
        elements.qualityObsPanel.classList.toggle('hidden', getSelectedHostBackend() !== 'obs-ingest');
      }

      if (elements.qualityCodecOptions) {
        elements.qualityCodecOptions.innerHTML = buildSegmentGroupMarkup(
          buildCodecOptions(),
          qualitySettings.codecPreference
        );
      }

      if (elements.qualityResolutionOptions) {
        elements.qualityResolutionOptions.innerHTML = buildSegmentGroupMarkup(
          QUALITY_RESOLUTION_OPTIONS,
          qualitySettings.resolutionPreset
        );
      }

      if (elements.qualityFpsOptions) {
        elements.qualityFpsOptions.innerHTML = buildSegmentGroupMarkup(
          QUALITY_FPS_OPTIONS,
          String(qualitySettings.frameRate)
        );
      }

      if (elements.qualityPresetOptions) {
        elements.qualityPresetOptions.innerHTML = buildSegmentGroupMarkup(
          QUALITY_PRESET_OPTIONS,
          qualitySettings.encoderPreset
        );
      }

      if (elements.qualityTuneOptions) {
        elements.qualityTuneOptions.innerHTML = buildSegmentGroupMarkup(
          QUALITY_TUNE_OPTIONS,
          qualitySettings.encoderTune
        );
      }

      if (elements.qualityKeyframeOptions) {
        elements.qualityKeyframeOptions.innerHTML = buildSegmentGroupMarkup(
          QUALITY_KEYFRAME_OPTIONS,
          qualitySettings.keyframePolicy || '2s'
        );
      }

      if (elements.qualityBitrate) {
        elements.qualityBitrate.value = String(qualitySettings.bitrate);
      }

      if (elements.qualityHardwareAcceleration) {
        elements.qualityHardwareAcceleration.checked = Boolean(qualitySettings.hardwareAcceleration);
      }

      if (elements.qualityPreviewEnabled) {
        elements.qualityPreviewEnabled.checked = qualitySettings.previewEnabled !== false;
      }

      if (elements.qualityHardwareEncoderSelect) {
        const hardwareEncoderOptions = getHardwareEncoderSelectOptions(qualitySettings.codecPreference);
        const selectedHardwareEncoder = getSelectedHardwareEncoderPreference();
        if (!hardwareEncoderOptions.some((option) => option.value === selectedHardwareEncoder)) {
          qualitySettings.hardwareEncoderPreference = 'auto';
        }
        elements.qualityHardwareEncoderSelect.innerHTML = hardwareEncoderOptions.map((option) => {
          const selected = option.value === getSelectedHardwareEncoderPreference();
          return `<option value="${option.value}"${selected ? ' selected' : ''}>${option.label}</option>`;
        }).join('');
        elements.qualityHardwareEncoderSelect.disabled =
          !qualitySettings.hardwareAcceleration || hardwareEncoderOptions.length <= 1;
      }

      if (elements.qualityCodecNote) {
        elements.qualityCodecNote.textContent = buildCodecNoteText();
      }

      if (elements.qualityHardwareSupport) {
        elements.qualityHardwareSupport.textContent = buildHardwareSupportText();
      }

      if (elements.qualityPresetNote) {
        elements.qualityPresetNote.textContent = buildPresetNoteText();
      }

      if (elements.qualityObsCustomPortEnabled) {
        elements.qualityObsCustomPortEnabled.checked = isObsIngestCustomPortEnabled();
      }

      if (elements.qualityObsCustomPortRow) {
        elements.qualityObsCustomPortRow.classList.toggle('hidden', !isObsIngestCustomPortEnabled());
      }

      if (elements.qualityObsPort) {
        elements.qualityObsPort.value = String(getSelectedObsIngestPort());
      }

      const preview = getPreview();
      const prepareState = getPrepareState();
      if (elements.qualityObsUrl) {
        const requestedPort = getEffectiveObsIngestPort();
        const obsUrl = preview && preview.url && Number(preview.port) === requestedPort
          ? String(preview.url)
          : buildObsIngestPublishUrl(requestedPort);
        elements.qualityObsUrl.textContent = obsUrl;
      }

      if (elements.qualityObsStatus) {
        const requestedPort = getEffectiveObsIngestPort();
        const preparePendingForRequestedPort = Boolean(prepareState.pending && prepareState.requestPort === requestedPort);
        if (preparePendingForRequestedPort) {
          elements.qualityObsStatus.textContent = `正在检查并预留 127.0.0.1:${prepareState.requestPort}...`;
        } else if (prepareState.pending) {
          elements.qualityObsStatus.textContent = `正在检查并预留 127.0.0.1:${prepareState.requestPort}，当前输入端口 ${requestedPort} 尚未保存。`;
        } else if (preview && preview.lastError && Number(preview.port) === requestedPort) {
          elements.qualityObsStatus.textContent = `端口 ${requestedPort} 不可用：${preview.lastError}`;
        } else if (preview && preview.url && Number(preview.port) === requestedPort) {
          elements.qualityObsStatus.textContent = isObsIngestCustomPortEnabled()
            ? `当前使用自定义端口 ${requestedPort}。确认后会复制地址并进入等待推流状态。`
            : `当前使用默认端口 ${requestedPort}。确认后会复制地址并进入等待推流状态。`;
        } else {
          elements.qualityObsStatus.textContent = `默认端口是 ${DEFAULT_OBS_INGEST_PORT}，打开“自定义推流地址”后可以改成你习惯的固定端口。`;
        }
      }

      if (elements.btnSaveObsPort) {
        elements.btnSaveObsPort.disabled = Boolean(prepareState.pending && prepareState.requestPort === getEffectiveObsIngestPort());
      }

      if (elements.btnConfirmQuality) {
        elements.btnConfirmQuality.textContent = getSelectedHostBackend() === 'obs-ingest'
          ? '复制并开始'
          : '确认并继续';
      }
    }

    function bindSegmentGroup(container, onSelect) {
      if (!container) {
        return;
      }
      container.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-value]');
        if (!(button instanceof HTMLButtonElement)) {
          return;
        }
        onSelect(button.dataset.value || '');
      });
    }

    let bound = false;
    function bind() {
      if (bound) {
        return;
      }
      bound = true;

      bindSegmentGroup(elements.qualityBackendOptions, (value) => {
        qualitySettings.hostBackend = normalizeHostBackend(value);
        render();
        if (qualitySettings.hostBackend === 'obs-ingest' && typeof prepareObsIngestPreview === 'function') {
          prepareObsIngestPreview(false, getEffectiveObsIngestPort()).catch((error) => {
            notifyError(error, '无法准备 OBS 推流地址');
          });
        }
      });

      bindSegmentGroup(elements.qualityCodecOptions, (value) => {
        qualitySettings.codecPreference = value === 'h265' ? 'h265' : 'h264';
        render();
      });

      bindSegmentGroup(elements.qualityResolutionOptions, (value) => {
        setQualityResolutionPreset(value);
        render();
      });

      bindSegmentGroup(elements.qualityFpsOptions, (value) => {
        qualitySettings.frameRate = Number(value) || 30;
        render();
      });

      bindSegmentGroup(elements.qualityPresetOptions, (value) => {
        qualitySettings.encoderPreset = QUALITY_PRESET_OPTIONS.some((option) => option.value === value)
          ? value
          : 'balanced';
        render();
      });

      bindSegmentGroup(elements.qualityTuneOptions, (value) => {
        qualitySettings.encoderTune = QUALITY_TUNE_OPTIONS.some((option) => option.value === value)
          ? value
          : 'none';
        render();
      });

      bindSegmentGroup(elements.qualityKeyframeOptions, (value) => {
        qualitySettings.keyframePolicy = QUALITY_KEYFRAME_OPTIONS.some((option) => option.value === value)
          ? value
          : '2s';
        render();
      });

      if (elements.qualityHardwareAcceleration) {
        elements.qualityHardwareAcceleration.addEventListener('change', () => {
          qualitySettings.hardwareAcceleration = Boolean(elements.qualityHardwareAcceleration.checked);
          render();
        });
      }

      if (elements.qualityPreviewEnabled) {
        elements.qualityPreviewEnabled.addEventListener('change', () => {
          qualitySettings.previewEnabled = Boolean(elements.qualityPreviewEnabled.checked);
          render();
        });
      }

      if (elements.qualityHardwareEncoderSelect) {
        elements.qualityHardwareEncoderSelect.addEventListener('change', () => {
          const value = String(elements.qualityHardwareEncoderSelect.value || 'auto').trim().toLowerCase();
          qualitySettings.hardwareEncoderPreference = value || 'auto';
          render();
        });
      }

      if (elements.qualityBitrateDecrease) {
        elements.qualityBitrateDecrease.addEventListener('click', () => {
          setQualityBitrate(qualitySettings.bitrate - QUALITY_BITRATE_STEP);
          render();
        });
      }

      if (elements.qualityBitrateIncrease) {
        elements.qualityBitrateIncrease.addEventListener('click', () => {
          setQualityBitrate(qualitySettings.bitrate + QUALITY_BITRATE_STEP);
          render();
        });
      }

      if (elements.qualityBitrate) {
        const syncBitrate = () => {
          setQualityBitrate(elements.qualityBitrate.value);
          render();
        };
        elements.qualityBitrate.addEventListener('change', syncBitrate);
        elements.qualityBitrate.addEventListener('blur', syncBitrate);
      }

      if (elements.qualityObsCustomPortEnabled) {
        elements.qualityObsCustomPortEnabled.addEventListener('change', () => {
          const enabled = Boolean(elements.qualityObsCustomPortEnabled.checked);
          setObsIngestCustomPortEnabled(enabled);
          render();
          if (typeof prepareObsIngestPreview === 'function') {
            prepareObsIngestPreview(true, getEffectiveObsIngestPort()).catch((error) => {
              notifyError(error, '无法准备 OBS 推流地址');
            });
          }
        });
      }

      if (elements.qualityObsPort) {
        const syncObsPortFromInput = () => {
          try {
            if (typeof commitObsIngestPortInput === 'function') {
              commitObsIngestPortInput();
            }
            render();
          } catch (error) {
            notifyError(error, 'OBS 端口无效');
          }
        };
        elements.qualityObsPort.addEventListener('change', syncObsPortFromInput);
        elements.qualityObsPort.addEventListener('blur', syncObsPortFromInput);
        elements.qualityObsPort.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') {
            return;
          }
          event.preventDefault();
          if (elements.btnSaveObsPort) {
            elements.btnSaveObsPort.click();
          } else {
            syncObsPortFromInput();
          }
        });
      }

      if (elements.btnSaveObsPort) {
        elements.btnSaveObsPort.addEventListener('click', () => {
          try {
            const port = typeof commitObsIngestPortInput === 'function'
              ? commitObsIngestPortInput()
              : getEffectiveObsIngestPort();
            render();
            if (typeof prepareObsIngestPreview === 'function') {
              prepareObsIngestPreview(true, port).catch((error) => {
                notifyError(error, '无法保存 OBS 推流地址');
              });
            }
          } catch (error) {
            notifyError(error, 'OBS 端口无效');
          }
        });
      }
    }

    return {
      bind,
      render,
      prepareObsIngestPreview,
      getObsIngestPreview: getPreview,
      getObsIngestPrepareState: getPrepareState
    };
  }


  VDS.qualitySettings = {
    settings: qualitySettings,
    parseObsIngestPort,
    normalizeObsIngestPort,
    normalizeObsIngestPrefs,
    readObsIngestPrefs,
    persistObsIngestPrefs,
    getResolutionPreset,
    setQualityResolutionPreset,
    setQualityBitrate,
    normalizeHostBackend,
    getSelectedHostBackend,
    isObsIngestCustomPortEnabled,
    setObsIngestCustomPortEnabled,
    getSelectedObsIngestPort,
    getEffectiveObsIngestPort,
    setSelectedObsIngestPort,
    getObsIngestPortForPrepare,
    buildObsIngestPublishUrl,
    isObsHostBackendAvailable,
    buildHostBackendOptions,
    getRequestedCodecPreference,
    getEffectiveCodecPreference,
    getEnumeratedVideoEncoders,
    getValidatedVideoEncoders,
    getAvailableVideoEncoders,
    getLaunchableVideoEncoders,
    filterHardwareVideoEncoders,
    getHardwareVideoEncoders,
    getVideoEncoderProbes,
    getAvailableH265VideoEncoders,
    getHardwareH265VideoEncoders,
    filterCodecEncoders,
    getValidatedHardwareEncoderProbes,
    getSelectedHardwareEncoderPreference,
    getHardwareEncoderSelectOptions,
    getManualHardwareEncoder,
    isH265CodecAvailable,
    buildCodecOptions,
    getLikelyVideoEncoder,
    getPresetMappingForEncoder,
    buildCodecNoteText,
    buildHardwareSupportText,
    buildPresetNoteText,
    buildSegmentGroupMarkup,
    refreshCapabilities,
    isCapabilitiesChecked: () => qualityCapabilitiesChecked,
    getCapabilities: () => qualityCapabilities,
    setCapabilities: (nextCapabilities) => {
      qualityCapabilities = nextCapabilities || null;
      qualityCapabilitiesChecked = true;
      return qualityCapabilities;
    },
    createController,
    constants: {
      DEFAULT_OBS_INGEST_PORT,
      OBS_INGEST_PORT_MIN,
      OBS_INGEST_PORT_MAX,
      QUALITY_BITRATE_MIN,
      QUALITY_BITRATE_MAX,
      QUALITY_BITRATE_STEP,
      QUALITY_CODEC_OPTIONS,
      QUALITY_RESOLUTION_OPTIONS,
      QUALITY_FPS_OPTIONS,
      QUALITY_PRESET_OPTIONS,
      QUALITY_TUNE_OPTIONS,
      QUALITY_KEYFRAME_OPTIONS,
      QUALITY_HARDWARE_ENCODER_PATTERN
    }
  };
})();
