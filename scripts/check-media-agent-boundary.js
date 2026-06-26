const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mediaAgentSrc = path.join(root, 'media-agent', 'src');

const allowedAgentRuntimeIncludes = new Set([
  'media-agent/src/main.cpp',
  'media-agent/src/runtime_registry.cpp'
]);

const allowedRelayBackendRuntimeIncludes = new Set([
  'media-agent/src/relay_backend_runtime.cpp',
  'media-agent/src/relay_hub.cpp'
]);

const allowedRelayBackendApiUsers = new Set([
  'media-agent/src/relay_backend_runtime.h',
  'media-agent/src/relay_backend_runtime.cpp',
  'media-agent/src/relay_hub.cpp'
]);

const allowedSessionRegistryFacadeUsers = new Set([
  'media-agent/src/runtime_registry.cpp'
]);

const allowedSessionOwnerActivationUsers = new Set([
  'media-agent/src/runtime_registry.h',
  'media-agent/src/runtime_registry.cpp',
  'media-agent/src/session_owner_activation.cpp'
]);

const allowedCurrentHostRuntimeFacadeUsers = new Set([]);

const allowedImplicitObsRuntimeAccessUsers = new Set([
  'media-agent/src/obs_ingest_session.h',
  'media-agent/src/obs_ingest_session.cpp'
]);

const allowedCurrentSessionFacadeUsers = new Set([]);

const relayDispatchApiFunctions = [
  'register_relay_subscriber',
  'unregister_relay_subscriber',
  'clear_relay_upstream_bootstrap_state',
  'shutdown_relay_dispatch_runtime',
  'query_relay_subscriber_state',
  'relay_subscriber_runtime_json',
  'fanout_relay_video_units',
  'fanout_relay_audio_frame'
];

const currentHostRuntimeFacadeFunctions = [
  'revalidate_current_host_capture_plan',
  'initialize_current_default_capture_runtime',
  'refresh_current_host_capture_runtime',
  'start_current_host_capture_process',
  'stop_current_host_capture_process',
  'set_current_host_video_codec',
  'prepare_current_obs_ingest_session',
  'clear_current_obs_ingest_prepared',
  'start_current_obs_ingest_worker',
  'stop_current_obs_ingest_session'
];

const guardedRuntimeFields = [
  'peer_transport_backend',
  'ffmpeg',
  'wgc_capture_backend',
  'host_sessions',
  'audio_sessions',
  'obs_ingest_sessions',
  'peer_sessions',
  'surface_sessions'
];

function collectSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && /\.(?:cpp|h)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function toDisplayPath(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function main() {
  const files = collectSourceFiles(mediaAgentSrc);
  const errors = [];
  const fieldPattern = new RegExp(
    `\\b(?:state|state_|runtime_state|runtime_state_)\\.(?:${guardedRuntimeFields.join('|')})\\b`,
    'g'
  );
  const relayDispatchApiPattern = new RegExp(
    `\\b(?:${relayDispatchApiFunctions.join('|')})\\s*\\(`,
    'g'
  );
  const sessionRegistryFacadePattern = /\b(?:host_sessions|audio_sessions|obs_ingest_sessions)\.(?:current_session|snapshot)\s*\(/g;
  const registryCurrentOrSnapshotDeclarationPattern = /\b(?:current_session|snapshot)\s*\(/g;
  const currentHostRuntimeFacadePattern = new RegExp(
    `\\b(?:${currentHostRuntimeFacadeFunctions.join('|')})\\s*\\(`,
    'g'
  );
  const sessionOwnerActivationPattern = /\bactivate_(?:host|audio|obs_ingest)_session\s*\(/g;
  const implicitObsRuntimeAccessPattern = /\bmake_obs_ingest_runtime_access\s*\(\s*(?:state|runtime_state)\s*\)/;
  const currentSessionFacadePattern = /\bcurrent_(?:host|audio|obs_ingest)_session\s*\(/g;
  const lifecycleActiveSessionPattern = /\bactive_(?:host|audio|obs_ingest)_session\s*\(/g;
  const activeSessionFacadeBackedByCurrentPattern = /\bactive_(?:host|audio|obs_ingest)_session[\s\S]*?\{[\s\S]*?\.current_session\s*\(/g;

  for (const filePath of files) {
    const displayPath = toDisplayPath(filePath);
    const source = fs.readFileSync(filePath, 'utf8');

    if (source.includes('#include "agent_runtime.h"') && !allowedAgentRuntimeIncludes.has(displayPath)) {
      errors.push(`Unexpected agent_runtime.h include in ${displayPath}`);
    }

    if (displayPath === 'media-agent/src/agent_runtime.h' && source.includes('#include "peer_transport.h"')) {
      errors.push('agent_runtime.h must include peer_transport_state.h, not the full peer_transport.h session API.');
    }

    if (displayPath === 'media-agent/src/agent_runtime.h' && source.includes('#include "wgc_capture.h"')) {
      errors.push('agent_runtime.h must include wgc_capture_state.h, not the full wgc_capture.h frame source API.');
    }

    if (displayPath === 'media-agent/src/agent_runtime.h' && source.includes('#include "native_surface_layout.h"')) {
      errors.push('agent_runtime.h must not include native_surface_layout.h directly; surface layout belongs behind surface_attachment_state.h.');
    }

    if (displayPath === 'media-agent/src/agent_status_json.cpp' && source.includes('#include "peer_transport.h"')) {
      errors.push('agent_status_json.cpp must use peer_transport_state_json.h for backend JSON, not full peer_transport.h.');
    }

    if (source.includes('#include "relay_dispatch.h"')) {
      errors.push(`Unexpected relay_dispatch.h include in ${displayPath}; relay backend declarations live in relay_backend_runtime.h and business paths must use relay_hub.h`);
    }

    if (source.includes('#include "relay_backend_runtime.h"') && !allowedRelayBackendRuntimeIncludes.has(displayPath)) {
      errors.push(`Unexpected relay_backend_runtime.h include in ${displayPath}; use relay_hub.h outside the relay backend implementation`);
    }

    if (displayPath === 'media-agent/src/relay_hub.h' && /\brelay_backend\b/.test(source)) {
      errors.push('relay_hub.h must not expose relay_backend implementation types; keep backend details in relay_hub.cpp');
    }

    if (displayPath === 'media-agent/src/agent_lifecycle.cpp') {
      const lifecycleSessionMatches = [...source.matchAll(lifecycleActiveSessionPattern)];
      if (lifecycleSessionMatches.length !== 3) {
        errors.push(
          `agent_lifecycle.cpp must bind host/audio/OBS active sessions only once inside AgentLifecycleSessions; found ${lifecycleSessionMatches.length} active-session calls`
        );
      }
    }

    if (displayPath === 'media-agent/src/agent_rpc_router.cpp') {
      if (/\bactive_(?:host|audio|obs_ingest)_session\s*\(/.test(source) || /\bmake_obs_ingest_runtime_access\s*\(/.test(source)) {
        errors.push('agent_rpc_router.cpp must use agent_rpc_session_bindings helpers instead of directly binding active owner sessions.');
      }
    }

    if ((displayPath === 'media-agent/src/host_session_start_pipeline.cpp' || displayPath === 'media-agent/src/host_session_stop_pipeline.cpp') &&
        /\bactive_obs_ingest_session\s*\(/.test(source)) {
      errors.push(`${displayPath} must receive ObsIngestState& from HostSessionController instead of resolving active OBS owner internally.`);
    }

    if ((displayPath === 'media-agent/src/host_session_start_pipeline.cpp' || displayPath === 'media-agent/src/host_session_stop_pipeline.cpp') &&
        /\bobs_ingest_session_snapshot\s*\(/.test(source)) {
      errors.push(`${displayPath} must format host session results from the injected ObsIngestState& owner instead of reading OBS through runtime snapshots.`);
    }

    if ((displayPath === 'media-agent/src/host_session_start_pipeline.cpp' || displayPath === 'media-agent/src/host_session_stop_pipeline.cpp') &&
        /\bpeer_transport_ready\s*\(/.test(source)) {
      errors.push(`${displayPath} must format transportReady from HostSessionControllerCallbacks instead of reading peer transport through runtime snapshots.`);
    }

    if ((displayPath === 'media-agent/src/host_session_runtime.h' || displayPath === 'media-agent/src/host_session_runtime.cpp') &&
        /reset_host_session_to_default_native\s*\(\s*AgentRuntimeState&\s+runtime_state\s*,\s*HostSessionState&\s+session\s*\)/.test(source)) {
      errors.push('reset_host_session_to_default_native must require an explicit ObsIngestState& owner; do not keep the implicit active OBS overload.');
    }

    if (displayPath === 'media-agent/src/peer_create_pipeline.h' &&
        (/\bAgentRuntimeState\b/.test(source) || /\bfinalize_created_peer\s*\(/.test(source))) {
      errors.push('peer_create_pipeline.h must not expose AgentRuntimeState finalize helpers; peer creation finalization belongs inside PeerSessionController.');
    }

    if (displayPath === 'media-agent/src/peer_refresh_pipeline.h' &&
        /\brefresh_all_host_(?:video|audio)_senders\s*\(/.test(source)) {
      errors.push('peer_refresh_pipeline.h must only expose transport refresh; host video/audio sender refresh belongs inside PeerSessionController.');
    }

    if (!allowedCurrentSessionFacadeUsers.has(displayPath)) {
      const currentSessionMatches = [...source.matchAll(currentSessionFacadePattern)].map((match) => match[0].replace(/\s*\($/, ''));
      if (currentSessionMatches.length > 0) {
        errors.push(
          `Direct current session facade use in ${displayPath}: ${[...new Set(currentSessionMatches)].join(', ')}; use active_*_session() for runtime owner paths`
        );
      }
    }

    if (displayPath === 'media-agent/src/runtime_registry.cpp' && activeSessionFacadeBackedByCurrentPattern.test(source)) {
      errors.push('active_*_session() runtime facades must call registry active_session(), not current_session() compatibility aliases');
    }

    if ((displayPath === 'media-agent/src/runtime_registry.h' || displayPath === 'media-agent/src/runtime_registry.cpp') &&
        /\bcurrent_(?:host|audio|obs_ingest)_session\s*\(/.test(source)) {
      errors.push('runtime_registry must not expose current_*_session() facades; use active_*_session() or explicit snapshots.');
    }

    if (displayPath === 'media-agent/src/session_registries.h' && /\b(?:HostSessionState|AudioSessionState|ObsIngestState)\s+active_\s*;/.test(source)) {
      errors.push('Host/Audio/OBS registries must keep active sessions in a session map, not single active_ state members');
    }

    if (displayPath === 'media-agent/src/session_registries.h' && registryCurrentOrSnapshotDeclarationPattern.test(source)) {
      errors.push('Host/Audio/OBS registries must not expose current_session() or snapshot() compatibility aliases; use active_session() and runtime snapshot facades.');
    }

    if (displayPath === 'media-agent/src/session_registries.h') {
      for (const requiredMethod of ['ensure_session', 'activate_session', 'session_count']) {
        const matches = source.match(new RegExp(`\\b${requiredMethod}\\s*\\(`, 'g')) || [];
        if (matches.length < 3) {
          errors.push(`Host/Audio/OBS registries must all expose ${requiredMethod}(); found ${matches.length}`);
        }
      }
    }

    if (displayPath === 'media-agent/src/runtime_registry.h') {
      for (const requiredFacade of ['activate_host_session', 'activate_audio_session', 'activate_obs_ingest_session']) {
        if (!source.includes(`${requiredFacade}(`)) {
          errors.push(`runtime_registry.h must expose ${requiredFacade}() so business paths activate explicit session owners`);
        }
      }
    }

    if (displayPath === 'media-agent/src/surface_snapshot_aggregator.h' && !source.includes('surface_session_stats_json(const AgentRuntimeState& runtime_state)')) {
      errors.push('surface_session_stats_json() must accept const AgentRuntimeState& so read-only stats aggregation cannot mutate runtime.');
    }

    if (displayPath === 'media-agent/src/surface_state_json.h' && !source.includes('surface_attachment_json(const SurfaceAttachmentState& state)')) {
      errors.push('surface_state_json.h must expose a const surface_attachment_json() overload for read-only surface snapshots.');
    }

    if (displayPath === 'media-agent/src/agent_status_json.h') {
      for (const requiredSignature of [
        'capabilities_json(const AgentRuntimeState& state)',
        'build_status_json(const AgentRuntimeState& state)',
        'build_agent_ready_json(const AgentRuntimeState& state)',
        'build_stats_json(const AgentRuntimeState& state)'
      ]) {
        if (!source.includes(requiredSignature)) {
          errors.push(`agent_status_json.h must expose read-only JSON builder signature: ${requiredSignature}`);
        }
      }
    }

    if (displayPath === 'media-agent/src/runtime_registry.h' && !source.includes('const std::function<void(const SurfaceAttachmentState&)>& callback')) {
      errors.push('runtime_registry.h must expose const surface iteration for read-only surface snapshots.');
    }

    if (!allowedRelayBackendApiUsers.has(displayPath)) {
      const relayMatches = [...source.matchAll(relayDispatchApiPattern)].map((match) => match[0].replace(/\s*\($/, ''));
      if (relayMatches.length > 0) {
        errors.push(`Direct relay backend API use in ${displayPath}: ${[...new Set(relayMatches)].join(', ')}; use RelayHub instead`);
      }
    }

    if (!allowedSessionRegistryFacadeUsers.has(displayPath)) {
      const sessionRegistryMatches = [...source.matchAll(sessionRegistryFacadePattern)].map((match) => match[0].replace(/\s*\($/, ''));
      if (sessionRegistryMatches.length > 0) {
        errors.push(
          `Direct single-session registry facade use in ${displayPath}: ${[...new Set(sessionRegistryMatches)].join(', ')}; use runtime_registry active_*_session() or *_session_snapshot() instead`
        );
      }
    }

    if (!allowedSessionOwnerActivationUsers.has(displayPath)) {
      const activationMatches = [...source.matchAll(sessionOwnerActivationPattern)].map((match) => match[0].replace(/\s*\($/, ''));
      if (activationMatches.length > 0) {
        errors.push(
          `Direct Host/Audio/OBS session activation in ${displayPath}: ${[...new Set(activationMatches)].join(', ')}; use session_owner_activation helpers at RPC boundaries`
        );
      }
    }

    if (!allowedCurrentHostRuntimeFacadeUsers.has(displayPath)) {
      const currentHostMatches = [...source.matchAll(currentHostRuntimeFacadePattern)].map((match) => match[0].replace(/\s*\($/, ''));
      if (currentHostMatches.length > 0) {
        errors.push(
          `Direct current host/OBS runtime facade use in ${displayPath}: ${[...new Set(currentHostMatches)].join(', ')}; pass the explicit session state to host_session_runtime API instead`
        );
      }
    }

    if (!allowedImplicitObsRuntimeAccessUsers.has(displayPath) && implicitObsRuntimeAccessPattern.test(source)) {
      errors.push(
        `Implicit OBS runtime access binding in ${displayPath}; call make_obs_ingest_runtime_access(runtime_state, host_session) instead`
      );
    }

    if (displayPath === 'media-agent/src/obs_ingest_session.h' &&
        /\bmake_obs_ingest_runtime_access\s*\(\s*AgentRuntimeState&\s+\w+\s*\)\s*;/.test(source)) {
      errors.push('obs_ingest_session.h must not expose implicit make_obs_ingest_runtime_access(AgentRuntimeState&) overload; pass HostSessionState& explicitly.');
    }

    if (displayPath !== 'media-agent/src/runtime_registry.cpp') {
      const matches = [...source.matchAll(fieldPattern)].map((match) => match[0]);
      if (matches.length > 0) {
        errors.push(`Direct AgentRuntimeState field access in ${displayPath}: ${[...new Set(matches)].join(', ')}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error('Media agent boundary check failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log('Media agent boundary check passed.');
}

main();
