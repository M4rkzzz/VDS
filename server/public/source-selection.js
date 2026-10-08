(function () {
  const VDS = window.VDS = window.VDS || {};

  function createController(options = {}) {
    const elements = options.elements || {};
    const showError = typeof options.showError === 'function' ? options.showError : function () {};
    const debugLog = typeof options.debugLog === 'function' ? options.debugLog : function () {};
    const getMediaEngine = typeof options.getMediaEngine === 'function' ? options.getMediaEngine : function () { return null; };
    const startScreenShareWithSource = typeof options.startScreenShareWithSource === 'function'
      ? options.startScreenShareWithSource
      : async function () { throw new Error('start-screen-share-with-source-unavailable'); };
    const startScreenShareWithAudio = typeof options.startScreenShareWithAudio === 'function'
      ? options.startScreenShareWithAudio
      : async function () { throw new Error('start-screen-share-with-audio-unavailable'); };
    const resetShareStartPendingUi = typeof options.resetShareStartPendingUi === 'function'
      ? options.resetShareStartPendingUi
      : function () {};
    const markShareStartInFlight = typeof options.markShareStartInFlight === 'function'
      ? options.markShareStartInFlight
      : function () {};

    let sourceSelectionInFlight = false;
    let sourceListRefreshSeq = 0;
    let sourceListRefreshInFlight = false;
    let sourceConfirmInFlight = false;
    let sourceAudioSelectionSeq = 0;
    let currentCaptureSource = null;
    let sourceAudioEnabledState = null;
    let audioDiscovery = { status: 'idle', processes: [], error: null, supported: null, promise: null };

    function getSourceModal() {
      return document.getElementById('source-modal');
    }

    function getSourceList() {
      return document.getElementById('source-list');
    }

    function getRuntimeMediaEngine() {
      const mediaEngine = getMediaEngine();
      if (!mediaEngine) {
        throw new Error('native-electron-runtime-required');
      }
      return mediaEngine;
    }

    function resetPendingUi() {
      sourceConfirmInFlight = false;
      sourceAudioSelectionSeq += 1;
      if (elements.btnConfirmSource) {
        elements.btnConfirmSource.disabled = sourceListRefreshInFlight;
      }
      if (elements.btnRefreshSources) {
        elements.btnRefreshSources.disabled = sourceListRefreshInFlight;
      }
    }

    async function showSourceSelection() {
      if (sourceSelectionInFlight) {
        return;
      }
      const refreshSeq = sourceListRefreshSeq + 1;
      sourceListRefreshSeq = refreshSeq;
      sourceAudioSelectionSeq += 1;

      sourceSelectionInFlight = true;
      if (elements.btnConfirmQuality) {
        elements.btnConfirmQuality.disabled = true;
      }

      try {
        const mediaEngine = getRuntimeMediaEngine();
        debugLog('video', 'Getting capture targets for selection...');
        const sources = await mediaEngine.listCaptureTargets();
        if (refreshSeq !== sourceListRefreshSeq || sourceConfirmInFlight) {
          return;
        }

        if (!sources || sources.length === 0) {
          throw new Error('No capture target available');
        }

        showSourceModal(sources);
      } catch (error) {
        if (refreshSeq !== sourceListRefreshSeq || sourceConfirmInFlight) {
          return;
        }
        debugLog('video', 'Error loading sources:', error && error.message ? error.message : String(error));
        showError('Failed to list capture targets: ' + (error && error.message ? error.message : String(error)));
        resetShareStartPendingUi();
      } finally {
        sourceSelectionInFlight = false;
        if (elements.btnConfirmQuality) {
          elements.btnConfirmQuality.disabled = false;
        }
      }
    }

    async function refreshSources() {
      const btn = elements.btnRefreshSources;
      if (sourceListRefreshInFlight) {
        return;
      }
      resetPendingUi();
      const refreshSeq = sourceListRefreshSeq + 1;
      sourceListRefreshSeq = refreshSeq;
      sourceAudioSelectionSeq += 1;
      sourceListRefreshInFlight = true;
      try {
        debugLog('video', 'Refreshing source list...');
        if (btn) {
          btn.style.animation = 'spin 1s linear infinite';
          btn.disabled = true;
        }
        if (elements.btnConfirmSource) {
          elements.btnConfirmSource.disabled = true;
        }

        let sources = [];
        const mediaEngine = getMediaEngine();
        if (mediaEngine && typeof mediaEngine.listCaptureTargets === 'function') {
          sources = await mediaEngine.listCaptureTargets();
        }
        if (refreshSeq !== sourceListRefreshSeq || sourceConfirmInFlight) {
          return;
        }

        if (!sources || sources.length === 0) {
          showError('没有找到可用的屏幕源');
        } else {
          showSourceModal(sources);
        }
      } catch (error) {
        if (refreshSeq !== sourceListRefreshSeq || sourceConfirmInFlight) {
          return;
        }
        debugLog('video', 'Error refreshing sources:', error && error.message ? error.message : String(error));
        showError('刷新失败: ' + (error && error.message ? error.message : String(error)));
      } finally {
        if (refreshSeq === sourceListRefreshSeq) {
          sourceListRefreshInFlight = false;
          if (btn) {
            btn.style.animation = '';
            btn.disabled = sourceConfirmInFlight;
          }
          if (elements.btnConfirmSource) {
            elements.btnConfirmSource.disabled = sourceConfirmInFlight;
          }
        }
      }
    }

    function parseSelectedSourceAudioCandidates(selectedItem) {
      if (!selectedItem || !selectedItem.dataset.audioCandidates) {
        return [];
      }

      try {
        const parsed = JSON.parse(selectedItem.dataset.audioCandidates);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_error) {
        return [];
      }
    }

    function withClientTimeout(promise, timeoutMs, timeoutMessage) {
      const normalizedTimeout = Number(timeoutMs);
      if (!Number.isFinite(normalizedTimeout) || normalizedTimeout <= 0) {
        return promise;
      }

      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(timeoutMessage || 'operation-timeout')), normalizedTimeout);
        })
      ]).finally(() => clearTimeout(timer));
    }

    function normalizeAudioProcessMatchValue(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/\.exe$/i, '')
        .replace(/\[[^\]]+\]/g, ' ')
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
        .trim();
    }

    function buildClientAudioCandidate(processInfo, confidence, reason) {
      const pid = Number(processInfo && processInfo.pid);
      const normalizedPid = Number.isFinite(pid) && pid > 0 ? pid : null;
      const processName = String(processInfo && processInfo.name ? processInfo.name : `PID ${normalizedPid || 'unknown'}`);

      return {
        id: normalizedPid ? `process:${normalizedPid}` : `process:${processName}`,
        mode: 'process',
        pid: normalizedPid,
        processName,
        confidence,
        reason
      };
    }

    function matchAudioCandidatesForSource(source, processList) {
      const processes = Array.isArray(processList) ? processList : [];
      if (!source || audioDiscovery.supported === false) {
        return [];
      }
      const candidates = [];
      const seenPids = new Set();
      const isDisplay = source.kind === 'display' || source.captureMode === 'display' || String(source.id || '').startsWith('screen:');
      const sourcePid = Number(source.pid);
      const normalizedPid = Number.isFinite(sourcePid) && sourcePid > 0 ? sourcePid : null;
      if (!isDisplay && normalizedPid) {
        const exact = processes.find(processInfo => Number(processInfo && processInfo.pid) === normalizedPid);
        candidates.push(buildClientAudioCandidate(exact || {
          pid: normalizedPid, name: source.appName || source.title || source.name
        }, 1, 'window-process-tree'));
        seenPids.add(normalizedPid);
      }
      const normalizedTitle = normalizeAudioProcessMatchValue(source.title || source.name || '');
      const related = [];
      const others = [];
      for (const processInfo of processes) {
        const pid = Number(processInfo && processInfo.pid);
        if (!Number.isFinite(pid) || pid <= 0 || seenPids.has(pid)) continue;
        seenPids.add(pid);
        const processToken = normalizeAudioProcessMatchValue(processInfo && processInfo.name);
        const matchesTitle = !isDisplay && normalizedTitle && processToken &&
          (normalizedTitle.includes(processToken) || processToken.includes(normalizedTitle));
        (matchesTitle ? related : others).push(buildClientAudioCandidate(processInfo,
          matchesTitle ? 0.35 : 0, matchesTitle ? 'window-title-match' : 'active-audio-process'));
      }
      return candidates.concat(related, others);
    }

    function refreshAudioCandidates() {
      document.querySelectorAll('.source-item').forEach(item => {
        const source = item.__captureSource;
        const previous = parseSelectedSourceAudioCandidates(item)[Number(item.dataset.audioIndex)];
        const candidates = matchAudioCandidatesForSource(source, audioDiscovery.processes);
        let index = previous ? candidates.findIndex(candidate => candidate.pid === previous.pid) : -1;
        if (index < 0) index = candidates.findIndex(candidate => candidate.reason === 'window-process-tree');
        item.dataset.audioCandidates = JSON.stringify(candidates);
        item.dataset.audioIndex = String(index);
      });
    }

    function ensureAudioDiscovery() {
      if (audioDiscovery.promise) return audioDiscovery.promise;
      const discovery = audioDiscovery;
      discovery.status = 'loading';
      discovery.promise = (async () => {
        try {
          const mediaEngine = getMediaEngine();
          const audioApi = mediaEngine && mediaEngine.audio;
          if (!audioApi || !audioApi.isPlatformSupported || !audioApi.checkPermission || !audioApi.getProcessList) {
            throw new Error('audio-discovery-unavailable');
          }
          discovery.supported = Boolean(await withClientTimeout(audioApi.isPlatformSupported(), 1500, 'audio-platform-probe-timeout'));
          if (discovery.supported) {
            const permission = await withClientTimeout(audioApi.checkPermission(), 1500, 'audio-permission-probe-timeout');
            const status = String(permission && permission.status || 'unknown');
            if (status !== 'authorized') throw new Error(`audio-permission-${status}`);
            const processes = await withClientTimeout(audioApi.getProcessList(), 2500, 'audio-process-list-timeout');
            if (!Array.isArray(processes)) throw new Error('audio-process-list-invalid');
            discovery.processes = processes;
          }
          discovery.status = 'ready';
        } catch (error) {
          discovery.status = 'error';
          discovery.error = error && error.message ? error.message : String(error);
          debugLog('audio', '[source-audio] audio discovery failed:', discovery.error);
        }
        if (discovery === audioDiscovery) {
          refreshAudioCandidates();
          updateSourceAudioUi();
        }
        return discovery;
      })();
      return discovery.promise;
    }

    function createSourceThumbnailPlaceholder() {
      const placeholder = document.createElement('div');
      placeholder.className = 'source-thumbnail-placeholder';
      placeholder.textContent = '加载缩略图';
      return placeholder;
    }

    async function loadSourceThumbnailForItem(item, source, generation) {
      const mediaEngine = getMediaEngine();
      if (!item || !source || !source.id || !mediaEngine || typeof mediaEngine.getCaptureTargetThumbnail !== 'function') {
        return;
      }
      if (source.thumbnail || source.isSynthetic || source.isMinimized) {
        return;
      }
      try {
        const result = await withClientTimeout(
          mediaEngine.getCaptureTargetThumbnail({
            sourceId: source.id,
            hwnd: source.hwnd || '',
            title: source.title || source.name || '',
            kind: source.kind || source.captureMode || ''
          }),
          2200,
          'capture-target-thumbnail-timeout'
        );
        if (generation !== sourceListRefreshSeq || sourceConfirmInFlight || !item.isConnected) {
          return;
        }
        if (!result || !result.thumbnail) {
          const placeholder = item.querySelector('.source-thumbnail-placeholder');
          if (placeholder) {
            placeholder.textContent = '无缩略图';
          }
          return false;
        }
        source.thumbnail = String(result.thumbnail);
        if (item.__captureSource && typeof item.__captureSource === 'object') {
          item.__captureSource.thumbnail = source.thumbnail;
        }
        const img = document.createElement('img');
        img.src = source.thumbnail;
        img.alt = '';
        const existing = item.querySelector('img, .source-thumbnail-placeholder');
        if (existing) {
          existing.replaceWith(img);
        } else {
          item.insertBefore(img, item.firstChild);
        }
        return true;
      } catch (error) {
        debugLog('video', '[source-thumbnail] async thumbnail failed:', error && error.message ? error.message : String(error));
        if (generation === sourceListRefreshSeq && item.isConnected) {
          const placeholder = item.querySelector('.source-thumbnail-placeholder');
          if (placeholder) {
            placeholder.textContent = '无缩略图';
          }
        }
        return false;
      }
    }

    function startAsyncThumbnailLoading(generation) {
      const mediaEngine = getMediaEngine();
      if (!mediaEngine || typeof mediaEngine.getCaptureTargetThumbnail !== 'function') {
        return;
      }
      const entries = Array.from(document.querySelectorAll('.source-item'))
        .map((item) => ({ item, source: item.__captureSource }))
        .filter((entry) => entry.source && !entry.source.thumbnail && !entry.source.isSynthetic && !entry.source.isMinimized);
      if (!entries.length) {
        return;
      }
      debugLog('video', '[source-thumbnail] async thumbnail loading start:', {
        queued: entries.length,
        concurrent: Math.min(2, entries.length)
      });
      const stats = { ready: 0, unavailable: 0 };
      const queue = entries.slice();
      const workerCount = Math.min(2, queue.length);
      const workers = [];
      for (let index = 0; index < workerCount; index += 1) {
        workers.push((async () => {
          while (queue.length && generation === sourceListRefreshSeq && !sourceConfirmInFlight) {
            const next = queue.shift();
            const loaded = await loadSourceThumbnailForItem(next.item, next.source, generation);
            if (loaded) {
              stats.ready += 1;
            } else {
              stats.unavailable += 1;
            }
          }
        })().catch((error) => {
          debugLog('video', '[source-thumbnail] worker failed:', error && error.message ? error.message : String(error));
        }));
      }
      Promise.all(workers).then(() => {
        if (generation === sourceListRefreshSeq && !sourceConfirmInFlight) {
          debugLog('video', '[source-thumbnail] async thumbnail loading done:', stats);
        }
      }).catch(() => {});
    }

    function getSelectedSourceItem() {
      return document.querySelector('.source-item.selected');
    }

    function getSelectedCaptureSource() {
      const selectedItem = getSelectedSourceItem();
      if (!selectedItem) {
        return null;
      }

      if (selectedItem.__captureSource && typeof selectedItem.__captureSource === 'object') {
        return selectedItem.__captureSource;
      }

      const sourceId = selectedItem.dataset.id ? String(selectedItem.dataset.id).trim() : '';
      if (!sourceId) {
        return null;
      }

      return {
        id: sourceId,
        sourceId,
        title: selectedItem.dataset.name || '',
        name: selectedItem.dataset.name || '',
        displayId: selectedItem.dataset.displayId || null,
        nativeMonitorIndex: selectedItem.dataset.nativeMonitorIndex || null,
        hwnd: selectedItem.dataset.hwnd || null,
        pid: selectedItem.dataset.pid ? Number(selectedItem.dataset.pid) : null,
        state: selectedItem.dataset.state || 'normal',
        isMinimized: selectedItem.dataset.isMinimized === 'true'
      };
    }

    function updateSourceAudioUi() {
      const selectedItem = getSelectedSourceItem();
      const candidates = parseSelectedSourceAudioCandidates(selectedItem);
      const selectedIndex = selectedItem ? Number(selectedItem.dataset.audioIndex) : -1;
      const selectedCandidate = candidates[selectedIndex] || null;
      const audioEnabled = Boolean(elements.sourceAudioEnabled && elements.sourceAudioEnabled.checked);
      if (sourceAudioEnabledState !== null && sourceAudioEnabledState !== audioEnabled) resetPendingUi();
      sourceAudioEnabledState = audioEnabled;
      if (selectedItem && audioEnabled && audioDiscovery.status === 'idle') ensureAudioDiscovery();
      const shouldShowCandidateList = audioEnabled && candidates.length > 0;

      if (elements.sourceAudioProcessList) {
        elements.sourceAudioProcessList.innerHTML = '';
        if (shouldShowCandidateList) {
          candidates.forEach((candidate, index) => {
            const row = document.createElement('div');
            row.className = `source-audio-process-item${index === selectedIndex ? ' selected' : ''}`;
            row.textContent = `${candidate.processName || 'PID'} (${candidate.pid || 'n/a'})`;
            row.tabIndex = 0;
            row.addEventListener('click', () => {
              if (!selectedItem) {
                return;
              }
              resetPendingUi();
              selectedItem.dataset.audioIndex = String(index);
              updateSourceAudioUi();
              debugLog('audio', '[source-audio] selected candidate:', candidate.processName || candidate.pid || 'n/a');
            });
            row.addEventListener('keydown', (event) => {
              if (!event || (event.key !== 'Enter' && event.key !== ' ')) {
                return;
              }
              event.preventDefault();
              row.click();
            });
            elements.sourceAudioProcessList.appendChild(row);
          });
        }
        elements.sourceAudioProcessList.classList.toggle('hidden', !shouldShowCandidateList);
      }

      if (!elements.sourceAudioSummary) {
        return;
      }

      if (!audioEnabled) {
        elements.sourceAudioSummary.textContent = '当前仅共享画面';
        return;
      }
      const selectedText = selectedCandidate
        ? `当前音频目标: ${selectedCandidate.processName || 'PID'} (${selectedCandidate.pid})`
        : '';
      if (audioDiscovery.status === 'loading') {
        elements.sourceAudioSummary.textContent = selectedText ? `${selectedText} · 正在检测其他音频进程…` : '正在检测音频进程…';
        return;
      }
      if (audioDiscovery.status === 'error') {
        elements.sourceAudioSummary.textContent = `音频进程检测失败: ${audioDiscovery.error}${selectedText ? ` · ${selectedText}` : ' · 可关闭音频继续共享画面'}`;
        return;
      }
      if (audioDiscovery.supported === false) {
        elements.sourceAudioSummary.textContent = '当前平台不支持进程音频，可继续共享画面';
        return;
      }
      if (selectedText) {
        elements.sourceAudioSummary.textContent = `${selectedText}${selectedCandidate.reason === 'window-process-tree' ? ' · 包含其子进程' : ''}`;
      } else {
        elements.sourceAudioSummary.textContent = candidates.length
          ? '请选择要共享的音频进程，未选择时仅共享画面'
          : '当前没有活跃音频进程，可继续共享画面';
      }
    }

    function showSourceModal(sources) {
      const modal = getSourceModal();
      const sourceList = getSourceList();
      if (!modal || !sourceList) {
        throw new Error('source-modal-unavailable');
      }

      resetPendingUi();
      currentCaptureSource = null;
      sourceList.innerHTML = '';
      audioDiscovery = { status: 'idle', processes: [], error: null, supported: null, promise: null };
      sourceAudioEnabledState = null;

      sources.forEach((source, index) => {
        const item = document.createElement('div');
        item.className = 'source-item';
        item.dataset.id = source.id;
        item.dataset.name = source.title || source.name || '';
        item.dataset.displayId = source.displayId != null ? String(source.displayId) : '';
        item.dataset.nativeMonitorIndex = source.nativeMonitorIndex != null ? String(source.nativeMonitorIndex) : '';
        item.dataset.hwnd = source.hwnd != null ? String(source.hwnd) : '';
        item.dataset.pid = source.pid != null ? String(source.pid) : '';
        item.dataset.state = source.state || 'normal';
        item.dataset.isMinimized = source.isMinimized ? 'true' : 'false';
        item.dataset.audioCandidates = JSON.stringify(Array.isArray(source.audioCandidates) ? source.audioCandidates : []);
        item.dataset.audioIndex = '-1';
        item.__captureSource = source;

        if (source.thumbnail) {
          const img = document.createElement('img');
          img.src = source.thumbnail;
          item.appendChild(img);
        } else {
          item.appendChild(createSourceThumbnailPlaceholder());
        }

        const name = document.createElement('p');
        name.className = 'source-item-title';
        name.textContent = source.title || source.name || '';
        item.appendChild(name);

        const subtitle = document.createElement('p');
        subtitle.className = 'source-item-subtitle';
        subtitle.textContent = buildCaptureSourceSubtitle(source);
        item.appendChild(subtitle);

        const status = buildCaptureSourceStatus(source);
        if (status) {
          const statusText = document.createElement('p');
          statusText.className = 'source-item-status';
          statusText.textContent = status;
          item.appendChild(statusText);
        }

        item.addEventListener('click', () => {
          resetPendingUi();
          document.querySelectorAll('.source-item').forEach((element) => element.classList.remove('selected'));
          item.classList.add('selected');
          updateSourceAudioUi();
        });

        sourceList.appendChild(item);

        if (index === 0) {
          item.classList.add('selected');
        }
      });

      if (elements.sourceAudioEnabled) {
        elements.sourceAudioEnabled.checked = true;
      }
      modal.classList.remove('hidden');
      refreshAudioCandidates();
      updateSourceAudioUi();
      startAsyncThumbnailLoading(sourceListRefreshSeq);
    }

    function buildCaptureSourceSubtitle(source) {
      const parts = [];
      const kindLabel = source && source.kind === 'display' ? '显示器' : '窗口';
      parts.push(kindLabel);

      if (source && source.kind === 'display') {
        const displayIndex = Number(source.nativeMonitorIndex);
        if (Number.isFinite(displayIndex) && displayIndex >= 0) {
          parts.push(`屏幕 ${displayIndex + 1}`);
        } else if (source.displayId != null && String(source.displayId).trim()) {
          parts.push(`显示器 ${source.displayId}`);
        }
      } else {
        const label = source && source.appName
          ? String(source.appName)
          : (source && source.title ? String(source.title) : '');
        if (label) {
          parts.push(label);
        }
      }

      return parts.join(' · ');
    }

    function buildCaptureSourceStatus(source) {
      if (!source) {
        return '';
      }
      if (source.state === 'minimized') {
        return '已最小化';
      }
      if (source.state === 'exclusive-fullscreen') {
        return '独占全屏';
      }
      return '';
    }

    async function confirmSourceAndShare() {
      if (sourceConfirmInFlight) {
        return;
      }
      const selectedSource = getSelectedCaptureSource();
      if (!selectedSource) {
        showError('Please select a capture target');
        return;
      }
      sourceConfirmInFlight = true;
      const selectionSeq = sourceAudioSelectionSeq;
      if (elements.btnConfirmSource) {
        elements.btnConfirmSource.disabled = true;
      }

      currentCaptureSource = selectedSource;
      try {
        await showAudioProcessSelection(selectionSeq, selectedSource);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (message === 'source-audio-selection-superseded') {
          debugLog('audio', '[source-audio] selection superseded before share start');
          return;
        }
        resetShareStartPendingUi();
        debugLog('video', 'Failed to start native share session:', message);
        showError(message || 'failed-to-start-native-share');
      } finally {
        if (selectionSeq === sourceAudioSelectionSeq) resetPendingUi();
      }
    }

    async function showAudioProcessSelection(selectionSeq, selectedSource) {
      const selectedItem = getSelectedSourceItem();
      const selectedSourceId = String(selectedSource.id || '');
      const audioEnabled = Boolean(elements.sourceAudioEnabled && elements.sourceAudioEnabled.checked);
      let audioCandidates = parseSelectedSourceAudioCandidates(selectedItem);
      let waitedForDiscovery = false;
      if (audioEnabled && !audioCandidates.length) {
        waitedForDiscovery = audioDiscovery.status === 'idle' || audioDiscovery.status === 'loading';
        await ensureAudioDiscovery();
        audioCandidates = parseSelectedSourceAudioCandidates(selectedItem);
      }
      const currentSource = getSelectedCaptureSource();
      if (selectionSeq !== sourceAudioSelectionSeq || !currentSource || String(currentSource.id || '') !== selectedSourceId) {
        throw new Error('source-audio-selection-superseded');
      }
      const audioIndex = selectedItem ? Number(selectedItem.dataset.audioIndex) : -1;
      const audioCandidate = audioCandidates[audioIndex] || null;
      if (waitedForDiscovery && audioCandidates.length && !audioCandidate) {
        showError('已检测到音频进程，请选择音频目标，或关闭音频仅共享画面');
        return;
      }
      markShareStartInFlight();
      sourceListRefreshSeq += 1;
      const modal = getSourceModal();
      if (modal) modal.classList.add('hidden');
      if (audioEnabled && audioCandidate && audioCandidate.pid) {
        await startScreenShareWithAudio(selectedSource, Number(audioCandidate.pid));
      } else {
        if (audioEnabled) showError(audioDiscovery.status === 'error'
          ? `音频进程检测失败: ${audioDiscovery.error}，将仅共享画面`
          : '未选择音频进程，将仅共享画面');
        await startScreenShareWithSource(selectedSource);
      }
    }

    function cancelSourceSelection() {
      sourceListRefreshSeq += 1;
      sourceListRefreshInFlight = false;
      if (elements.btnRefreshSources) elements.btnRefreshSources.style.animation = '';
      resetPendingUi();
      audioDiscovery = { status: 'idle', processes: [], error: null, supported: null, promise: null };
      currentCaptureSource = null;
      resetShareStartPendingUi();
      const modal = getSourceModal();
      if (modal) {
        modal.classList.add('hidden');
      }
    }

    function getSnapshot() {
      return {
        sourceSelectionInFlight,
        sourceListRefreshInFlight,
        sourceConfirmInFlight,
        currentCaptureSource,
        audioDiscoveryStatus: audioDiscovery.status,
        audioDiscoveryError: audioDiscovery.error
      };
    }

    return {
      showSourceSelection,
      refreshSources,
      showSourceModal,
      confirmSourceAndShare,
      cancelSourceSelection,
      updateSourceAudioUi,
      resetPendingUi,
      getSnapshot
    };
  }

  VDS.sourceSelection = {
    createController
  };
})();
