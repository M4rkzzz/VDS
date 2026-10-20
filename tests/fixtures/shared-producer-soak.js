const assert = require('node:assert/strict');
const fs = require('node:fs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function processProbe() {
  const koffi = require('koffi');
  const kernel = koffi.load('kernel32.dll'), psapi = koffi.load('psapi.dll');
  const open = kernel.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
  const close = kernel.func('bool __stdcall CloseHandle(void *handle)');
  const lastError = kernel.func('uint32_t __stdcall GetLastError()');
  const handles = kernel.func('bool __stdcall GetProcessHandleCount(void *handle, _Out_ uint32_t *count)');
  const exitCode = kernel.func('bool __stdcall GetExitCodeProcess(void *handle, _Out_ uint32_t *code)');
  const times = kernel.func('bool __stdcall GetProcessTimes(void *handle, _Out_ uint64_t *created, _Out_ uint64_t *exited, _Out_ uint64_t *kernel, _Out_ uint64_t *user)');
  const counters = koffi.struct({ cb:'uint32_t', faults:'uint32_t', peakWorking:'size_t', working:'size_t',
    peakPaged:'size_t', paged:'size_t', peakNonPaged:'size_t', nonPaged:'size_t', pagefile:'size_t', peakPagefile:'size_t', privateBytes:'size_t' });
  const memory = psapi.func('GetProcessMemoryInfo', 'bool', ['void *', koffi.out(koffi.pointer(counters)), 'uint32_t']);
  return pid => {
    const handle = open(0x410, false, pid);
    if (!handle) {
      const error=lastError();
      assert.equal(error,87,'cannot inspect owned process '+pid+' (Win32 '+error+')');
      return {pid, exited:true};
    }
    try {
      const code=[0]; assert.ok(exitCode(handle,code));
      if(code[0]!==259)return {pid,exited:true,exitCode:code[0]};
      const values={cb:koffi.sizeof(counters)}; assert.ok(memory(handle,values,koffi.sizeof(counters)));
      const count=[0]; assert.ok(handles(handle,count));
      const cpu=[[0],[0],[0],[0]]; assert.ok(times(handle,...cpu));
      return {pid,privateBytes:Number(values.privateBytes),workingSetBytes:Number(values.working),handles:count[0],
        cpuMs:(Number(cpu[2][0])+Number(cpu[3][0]))/10000,exited:false};
    } finally {close(handle);}
  };
}

