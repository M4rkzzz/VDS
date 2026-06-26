(function () {
  const VDS = window.VDS = window.VDS || {};

  if (VDS.nativeStats) {
    return;
  }

  function callOptional(options, name, ...args) {
    if (options && typeof options[name] === 'function') {
      return options[name](...args);
    }
    return undefined;
  }

  function setText(element, text) {
    if (element) {
      element.textContent = text;
    }
  }

  function setHidden(element, hidden) {
    if (element) {
      element.classList.toggle('hidden', Boolean(hidden));
    }
  }

  function setWaiting(element, waiting) {
    if (element) {
      element.classList.toggle('waiting', Boolean(waiting));
    }
  }

  function formatFps(value) {
    return Number.isFinite(value) ? `${value} fps` : '-';
  }

  function createController(options = {}) {
    const mediaEngine = options.mediaEngine;
    const diagnostics = options.diagnostics;
    const elements = options.elements || {};
    const nativeSessionState = options.nativeSessionState;
    const viewerControls = options.viewerControls;
    const p2pStateMachine = options.p2pStateMachine;
    const roomClient = options.roomClient || null;

    if (!mediaEngine || !diagnostics || !nativeSessionState) {
      throw new Error('native-stats-controller-missing-dependency');
    }

    function renderP2pDiagnosticReport() {
      callOptional(options, 'renderP2pDiagnosticReport');
    }

    function renderHostCaptureDiagnosticReport() {
      callOptional(options, 'renderHostCaptureDiagnosticReport');
    }

    function sendViewerReady(optionsForReady = {}) {
      if (roomClient && typeof roomClient.sendViewerReady === 'function') {
        return roomClient.sendViewerReady(optionsForReady);
      }
      throw new Error('room-client-viewer-ready-unavailable');
    }

    function isObsIngestHostBackend() {
      return Boolean(callOptional(options, 'isObsIngestHostBackend'));
    }

    function stopViewerStatsPolling() {
      diagnostics.stopStatsPolling('viewer', {
        onStop: renderP2pDiagnosticReport
      });
    }

    function resetHostFpsIndicators() {
      diagnostics.resetHostFpsSample();
      setText(elements.hostSourceFps, '-');
      setText(elements.hostCaptureFps, '-');
      setText(elements.hostSendFps, '-');
    }

    function updateHostFpsIndicators(sourceFrames, previewFrames, sentFrames) {
      const fpsSnapshot = diagnostics.updateHostFpsSample(sourceFrames, previewFrames, sentFrames) || {
        sourceFps: '-',
        previewFps: '-',
        sendFps: '-'
      };
      setText(elements.hostSourceFps, formatFps(fpsSnapshot.sourceFps));
      setText(elements.hostCaptureFps, formatFps(fpsSnapshot.previewFps));
      setText(elements.hostSendFps, formatFps(fpsSnapshot.sendFps));
      return fpsSnapshot;
    }

    function resetViewerFpsIndicator() {
      diagnostics.resetViewerFpsSample();
      setText(elements.viewerReceiveFps, '-');
      setText(elements.viewerRenderFps, '-');
    }

    function updateViewerFpsIndicator(receivedFrames, renderedFrames) {
      if ((!elements.viewerReceiveFps && !elements.viewerRenderFps) ||
          !Number.isFinite(receivedFrames) ||
          !Number.isFinite(renderedFrames) ||
          receivedFrames < 0 ||
          renderedFrames < 0) {
        return null;
      }

      const fpsSnapshot = diagnostics.updateViewerFpsSample(receivedFrames, renderedFrames);
      if (!fpsSnapshot) {
        return null;
      }
      setText(elements.viewerReceiveFps, formatFps(fpsSnapshot.receiveFps));
      setText(elements.viewerRenderFps, formatFps(fpsSnapshot.renderFps));
      return fpsSnapshot;
    }

    function stopHostStatsPolling() {
      diagnostics.stopStatsPolling('host', {
        onStop: renderP2pDiagnosticReport
      });
    }

    function updateHostEncoderDetail(pipeline, obsIngest = null) {
      if (!elements.hostStatusDetail) {
        return;
      }

      if (isObsIngestHostBackend()) {
        const parts = [];
        if (obsIngest && Number.isFinite(obsIngest.port) && obsIngest.port > 0) {
          parts.push(`SRT：127.0.0.1:${obsIngest.port}`);
        }
        if (obsIngest && obsIngest.videoCodec) {
          const videoBits = [String(obsIngest.videoCodec).toUpperCase()];
          if (Number.isFinite(obsIngest.width) && obsIngest.width > 0 && Number.isFinite(obsIngest.height) && obsIngest.height > 0) {
            videoBits.push(`${obsIngest.width}x${obsIngest.height}`);
          }
          if (Number.isFinite(obsIngest.frameRate) && obsIngest.frameRate > 0) {
            videoBits.push(`${obsIngest.frameRate}fps`);
          }
          parts.push(videoBits.join(' '));
        }
        if (obsIngest && obsIngest.audioCodec) {
          parts.push(`音频：${String(obsIngest.audioCodec).toUpperCase()}`);
        }

        if (parts.length === 0) {
          setText(elements.hostStatusDetail, '');
          setHidden(elements.hostStatusDetail, true);
          return;
        }

        setText(elements.hostStatusDetail, parts.join(' · '));
        setHidden(elements.hostStatusDetail, false);
        return;
      }

      const encoder = pipeline && pipeline.selectedVideoEncoder
        ? String(pipeline.selectedVideoEncoder).trim()
        : '';
      if (!encoder) {
        setText(elements.hostStatusDetail, '');
        setHidden(elements.hostStatusDetail, true);
        return;
      }

      setText(elements.hostStatusDetail, `编码器：${encoder}`);
      setHidden(elements.hostStatusDetail, false);
    }

    async function pollHostStats(reason = 'periodic') {
      if (!callOptional(options, 'isNativeHostSessionRunning') || !callOptional(options, 'isHost')) {
        return null;
      }

      try {
        const stats = await mediaEngine.getStats({});
        diagnostics.setLatestP2pStatsSnapshot(stats);
        nativeSessionState.setCurrentHostBackend(stats && stats.hostBackend ? stats.hostBackend : nativeSessionState.getCurrentHostBackend());
        const hostStatsSummary = diagnostics.buildHostStatsSummary(stats, {
          reason,
          obsIngestHostBackend: isObsIngestHostBackend(),
          currentHostBackend: nativeSessionState.getCurrentHostBackend()
        });
        const {
          hostPlan,
          hostPipeline,
          obsIngest,
          sourceFrames,
          captureFrames,
          sentFrames
        } = hostStatsSummary;

        updateHostEncoderDetail(hostPipeline, obsIngest);
        const hostFpsSnapshot = updateHostFpsIndicators(sourceFrames, captureFrames, sentFrames) || {};
        diagnostics.setLatestHostCaptureDiagnosticReport(
          diagnostics.buildHostCaptureDiagnosticReportFromStats(stats, hostFpsSnapshot, {
            currentHostBackend: nativeSessionState.getCurrentHostBackend()
          })
        );
        renderHostCaptureDiagnosticReport();
        if (isObsIngestHostBackend()) {
          if (obsIngest && obsIngest.waiting) {
            setText(elements.hostStatus, '等待 OBS 推流...');
            setWaiting(elements.hostStatus, true);
          } else if (obsIngest && obsIngest.ingestConnected && !obsIngest.streamRunning) {
            setText(elements.hostStatus, 'OBS 已连接，等待有效节目流...');
            setWaiting(elements.hostStatus, true);
          } else if (callOptional(options, 'getCurrentRoomId')) {
            setText(elements.hostStatus, '正在共享（OBS）');
            setWaiting(elements.hostStatus, false);
          }
        } else if (hostPlan && hostPlan.captureState === 'minimized') {
          callOptional(options, 'syncHostWaitingWindowRestoreUi', true);
        } else if (callOptional(options, 'isHostWaitingWindowRestore')) {
          callOptional(
            options,
            'syncHostWaitingWindowRestoreUi',
            false,
            callOptional(options, 'getCurrentRoomId') ? '原生分享已恢复' : `正在共享（原生，${String(callOptional(options, 'getNativeHostEffectiveCodec') || 'h264').toUpperCase()}）`
          );
        }

        if (diagnostics.shouldShowDebugLogsFor('video', 'periodicStats')) {
          const rate = diagnostics.shouldEmitNativeDebugLog(`stats:host:${reason}`, reason === 'initial' ? 0 : 5000);
          if (rate.emit) {
            diagnostics.logNativeStatsLine('[media-engine native-host-stats]', hostStatsSummary.logFields, rate.suppressed);
          }
        }

        renderP2pDiagnosticReport();
        return stats;
      } catch (error) {
        diagnostics.logRecoverableNativeWarning('native-host-stats:failed', error, {
          key: 'native-host-stats',
          category: 'video',
          channel: 'periodicStats',
          fallbackLabel: '[media-engine native-host-stats] failed:'
        });
        return null;
      }
    }

    function startHostStatsPolling() {
      diagnostics.startStatsPolling('host', {
        onStart: resetHostFpsIndicators,
        onStop: renderP2pDiagnosticReport,
        shouldContinue: () => Boolean(callOptional(options, 'isNativeHostSessionRunning') && callOptional(options, 'isHost')),
        onTick: (reason) => pollHostStats(reason)
      });
    }

    function applyViewerMediaReadyState() {
      callOptional(options, 'setViewerMediaState', {
        upstreamConnected: true,
        videoStarted: true
      });
      if (p2pStateMachine && typeof p2pStateMachine.clearViewerMediaWaitTimer === 'function') {
        p2pStateMachine.clearViewerMediaWaitTimer();
      }
      setHidden(elements.waitingMessage, true);
      if (elements.connectionStatus) {
        elements.connectionStatus.textContent = '已连接';
        elements.connectionStatus.classList.add('connected');
      }
      if (elements.viewerP2pStatus && p2pStateMachine && typeof p2pStateMachine.setStatusElementState === 'function') {
        p2pStateMachine.setStatusElementState(elements.viewerP2pStatus, 'connected');
      }
      if (!callOptional(options, 'getViewerVolumeSynced')) {
        callOptional(options, 'setViewerVolumeSynced', true);
        if (viewerControls && typeof viewerControls.refreshVolumeUi === 'function') {
          viewerControls.refreshVolumeUi().catch((error) => {
            diagnostics.logRecoverableNativeWarning('viewer-volume:refresh-failed', error, {
              key: 'viewer-volume-refresh',
              category: 'audio',
              channel: 'nativeSteps',
              fallbackLabel: '[media-engine] delayed getViewerVolume failed:'
            });
          });
        }
      }
      const roomId = callOptional(options, 'getCurrentRoomId');
      const chainPosition = callOptional(options, 'getChainPosition');
      if (!callOptional(options, 'getViewerReadySent') && roomId && Number.isInteger(chainPosition) && chainPosition >= 0) {
        sendViewerReady({
          roomId,
          clientId: callOptional(options, 'getClientId'),
          sessionToken: callOptional(options, 'getCurrentSessionToken') || '',
          chainPosition
        });
        callOptional(options, 'setViewerReadySent', true);
      }
    }

    async function pollViewerStats(reason = 'periodic') {
      const upstreamPeerId = callOptional(options, 'getUpstreamPeerId') || '';
      if (!upstreamPeerId || callOptional(options, 'getSessionRole') !== 'viewer') {
        return null;
      }

      try {
        const stats = await mediaEngine.getStats({});
        diagnostics.setLatestP2pStatsSnapshot(stats);
        const viewerStatsSummary = diagnostics.buildViewerStatsSummary(stats, {
          reason,
          upstreamPeerId
        });
        const { peer, peerTransport, renderedFrames, receivedFrames } = viewerStatsSummary;
        if (!peer || !peerTransport) {
          renderP2pDiagnosticReport();
          return stats;
        }

        updateViewerFpsIndicator(receivedFrames, renderedFrames);
        if (diagnostics.shouldShowDebugLogsFor('video', 'periodicStats')) {
          const rate = diagnostics.shouldEmitNativeDebugLog(`stats:viewer:${reason}:${upstreamPeerId}`, reason === 'initial' ? 0 : 5000);
          if (rate.emit) {
            diagnostics.logNativeStatsLine('[media-engine native-peer-stats]', viewerStatsSummary.peerLogFields, rate.suppressed);
          }
          viewerStatsSummary.relayLogEntries.forEach((relayEntry) => {
            const relayRate = diagnostics.shouldEmitNativeDebugLog(
              `stats:relay:${reason}:${relayEntry.peerId || 'unknown'}`,
              reason === 'initial' ? 0 : 5000
            );
            if (!relayRate.emit) {
              return;
            }
            diagnostics.logNativeStatsLine('[media-engine native-relay-stats]', relayEntry.fields, relayRate.suppressed);
          });
        }

        if (renderedFrames > 0 || peerTransport.mediaPlaneReady) {
          applyViewerMediaReadyState();
        }

        renderP2pDiagnosticReport();
        return stats;
      } catch (error) {
        diagnostics.logRecoverableNativeWarning('native-peer-stats:failed', error, {
          key: 'native-peer-stats',
          category: 'video',
          channel: 'periodicStats',
          fallbackLabel: '[media-engine native-peer-stats] failed:'
        });
        return null;
      }
    }

    function startViewerStatsPolling() {
      diagnostics.startStatsPolling('viewer', {
        onStart: resetViewerFpsIndicator,
        onStop: renderP2pDiagnosticReport,
        shouldContinue: () => Boolean(callOptional(options, 'getUpstreamPeerId') && callOptional(options, 'getSessionRole') === 'viewer'),
        onTick: (reason) => pollViewerStats(reason)
      });
    }

    return {
      stopViewerStatsPolling,
      resetHostFpsIndicators,
      updateHostFpsIndicators,
      resetViewerFpsIndicator,
      updateViewerFpsIndicator,
      stopHostStatsPolling,
      updateHostEncoderDetail,
      pollHostStats,
      startHostStatsPolling,
      pollViewerStats,
      startViewerStatsPolling
    };
  }

  VDS.nativeStats = { createController };
})();
