(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.updateUi) {
    return;
  }

  const UPDATE_LOG_ENTRY_LIMIT = 40;

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) {
      return '0 B';
    }
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const index = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, index)).toFixed(1)) + ' ' + sizes[index];
  }

  function formatTime(ms) {
    if (!ms || ms <= 0) {
      return '未知';
    }
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return hours + '小时' + (minutes % 60) + '分钟';
    }
    if (minutes > 0) {
      return minutes + '分钟' + (seconds % 60) + '秒';
    }
    return seconds + '秒';
  }

  function createController(options = {}) {
    const elements = options.elements || {};
    const debugLog = typeof options.debugLog === 'function' ? options.debugLog : function noopDebugLog() {};
    const getElectronApi = typeof options.getElectronApi === 'function'
      ? options.getElectronApi
      : () => window.electronAPI || null;
    const getServerBaseUrl = typeof options.getServerBaseUrl === 'function'
      ? options.getServerBaseUrl
      : () => String(options.serverBaseUrl || '');

    let currentVersion = options.defaultVersion || '1.6.6';
    let updateStatusUnsubscribe = null;
    let updateLogUnsubscribe = null;
    let updateCheckStarted = false;
    let updateModalAutoHideTimer = null;
    let updateInstallTimer = null;
    let updateInstallRequested = false;
    let updateReadyToInstall = false;
    let updateDownloadRequested = false;
    let updateLogPath = '';
    const updateLogEntries = [];

    function getUpdateManifestUrl() {
      return `${getServerBaseUrl()}/updates/latest.yml`;
    }

    function clearUpdateModalAutoHide() {
      if (updateModalAutoHideTimer) {
        clearTimeout(updateModalAutoHideTimer);
        updateModalAutoHideTimer = null;
      }
    }

    function clearScheduledUpdateInstall() {
      if (updateInstallTimer) {
        clearTimeout(updateInstallTimer);
        updateInstallTimer = null;
      }
    }

    function requestQuitAndInstall() {
      if (updateInstallRequested) {
        return;
      }
      updateInstallRequested = true;
      updateReadyToInstall = true;
      clearScheduledUpdateInstall();
      if (elements.btnInstallUpdate) {
        elements.btnInstallUpdate.disabled = true;
      }
      const electronApi = getElectronApi();
      if (electronApi && electronApi.quitAndInstall) {
        electronApi.quitAndInstall();
      }
    }

    function scheduleSilentUpdateInstall(delayMs = 5000) {
      clearScheduledUpdateInstall();
      updateInstallTimer = setTimeout(() => {
        updateInstallTimer = null;
        requestQuitAndInstall();
      }, Math.max(0, Number(delayMs) || 0));
    }

    function scheduleUpdateModalAutoHide(delayMs = 1800) {
      clearUpdateModalAutoHide();
      updateModalAutoHideTimer = setTimeout(() => {
        if (elements.updateModal) {
          elements.updateModal.classList.add('hidden');
        }
        updateModalAutoHideTimer = null;
      }, delayMs);
    }

    function hideUpdateModal() {
      clearUpdateModalAutoHide();
      clearScheduledUpdateInstall();
      if (elements.updateModal) {
        elements.updateModal.classList.add('hidden');
      }
    }

    function rememberUpdateLogEntry(entry) {
      if (!entry) {
        return;
      }

      if (entry.path) {
        updateLogPath = entry.path;
      }

      updateLogEntries.push(entry);
      if (updateLogEntries.length > UPDATE_LOG_ENTRY_LIMIT) {
        updateLogEntries.shift();
      }

      const level = entry.level ? String(entry.level).toUpperCase() : 'INFO';
      debugLog('update', `[Updater:${level}]`, entry.message || entry.line || '');
    }

    function getRecentUpdateLogTail(limit = 5) {
      if (!updateLogEntries.length) {
        return '';
      }

      return updateLogEntries
        .slice(-limit)
        .map((entry) => entry.line || `[${entry.level || 'info'}] ${entry.message || ''}`)
        .join('\n');
    }

    function buildUpdateDiagnosticDetail(baseDetail, includeTail = false) {
      const sections = [];

      if (baseDetail) {
        sections.push(baseDetail);
      }

      if (updateLogPath) {
        sections.push(`日志文件：${updateLogPath}`);
      }

      if (includeTail) {
        const tail = getRecentUpdateLogTail();
        if (tail) {
          sections.push(`最近更新日志：\n${tail}`);
        }
      }

      return sections.join('\n\n');
    }

    function renderUpdateModal(renderOptions = {}) {
      const {
        title = '正在检查更新',
        step = '',
        detail = '',
        showProgress = true,
        indeterminate = false,
        progressPercent = 0,
        speedText = '0 MB/秒',
        transferredText = '0 / 0 MB',
        timeText = '剩余时间：计算中...',
        showCloseButton = false,
        closeLabel = '关闭',
        showInstallButton = false,
        installLabel = '立即安装'
      } = renderOptions;

      const normalizedPercent = Math.max(0, Math.min(100, Number(progressPercent) || 0));

      if (!elements.updateModal) {
        return;
      }
      elements.updateModal.classList.remove('hidden');
      elements.updateTitle.textContent = title;
      elements.updateStep.textContent = step;
      elements.updateDetail.textContent = detail;
      elements.updateProgressContainer.classList.toggle('hidden', !showProgress);
      elements.updateActions.classList.toggle('hidden', !showCloseButton && !showInstallButton);
      elements.btnCloseUpdate.classList.toggle('hidden', !showCloseButton);
      elements.btnCloseUpdate.textContent = closeLabel;
      elements.btnInstallUpdate.classList.toggle('hidden', !showInstallButton);
      elements.btnInstallUpdate.textContent = installLabel;
      elements.btnInstallUpdate.disabled = updateInstallRequested;
      elements.updateProgress.classList.toggle('indeterminate', indeterminate);
      elements.updateProgress.style.width = indeterminate ? '35%' : normalizedPercent + '%';
      elements.updatePercent.textContent = indeterminate ? '检查中' : normalizedPercent.toFixed(1) + '%';
      elements.updateSpeed.textContent = speedText;
      elements.updateTransferred.textContent = transferredText;
      elements.updateTime.textContent = timeText;
    }

    function applyUpdateStatus(status) {
      if (!status || typeof status !== 'object') {
        return;
      }
      if (updateReadyToInstall && status.status !== 'downloaded') {
        debugLog('update', 'Ignoring update status after downloaded:', status.status || 'unknown');
        return;
      }
      clearUpdateModalAutoHide();
      clearScheduledUpdateInstall();

      const activeVersion = status.currentVersion || currentVersion;
      const targetVersion = status.version || activeVersion;
      const feedUrl = status.feedUrl || getUpdateManifestUrl();

      if (status.status === 'checking') {
        updateReadyToInstall = false;
        updateDownloadRequested = false;
        renderUpdateModal({
          title: '正在检查更新',
          step: '第 1 步 / 共 3 步：连接更新源并比较版本',
          detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n更新源：${feedUrl}`),
          showProgress: true,
          indeterminate: true,
          speedText: '等待响应',
          transferredText: '清单文件：latest.yml',
          timeText: '正在请求更新元数据'
        });
        return;
      }

      if (status.status === 'available') {
        updateReadyToInstall = false;
        renderUpdateModal({
          title: `发现新版本：v${targetVersion}`,
          step: '第 2 步 / 共 3 步：已发现更新，开始下载',
          detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n最新版本：v${targetVersion}\n更新源：${feedUrl}`),
          showProgress: true,
          progressPercent: 0,
          speedText: '正在准备下载',
          transferredText: '0 / 待下载',
          timeText: '正在初始化下载'
        });

        const electronApi = getElectronApi();
        if (electronApi && electronApi.downloadUpdate && !updateDownloadRequested) {
          updateDownloadRequested = true;
          electronApi.downloadUpdate().then((started) => {
            if (started === false) {
              updateDownloadRequested = false;
            }
          }).catch((error) => {
            updateDownloadRequested = false;
            debugLog('update', 'Update download request failed:', error && error.message ? error.message : String(error));
          });
        }
        return;
      }

      if (status.status === 'downloading') {
        updateReadyToInstall = false;
        const percent = Number.isFinite(status.percent) ? status.percent : 0;
        const speed = formatBytes(status.bytesPerSecond);
        const transferred = formatBytes(status.transferred);
        const total = formatBytes(status.total);
        const remaining = status.remaining > 0 ? formatTime(status.remaining) : '计算中...';

        renderUpdateModal({
          title: '正在下载更新',
          step: `第 3 步 / 共 3 步：已下载 ${percent.toFixed(1)}%`,
          detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n更新源：${feedUrl}`),
          showProgress: true,
          progressPercent: percent,
          speedText: speed + '/秒',
          transferredText: `${transferred} / ${total}`,
          timeText: '剩余时间：' + remaining
        });
        return;
      }

      if (status.status === 'downloaded') {
        updateReadyToInstall = true;
        renderUpdateModal({
          title: `更新已下载：v${targetVersion}`,
          step: '下载完成，正在安装。',
          detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n待安装版本：v${targetVersion}`),
          showProgress: true,
          progressPercent: 100,
          speedText: '下载完成',
          transferredText: '100%',
          timeText: '即将自动重启并静默安装更新',
          showCloseButton: false,
          showInstallButton: false
        });
        scheduleSilentUpdateInstall(1200);
        return;
      }

      if (status.status === 'not-available') {
        updateReadyToInstall = false;
        updateDownloadRequested = false;
        renderUpdateModal({
          title: '当前已是最新版本',
          step: '版本比较完成',
          detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n更新源版本：v${targetVersion}\n未发现更高版本，此窗口将自动关闭。`),
          showProgress: false,
          showCloseButton: true
        });
        scheduleUpdateModalAutoHide(2000);
        return;
      }

      if (status.status === 'error') {
        updateReadyToInstall = false;
        updateDownloadRequested = false;
        renderUpdateModal({
          title: '检查更新失败',
          step: '无法完成本次更新检查',
          detail: buildUpdateDiagnosticDetail(`当前版本：v${activeVersion}\n更新源：${feedUrl}\n错误信息：${status.error || '未知错误'}`, true),
          showProgress: false,
          showCloseButton: true
        });
      }
    }

    async function initVersion() {
      const electronApi = getElectronApi();
      if (electronApi && electronApi.getAppVersion) {
        try {
          currentVersion = await electronApi.getAppVersion();
          debugLog('misc', 'App version:', currentVersion);
        } catch (error) {
          debugLog('misc', 'Failed to get app version:', error);
        }
      }
      return currentVersion;
    }

    async function checkForUpdates() {
      const electronApi = getElectronApi();
      if (!electronApi || !electronApi.checkForUpdates) {
        return null;
      }

      try {
        renderUpdateModal({
          title: '正在检查更新',
          step: '正在准备更新请求...',
          detail: buildUpdateDiagnosticDetail(`当前版本：v${currentVersion}\n更新源：${getUpdateManifestUrl()}`),
          showProgress: true,
          indeterminate: true,
          speedText: '等待响应',
          transferredText: '清单文件：latest.yml',
          timeText: '正在请求更新元数据'
        });

        debugLog('update', 'Checking for updates...');
        const result = await electronApi.checkForUpdates();

        if (result && result.devMode) {
          hideUpdateModal();
        }

        return result;
      } catch (error) {
        debugLog('update', 'Update check failed:', error.message);
        applyUpdateStatus({
          status: 'error',
          currentVersion,
          feedUrl: getUpdateManifestUrl(),
          error: error.message
        });
        return null;
      }
    }

    function registerUpdateStatusListener() {
      const electronApi = getElectronApi();
      if (updateStatusUnsubscribe || !electronApi || !electronApi.onUpdateStatus) {
        return;
      }

      updateStatusUnsubscribe = electronApi.onUpdateStatus((status) => {
        debugLog('update', 'Update status:', status);
        applyUpdateStatus(status);
      });
    }

    async function registerUpdateLogListener() {
      const electronApi = getElectronApi();
      if (!electronApi) {
        return;
      }

      if (typeof electronApi.getUpdateLogSnapshot === 'function') {
        try {
          const snapshot = await electronApi.getUpdateLogSnapshot();
          updateLogPath = snapshot && snapshot.path ? snapshot.path : updateLogPath;

          if (snapshot && Array.isArray(snapshot.entries)) {
            snapshot.entries.forEach(rememberUpdateLogEntry);
          }
        } catch (error) {
          debugLog('update', 'Unable to load updater log snapshot:', error.message);
        }
      }

      if (updateLogUnsubscribe || !electronApi.onUpdateLog) {
        return;
      }

      updateLogUnsubscribe = electronApi.onUpdateLog((entry) => {
        rememberUpdateLogEntry(entry);
      });
    }

    function initializeStartupTasks() {
      const electronApi = getElectronApi();
      if (!electronApi) {
        return Promise.resolve();
      }

      return (async () => {
        await registerUpdateLogListener();
        registerUpdateStatusListener();

        if (electronApi.getAppVersion) {
          await initVersion();
        }

        if (!updateCheckStarted && electronApi.checkForUpdates) {
          updateCheckStarted = true;
          await checkForUpdates();
        }
      })();
    }

    return {
      applyUpdateStatus,
      checkForUpdates,
      getCurrentVersion() {
        return currentVersion;
      },
      getUpdateManifestUrl,
      hideUpdateModal,
      initVersion,
      initializeStartupTasks,
      registerUpdateLogListener,
      registerUpdateStatusListener,
      renderUpdateModal,
      requestQuitAndInstall
    };
  }

  VDS.updateUi = {
    createController,
    formatBytes,
    formatTime
  };
})();