async function runSharedProducerSoak(context) {
  const {agent,instance,room,hostId,port,BrowserWindow,windows,app,snapshot,selectedTransports,
    installTransportProbe,transportGenerations,checkFatal,onFailure,step,frameRate,durationMs,reportPath}=context;
  const viewers=[...context.viewers];
  const probe=processProbe();
  const evidence={ok:false,startedAt:new Date().toISOString(),durationMs,viewerCount:4,frameRate,
    observations:[],events:[],encoders:[],failures:[]};
  context.onEvidence?.(evidence);
  const save=()=>fs.writeFileSync(reportPath,JSON.stringify(evidence,null,2));
  let previewAttached=true, sampleNumber=0;
  const previewName='producer-preview';
  const stats=()=>agent.invoke('getStats');
  const bindings=s=>s.peers.filter(p=>p.mediaBinding?.producerId);
  const compact=(s)=>({producerId:s.producerId,pid:s.producerProcessId,subscribers:s.producerSubscribers,
    active:s.active,recoveryPending:s.recoveryPending,sourceEpoch:s.sourceEpoch});
  async function until(label,read,limit=20000) {
    const end=Date.now()+limit;
    while(Date.now()<end){checkFatal();if(await read())return;await pause(100);}
    throw Error('soak-timeout:'+label);
  }
  function noRelayParents(){for(const viewer of instance.rooms.get(room.roomId).viewers)viewer.mediaCapabilities.maxDirectDownstreams=0;}
  async function join(target){
    noRelayParents();
    await until('join-button',async()=>!(await snapshot(target)).joinDisabled);
    await target.webContents.executeJavaScript(`document.getElementById('roomIdInput').value=${JSON.stringify(room.roomId)};document.getElementById('joinButton').click();`);
    await until('join-playing',async()=>{
      const d=(await snapshot(target)).diagnostics;
      return d?.playbackState==='playing'&&d.webDecodedVideoFrames>=12&&d.upstreamPeerId===hostId;
    });
    const pairs=await selectedTransports(target);assert.ok(pairs.length);
    for(const pair of pairs){assert.notEqual(pair.local.candidateType,'relay');assert.notEqual(pair.remote.candidateType,'relay');}
  }
  async function leave(target){
    await target.webContents.executeJavaScript("document.getElementById('leaveButton').click()");
    await until('leave-stopped',async()=>(await snapshot(target)).diagnostics.playbackState==='stopped');
  }
  async function shared(count){
    let found;
    await until('shared-'+count,async()=>{
      const s=await stats(), peers=bindings(s);
      if(peers.length!==count||peers.some(p=>!p.mediaBinding.active||p.mediaBinding.recoveryPending))return false;
      if(count){const b=peers[0].mediaBinding;assert.ok(b.producerProcessId>0);
        assert.ok(peers.every(p=>p.mediaBinding.producerId===b.producerId&&p.mediaBinding.producerProcessId===b.producerProcessId&&p.mediaBinding.producerSubscribers===count));}
      found=s;return true;
    });
    return found;
  }
  const browserSample=async()=>Promise.all(viewers.map(async v=>{
    const s=await snapshot(v),d=s.diagnostics;
    return {clientId:d?.clientId,frames:d?.webDecodedVideoFrames,dropped:d?.webDroppedVideoFrames,state:d?.playbackState,
      epoch:d?.webPlaybackMetrics?.sourceEpoch,upstream:d?.upstreamPeerId,metrics:d?.webPlaybackMetrics};
  }));
  async function observe(label,ms){
    step(label);
    let baseline=await browserSample(),last=baseline,lastAdvance=last.map(()=>Date.now());
    const lastPresentationAdvance=last.map(()=>Date.now());
    const start=Date.now();let nextRecord=start;
    while(Date.now()-start<ms){
      checkFatal();await pause(500);
      const now=Date.now(),current=await browserSample();
      current.forEach((v,i)=>{
        assert.equal(v.clientId,baseline[i].clientId,'unexpected reconnect during stable observation');
        assert.equal(v.epoch,baseline[i].epoch,'source epoch changed during stable observation');
        assert.equal(v.upstream,hostId,'soak viewer left direct P2P topology');
        assert.equal(v.state,'playing','steady viewer state stopped');
        if(v.frames>last[i].frames)lastAdvance[i]=now;
        assert.ok(now-lastAdvance[i]<4000,'viewer '+i+' stalled for four seconds');
        if(v.metrics.video.presented>last[i].metrics.video.presented)lastPresentationAdvance[i]=now;
        assert.ok(now-lastPresentationAdvance[i]<4000,'viewer '+i+' presentation stalled for four seconds');
      });
      last=current;
      if(now>=nextRecord || now-start>=ms){
        const s=await shared(viewers.length),b=bindings(s)[0].mediaBinding;
        const surface=s.surfaces.find(v=>v.surface===previewName);
        if(previewAttached)assert.equal(surface?.implementation,'shared-wgc-live-preview','preview stopped sharing capture');
        const sample={elapsedMs:now-Date.parse(evidence.startedAt),label,viewers:current,producer:compact(b),
          preview:surface&&{implementation:surface.implementation,frames:surface.decodedFramesRendered,error:surface.lastError},
          native:probe(agent.child.pid),encoder:probe(b.producerProcessId),
          electron:app.getAppMetrics().map(({pid,type,cpu,memory})=>({pid,type,cpu:cpu.percentCPUUsage,workingKiB:memory.workingSetSize}))};
        evidence.observations.push(sample);nextRecord=now+10000;save();
        if(sampleNumber++%3===0)console.log('[soak] '+JSON.stringify({elapsedSec:Math.round(sample.elapsedMs/1000),label,
          frames:current.map(v=>v.frames),nativeMiB:Math.round(sample.native.privateBytes/1048576),handles:sample.native.handles,encoderPid:b.producerProcessId}));
      }
    }
    const elapsed=Date.now()-start;
    last.forEach((v,i)=>assert.ok(v.frames-baseline[i].frames>=frameRate*elapsed/1000*0.8,'viewer '+i+' below 80% of source rate'));
    last.forEach((v,i)=>assert.ok(v.metrics.video.presented-baseline[i].metrics.video.presented>=frameRate*elapsed/1000*0.8,
      'viewer '+i+' presentation below 80% of source rate'));
  }
  async function recoverEncoder(cycle){
    const s=await shared(4),b=bindings(s)[0].mediaBinding;
    const before=await browserSample(),generations=new Map(transportGenerations);
    assert.equal(probe(b.producerProcessId).exited,false);
    evidence.encoders.push(b.producerProcessId);
    const started=Date.now();step('soak-encoder-death-'+cycle);process.kill(b.producerProcessId);
    // DO NOT getStats until every viewer advances. That RPC can itself trigger
    // recovery; only HostVideoRefreshWakeup may initiate it in this interval.
    await until('all-viewers-recovered',async()=>{
      // Three seconds of new decoded frames prevents a draining pre-failure
      // queue from satisfying recovery before the new encoder actually runs.
      const now=await browserSample();return now.every((v,i)=>v.state==='playing'&&v.frames>=before[i].frames+frameRate*3&&
        v.metrics.video.presented>=before[i].metrics.video.presented+frameRate*3);
    },20000);
    const recoveredAt=Date.now(),after=await shared(4),next=bindings(after)[0].mediaBinding;
    assert.notEqual(next.producerProcessId,b.producerProcessId);
    assert.deepEqual(transportGenerations,generations,'encoder death rebuilt P2P transports');
    (await browserSample()).forEach((v,i)=>assert.equal(v.epoch,before[i].epoch));
    await until('old-encoder-exited',()=>probe(b.producerProcessId).exited);
    evidence.events.push({type:'encoder-recovered',cycle,recoveryMs:recoveredAt-started,oldPid:b.producerProcessId,newPid:next.producerProcessId,
      noStatsPollingDuringRecovery:true,connectionsPreserved:true});save();
  }
  async function togglePreview(cycle){
    const b=bindings(await shared(4))[0].mediaBinding;
    await agent.invoke('detachSurface',{surface:previewName});previewAttached=false;
    await observe('soak-preview-detached-'+cycle,2000);
    await agent.invoke('attachSurface',{surface:previewName,target:'host-capture-preview',visible:false});previewAttached=true;
    await until('preview-sharing',async()=>(await stats()).surfaces.some(s=>s.surface===previewName&&s.implementation==='shared-wgc-live-preview'&&s.decodedFramesRendered>0));
    assert.equal(bindings(await shared(4))[0].mediaBinding.producerId,b.producerId,'preview toggle restarted producer');
    evidence.events.push({type:'preview-toggle',cycle,producerPreserved:true});save();
  }
  async function churn(cycle){
    const b=bindings(await shared(4))[0].mediaBinding;
    await leave(viewers[3]);await shared(3);
    assert.equal(bindings(await stats())[0].mediaBinding.producerId,b.producerId,'one viewer leave restarted producer');
    await join(viewers[3]);await shared(4);
    assert.equal(bindings(await stats())[0].mediaBinding.producerId,b.producerId,'one viewer rejoin restarted producer');
    evidence.events.push({type:'viewer-rejoin',cycle,producerPreserved:true});save();
  }
  async function fallback(cycle){
    const b=bindings(await shared(4))[0].mediaBinding;
    for(const viewer of viewers)await leave(viewer);
    await shared(0);await until('last-encoder-exited',()=>probe(b.producerProcessId).exited);
    let start;
    await until('preview-fallback',async()=>{
      const s=(await stats()).surfaces.find(s=>s.surface===previewName);
      if(s?.implementation==='wgc-live-preview'&&s.running){start=s.decodedFramesRendered;return true;}return false;
    });
    await until('fallback-keeps-capturing',async()=>{
      const s=(await stats()).surfaces.find(s=>s.surface===previewName);return s.decodedFramesRendered>=start+5&&!s.lastError;
    });
    for(const viewer of viewers)await join(viewer);await shared(4);
    await until('preview-reused-again',async()=>(await stats()).surfaces.some(s=>s.surface===previewName&&s.implementation==='shared-wgc-live-preview'));
    evidence.events.push({type:'all-leave-rejoin',cycle,independentPreviewAdvanced:true,oldEncoderExited:true});save();
  }
  try {
    step('soak-start');save();
    for(let index=2;index<4;index++){
      const viewer=new BrowserWindow({show:false,width:960,height:640,webPreferences:{nodeIntegration:false,contextIsolation:true,
        sandbox:true,backgroundThrottling:false,offscreen:true,partition:'vds-soak-'+process.pid+'-'+index}});
      viewer.webContents.setFrameRate(60);viewer.webContents.setAudioMuted(true);windows.push(viewer);viewers.push(viewer);
      viewer.webContents.on('render-process-gone',(_event,details)=>onFailure(Error('soak-renderer-gone:'+details.reason)));
      await installTransportProbe(viewer);await viewer.loadURL(`http://127.0.0.1:${port}/vds_web/`);await join(viewer);
    }
    await shared(4);
    const cycles=6,half=Math.max(2000,Math.floor(durationMs/cycles/2));
    for(let cycle=0;cycle<cycles;cycle++){
      await observe('soak-steady-'+cycle,half);
      await recoverEncoder(cycle);
      await togglePreview(cycle);await churn(cycle);
      await observe('soak-recovered-'+cycle,half);
      if(cycle%2===1)await fallback(cycle);
    }
    for(const viewer of viewers.slice(2)){await leave(viewer);viewer.destroy();}
    viewers.splice(2);await shared(2);
    evidence.completedAt=new Date().toISOString();evidence.ok=true;save();return evidence;
  } catch(error){
    evidence.failures.push({message:error.message,stack:error.stack,at:new Date().toISOString()});
    evidence.lastStats=await stats().catch(e=>({error:e.message}));
    evidence.lastBrowsers=await browserSample().catch(e=>({error:e.message}));save();throw error;
  }
}
function verifySoakStopped(evidence) {
  const probe=processProbe();
  const pids=new Set([...evidence.encoders,...evidence.observations.map(s=>s.producer.pid),
    ...evidence.events.filter(e=>e.type==='encoder-recovered').map(e=>e.newPid)]);
  const processes=[...pids].map(probe);
  assert.ok(processes.every(p=>p.exited),'owned encoder remained after agent shutdown');
  const native=evidence.nativeProcessId ? probe(evidence.nativeProcessId) : undefined;
  if(native)assert.ok(native.exited,'native agent remained after shutdown');
  return {allOwnedEncodersExited:true,processes,native};
}
module.exports={runSharedProducerSoak,verifySoakStopped};
