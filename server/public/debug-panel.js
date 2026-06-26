(function () {
  const VDS = window.VDS = window.VDS || {};

  const DEBUG_MODE_STORAGE_KEY = 'vds-debug-mode';
  const DEBUG_CONFIG_STORAGE_KEY = 'vds-debug-config';

  const CATEGORY_DEFINITIONS = Object.freeze({
    connection: {
      label: '连接',
      description: 'WebSocket、信令、ICE、Peer 建连与重连'
    },
    p2p: {
      label: 'P2P 诊断',
      description: '候选、RTT、NACK/PLI、关键帧请求与媒体平面状态'
    },
    video: {
      label: '视频',
      description: '采集源、Surface、视频链路与预览同步'
    },
    audio: {
      label: '音频',
      description: '音频会话、音量、播放与原生音频桥'
    },
    update: {
      label: '更新',
      description: '版本检查、下载、安装与更新日志'
    },
    misc: {
      label: '杂项',
      description: '启动、能力探测、版本信息与其它诊断'
    }
  });

  const CHANNEL_DEFINITIONS = Object.freeze({
    renderer: {
      label: '渲染日志',
      description: 'app.js 常规调试输出'
    },
    nativeEvents: {
      label: '原生事件',
      description: 'media-state、peer-state、signal 事件摘要，高频事件会被节流'
    },
    nativeSteps: {
      label: '原生步骤',
      description: 'attach/createPeer/setRemoteDescription 等 step 明细，同类步骤会被节流'
    },
    periodicStats: {
      label: '周期统计',
      description: 'host/viewer 周期 stats 与抖动指标，默认按采样输出'
    },
    mainProcess: {
      label: '主进程桥接',
      description: 'IPC 调用、surface enrich、主进程媒体桥'
    },
    highFrequency: {
      label: '高频明细',
      description: 'audio-data、updateSurface、getStats 等高频对象，只在短时复现时打开'
    },
    agentBreadcrumbs: {
      label: 'Agent Breadcrumb',
      description: 'native agent stderr breadcrumb 轨迹，主进程会按内容归并'
    },
    agentStderr: {
      label: 'Agent STDERR',
      description: 'native agent 原始 stderr 输出，仅短时间深挖时打开'
    }
  });

  const PRESET_DEFINITIONS = Object.freeze({
    quiet: {
      label: '静默',
      description: '关闭所有调试输出',
      config: {
        categories: {
          connection: false,
          p2p: false,
          video: false,
          audio: false,
          update: false,
          misc: false
        },
        channels: {
          renderer: false,
          nativeEvents: false,
          nativeSteps: false,
          periodicStats: false,
          mainProcess: false,
          highFrequency: false,
          agentBreadcrumbs: false,
          agentStderr: false
        }
      }
    },
    diagnose: {
      label: '排障',
      description: '推荐日常排障，默认不开高频日志',
      config: {
        categories: {
          connection: true,
          p2p: true,
          video: true,
          audio: true,
          update: true,
          misc: true
        },
        channels: {
          renderer: true,
          nativeEvents: true,
          nativeSteps: false,
          periodicStats: false,
          mainProcess: true,
          highFrequency: false,
          agentBreadcrumbs: false,
          agentStderr: false
        }
      }
    },
    traceVideo: {
      label: '视频追踪',
      description: '重点看视频链路，开启 step 和周期统计',
      config: {
        categories: {
          connection: true,
          p2p: false,
          video: true,
          audio: false,
          update: false,
          misc: false
        },
        channels: {
          renderer: true,
          nativeEvents: true,
          nativeSteps: true,
          periodicStats: true,
          mainProcess: true,
          highFrequency: false,
          agentBreadcrumbs: true,
          agentStderr: false
        }
      }
    },
    verbose: {
      label: '短时全量',
      description: '最大化日志，只适合短时间深挖问题，不建议长时间运行',
      config: {
        categories: {
          connection: true,
          p2p: false,
          video: true,
          audio: true,
          update: true,
          misc: true
        },
        channels: {
          renderer: true,
          nativeEvents: true,
          nativeSteps: true,
          periodicStats: true,
          mainProcess: true,
          highFrequency: true,
          agentBreadcrumbs: true,
          agentStderr: true
        }
      }
    }
  });

  const CATEGORY_KEYS = Object.keys(CATEGORY_DEFINITIONS);
  const CHANNEL_KEYS = Object.keys(CHANNEL_DEFINITIONS);

  function normalizeRuntimeDebugPreset(preset) {
    const normalized = String(preset || '').trim();
    if (!normalized || normalized === 'profile') {
      return '';
    }
    return Object.prototype.hasOwnProperty.call(PRESET_DEFINITIONS, normalized)
      ? normalized
      : '';
  }

  function readDebugModeFlag() {
    try {
      return window.localStorage.getItem(DEBUG_MODE_STORAGE_KEY) === '1';
    } catch (_error) {
      return false;
    }
  }

  function buildDefaultConfig(enabled = false) {
    return {
      categories: CATEGORY_KEYS.reduce((config, key) => {
        config[key] = Boolean(enabled);
        return config;
      }, {}),
      channels: CHANNEL_KEYS.reduce((config, key) => {
        config[key] = Boolean(enabled);
        return config;
      }, {})
    };
  }

  function normalizeConfig(config, fallbackEnabled = false) {
    if (typeof config === 'boolean') {
      return buildDefaultConfig(config);
    }

    const normalized = buildDefaultConfig(fallbackEnabled);
    if (!config || typeof config !== 'object') {
      return normalized;
    }

    const hasStructuredCategories = Boolean(config.categories && typeof config.categories === 'object');
    const hasStructuredChannels = Boolean(config.channels && typeof config.channels === 'object');

    if (!hasStructuredCategories && !hasStructuredChannels) {
      for (const key of CATEGORY_KEYS) {
        if (Object.prototype.hasOwnProperty.call(config, key)) {
          normalized.categories[key] = Boolean(config[key]);
        }
      }

      const legacyEnabled = CATEGORY_KEYS.some((key) => normalized.categories[key]);
      normalized.channels.renderer = legacyEnabled;
      normalized.channels.nativeEvents = legacyEnabled;
      normalized.channels.mainProcess = legacyEnabled;
      return normalized;
    }

    for (const key of CATEGORY_KEYS) {
      if (hasStructuredCategories && Object.prototype.hasOwnProperty.call(config.categories, key)) {
        normalized.categories[key] = Boolean(config.categories[key]);
      }
    }

    for (const key of CHANNEL_KEYS) {
      if (hasStructuredChannels && Object.prototype.hasOwnProperty.call(config.channels, key)) {
        normalized.channels[key] = Boolean(config.channels[key]);
      }
    }

    return normalized;
  }

  function readConfig(options = {}) {
    const runtimePreset = normalizeRuntimeDebugPreset(options.runtimeDebugPreset);
    if (runtimePreset) {
      return normalizeConfig(PRESET_DEFINITIONS[runtimePreset].config, false);
    }

    const legacyEnabled = readDebugModeFlag();
    try {
      const raw = window.localStorage.getItem(DEBUG_CONFIG_STORAGE_KEY);
      if (!raw) {
        return buildDefaultConfig(legacyEnabled);
      }
      return normalizeConfig(JSON.parse(raw), legacyEnabled);
    } catch (_error) {
      return buildDefaultConfig(legacyEnabled);
    }
  }

  function isAnyEnabled(config) {
    return CATEGORY_KEYS.some((key) => Boolean(config.categories && config.categories[key])) ||
      CHANNEL_KEYS.some((key) => Boolean(config.channels && config.channels[key]));
  }

  function isLogEnabled(config, category = 'misc', channel = 'renderer') {
    if (!Object.prototype.hasOwnProperty.call(CATEGORY_DEFINITIONS, category)) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(CHANNEL_DEFINITIONS, channel)) {
      return false;
    }

    return Boolean(config.categories && config.categories[category]) &&
      Boolean(config.channels && config.channels[channel]);
  }

  function isAnyPathEnabled(config) {
    return CATEGORY_KEYS.some((category) => (
      CHANNEL_KEYS.some((channel) => isLogEnabled(config, category, channel))
    ));
  }

  function persistConfig(config) {
    try {
      window.localStorage.setItem(DEBUG_CONFIG_STORAGE_KEY, JSON.stringify(config));
      window.localStorage.setItem(DEBUG_MODE_STORAGE_KEY, isAnyEnabled(config) ? '1' : '0');
    } catch (_error) {
      // ignore storage errors
    }
  }

  function isSameConfig(left, right) {
    const normalizedLeft = normalizeConfig(left, false);
    const normalizedRight = normalizeConfig(right, false);
    return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
  }

  function getActivePresetKey(config) {
    return Object.keys(PRESET_DEFINITIONS).find((key) => (
      isSameConfig(config, PRESET_DEFINITIONS[key].config)
    )) || '';
  }

  function describeSelection(config) {
    const presetKey = getActivePresetKey(config);
    if (presetKey) {
      const preset = PRESET_DEFINITIONS[presetKey];
      return `当前预设：${preset.label}。${preset.description}`;
    }

    const enabledCategories = CATEGORY_KEYS
      .filter((key) => config.categories[key])
      .map((key) => CATEGORY_DEFINITIONS[key].label);
    const enabledChannels = CHANNEL_KEYS
      .filter((key) => config.channels[key])
      .map((key) => CHANNEL_DEFINITIONS[key].label);

    if (enabledCategories.length === 0 || enabledChannels.length === 0) {
      return '已自定义，但类别或通道为空，当前不会输出调试日志。';
    }

    return `自定义：${enabledCategories.length} 个类别 / ${enabledChannels.length} 个通道`;
  }

  function renderMenuMarkup() {
    const presetItems = Object.entries(PRESET_DEFINITIONS).map(([key, definition]) => `
      <button class="debug-menu-preset" type="button" data-debug-preset="${key}" title="${definition.description}">
        <span class="debug-menu-preset-label">${definition.label}</span>
        <span class="debug-menu-preset-description">${definition.description}</span>
      </button>
    `).join('');

    const categoryItems = CATEGORY_KEYS.map((key) => {
      const definition = CATEGORY_DEFINITIONS[key];
      return `
        <label class="debug-menu-item">
          <span class="debug-menu-item-main">
            <input type="checkbox" data-debug-category="${key}">
            <span class="debug-menu-item-label">${definition.label}</span>
          </span>
          <span class="debug-menu-item-description">${definition.description}</span>
        </label>
      `;
    }).join('');

    const regularChannelItems = CHANNEL_KEYS
      .filter((key) => key !== 'agentStderr')
      .map((key) => {
        const definition = CHANNEL_DEFINITIONS[key];
        return `
          <label class="debug-menu-item">
            <span class="debug-menu-item-main">
              <input type="checkbox" data-debug-channel="${key}">
              <span class="debug-menu-item-label">${definition.label}</span>
            </span>
            <span class="debug-menu-item-description">${definition.description}</span>
          </label>
        `;
      }).join('');

    const agentStderrDefinition = CHANNEL_DEFINITIONS.agentStderr;
    const advancedChannelItems = `
      <label class="debug-menu-item debug-menu-item-warning">
        <span class="debug-menu-item-main">
          <input type="checkbox" data-debug-channel="agentStderr">
          <span class="debug-menu-item-label">${agentStderrDefinition.label}</span>
        </span>
        <span class="debug-menu-item-description">${agentStderrDefinition.description}</span>
      </label>
    `;

    return `
      <div class="debug-menu-header">
        <span class="debug-menu-title">调试控制台</span>
        <span class="debug-menu-subtitle">先选快速模式；需要缩小范围时，再勾选问题范围和输出内容。</span>
      </div>
      <div class="debug-menu-summary" data-debug-summary>当前为静默模式</div>
      <div class="debug-menu-section">
        <span class="debug-menu-section-title">快速模式</span>
        <p class="debug-menu-section-hint">日常先用“排障”；只有短时间复现才用“短时全量”。</p>
        <div class="debug-menu-presets">${presetItems}</div>
      </div>
      <div class="debug-menu-section">
        <span class="debug-menu-section-title">问题范围</span>
        <p class="debug-menu-section-hint">选择要看的业务范围。至少需要一个范围和一个输出内容同时开启。</p>
        <div class="debug-menu-body">${categoryItems}</div>
      </div>
      <div class="debug-menu-section">
        <span class="debug-menu-section-title">输出内容</span>
        <p class="debug-menu-section-hint">越靠下越细，日志量越大；周期统计和 breadcrumb 已做采样。</p>
        <div class="debug-menu-body">${regularChannelItems}</div>
      </div>
      <div class="debug-menu-section">
        <span class="debug-menu-section-title">深度诊断</span>
        <p class="debug-menu-section-hint">只在复现窗口很短、必须看 agent 原始 stderr 时打开。</p>
        <div class="debug-menu-body">${advancedChannelItems}</div>
      </div>
      <div class="debug-menu-footer">
        <button class="debug-menu-action" type="button" data-debug-preset="quiet">恢复静默</button>
      </div>
    `;
  }

  function createController(options = {}) {
    const elements = options.elements || {};
    const electronAPI = options.electronAPI || null;
    const logSink = typeof options.logSink === 'function' ? options.logSink : () => {};
    const onConfigChanged = typeof options.onConfigChanged === 'function'
      ? options.onConfigChanged
      : () => {};
    let config = readConfig({ runtimeDebugPreset: options.runtimeDebugPreset });
    let flushTimer = null;
    let flushPersist = false;
    let flushNotify = false;
    let bound = false;

    function propagate(nextConfig) {
      if (electronAPI && typeof electronAPI.setDebugConfig === 'function') {
        electronAPI.setDebugConfig(nextConfig);
      }
    }

    function syncUi() {
      const debugEnabled = isAnyPathEnabled(config);
      if (document.body) {
        document.body.classList.toggle('debug-mode-enabled', debugEnabled);
      }

      if (elements.btnDebugToggle) {
        const enabledCategories = CATEGORY_KEYS
          .filter((key) => config.categories[key])
          .map((key) => CATEGORY_DEFINITIONS[key].label);
        const enabledChannels = CHANNEL_KEYS
          .filter((key) => config.channels[key])
          .map((key) => CHANNEL_DEFINITIONS[key].label);
        elements.btnDebugToggle.classList.toggle('active', debugEnabled);
        elements.btnDebugToggle.title = debugEnabled
          ? `已开启：${enabledCategories.join('、') || '无类别'} / ${enabledChannels.join('、') || '无通道'}`
          : '打开调试菜单';
        if (elements.debugMenu) {
          elements.btnDebugToggle.setAttribute(
            'aria-expanded',
            elements.debugMenu.classList.contains('hidden') ? 'false' : 'true'
          );
        }
      }

      if (!elements.debugMenu) {
        return;
      }

      const checkboxes = elements.debugMenu.querySelectorAll('[data-debug-category], [data-debug-channel]');
      checkboxes.forEach((input) => {
        const category = input.getAttribute('data-debug-category');
        const channel = input.getAttribute('data-debug-channel');
        let checked = false;
        if (category) {
          checked = Boolean(config.categories[category]);
        } else if (channel) {
          checked = Boolean(config.channels[channel]);
        }
        input.checked = checked;
        const item = input.closest('.debug-menu-item');
        if (item) {
          item.classList.toggle('active', checked);
        }
      });

      const summary = elements.debugMenu.querySelector('[data-debug-summary]');
      if (summary) {
        summary.textContent = describeSelection(config);
      }

      const presetButtons = elements.debugMenu.querySelectorAll('[data-debug-preset]');
      presetButtons.forEach((button) => {
        const presetKey = button.getAttribute('data-debug-preset');
        button.classList.toggle('active', presetKey === getActivePresetKey(config));
      });
    }

    function scheduleFlush({ persist = true, notify = true } = {}) {
      flushPersist = flushPersist || Boolean(persist);
      flushNotify = flushNotify || Boolean(notify);
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const shouldPersist = flushPersist;
        const shouldNotify = flushNotify;
        flushPersist = false;
        flushNotify = false;
        if (shouldPersist) {
          persistConfig(config);
        }
        if (shouldNotify) {
          propagate(config);
        }
      }, 100);
    }

    function setConfig(nextConfig, setOptions = {}) {
      const { persist = true, notify = true } = setOptions;
      config = normalizeConfig(nextConfig, false);
      if (persist || notify) {
        scheduleFlush({ persist, notify });
      }
      syncUi();
      onConfigChanged(config);
    }

    function setCategoryEnabled(category, enabled) {
      if (!Object.prototype.hasOwnProperty.call(CATEGORY_DEFINITIONS, category)) {
        return;
      }
      setConfig({
        ...config,
        categories: {
          ...config.categories,
          [category]: Boolean(enabled)
        }
      });
    }

    function setChannelEnabled(channel, enabled) {
      if (!Object.prototype.hasOwnProperty.call(CHANNEL_DEFINITIONS, channel)) {
        return;
      }
      setConfig({
        ...config,
        channels: {
          ...config.channels,
          [channel]: Boolean(enabled)
        }
      });
    }

    function applyPreset(presetKey) {
      const preset = PRESET_DEFINITIONS[presetKey];
      if (!preset) {
        return;
      }
      setConfig(normalizeConfig(preset.config, false));
    }

    function handleInputChange(input) {
      const category = input.getAttribute('data-debug-category');
      const channel = input.getAttribute('data-debug-channel');
      if (category) {
        setCategoryEnabled(category, input.checked);
        return;
      }
      if (channel) {
        setChannelEnabled(channel, input.checked);
      }
    }

    function handleMenuClick(event) {
      event.stopPropagation();
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const presetButton = target.closest('[data-debug-preset]');
      if (!(presetButton instanceof HTMLElement)) {
        return;
      }

      const presetKey = presetButton.getAttribute('data-debug-preset');
      if (presetKey) {
        applyPreset(presetKey);
      }
    }

    function render() {
      if (!elements.debugMenu) {
        return;
      }
      elements.debugMenu.innerHTML = renderMenuMarkup();
      syncUi();
    }

    function bind() {
      if (bound) {
        return;
      }
      bound = true;

      if (elements.btnDebugToggle) {
        elements.btnDebugToggle.addEventListener('click', (event) => {
          event.stopPropagation();
          toggle();
        });
      }

      if (!elements.debugMenu) {
        return;
      }

      elements.debugMenu.addEventListener('click', handleMenuClick);
      elements.debugMenu.addEventListener('change', (event) => {
        const input = event.target;
        if (input instanceof HTMLInputElement) {
          handleInputChange(input);
        }
      });
    }

    function open() {
      if (!elements.debugMenu) {
        return;
      }
      elements.debugMenu.classList.remove('hidden');
      syncUi();
    }

    function close() {
      if (!elements.debugMenu) {
        return;
      }
      elements.debugMenu.classList.add('hidden');
      syncUi();
    }

    function toggle() {
      if (!elements.debugMenu) {
        return;
      }
      if (elements.debugMenu.classList.contains('hidden')) {
        open();
      } else {
        close();
      }
    }

    function log(category, ...args) {
      let resolvedCategory = category;
      let resolvedArgs = args;
      if (!Object.prototype.hasOwnProperty.call(CATEGORY_DEFINITIONS, resolvedCategory)) {
        resolvedArgs = [category, ...args];
        resolvedCategory = 'misc';
      }
      if (!isLogEnabled(config, resolvedCategory, 'renderer')) {
        return;
      }
      logSink(...resolvedArgs);
    }

    return {
      getConfig: () => normalizeConfig(config, false),
      setConfig,
      sync: (syncOptions = {}) => setConfig(config, syncOptions),
      syncUi,
      render,
      bind,
      open,
      close,
      toggle,
      isDebugModeEnabled: () => isAnyPathEnabled(config),
      isDebugLogEnabled: (category = 'misc', channel = 'renderer') => isLogEnabled(config, category, channel),
      log,
      setCategoryEnabled,
      setChannelEnabled,
      applyPreset
    };
  }

  VDS.debugPanel = {
    constants: {
      DEBUG_MODE_STORAGE_KEY,
      DEBUG_CONFIG_STORAGE_KEY
    },
    definitions: {
      categories: CATEGORY_DEFINITIONS,
      channels: CHANNEL_DEFINITIONS,
      presets: PRESET_DEFINITIONS
    },
    keys: {
      categories: CATEGORY_KEYS,
      channels: CHANNEL_KEYS
    },
    buildDefaultConfig,
    normalizeConfig,
    readConfig,
    isLogEnabled,
    isAnyPathEnabled,
    createController
  };
})();
