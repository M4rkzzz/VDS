const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const koffi = require('koffi');
const crypto = require('node:crypto');
const os = require('node:os');
const { MediaAgentManager } = require('../desktop/media-agent-manager');
const kernel = koffi.load('kernel32.dll');
const user = koffi.load('user32.dll');
const open = kernel.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
const close = kernel.func('bool __stdcall CloseHandle(void *handle)');
const times = kernel.func('bool __stdcall GetProcessTimes(void *handle, _Out_ uint64_t *created, _Out_ uint64_t *exited, _Out_ uint64_t *kernel, _Out_ uint64_t *user)');
const gui = user.func('uint32_t __stdcall GetGuiResources(void *handle, uint32_t flags)');
// Optional visible Windows performance probe, separate from unattended checks.
// Owns its agent/windows; neither saves captured pixels nor joins a room.
let gpuReadyEvents = 0;
const manager = new MediaAgentManager({logger:{log(){},warn(message){
  if(String(message).includes('nativeLivePreview:d2d-presenter-ready')) gpuReadyEvents++;
},error(){}}});
manager.resolveBinaryPath = () => path.resolve(__dirname, '../runtime/media-agent/vds-media-agent.exe');
const delay = ms => new Promise(r=>setTimeout(r,ms));
let stimulus, handle;
function cpuMs() {
  const fields = [[0],[0],[0],[0]];
  assert.ok(times(handle,...fields));
  return (Number(fields[2][0])+Number(fields[3][0]))/10000;
}
async function surface() {
  const stats = await manager.invoke('getStats',{});
  return stats.surfaces.find(s=>s.surface==='preview-cpu-owned');
}
(async()=>{
  const label=process.argv[2]||'result';
  assert.match(label,/^[a-zA-Z0-9_-]+$/);
  stimulus=require('../tests/fixtures/capture-stimulus').startCaptureStimulus();
  await manager.start();
  handle=open(0x1000,false,manager.child.pid);
  assert.ok(handle);
  await manager.invoke('startHostSession',{mediaSessionId:'preview-cpu-owned',backend:'native',
    captureKind:'display',captureTargetId:'screen:0:0',displayId:'0',
    requestedCodec:'h264',width:1920,height:1080,frameRate:30,bitrateKbps:10000});
  const samples=[];
  for(const visible of [false,true,false,true]) {
    await manager.invoke('attachSurface',{surface:'preview-cpu-owned',target:'host-capture-preview',
      embedded:false,visible,x:20,y:20,width:960,height:540});
    await delay(2500);
    const before=await surface();
    assert.equal(before.reason,'live-preview-frame-rendered');
    const started=performance.now(), cpuStart=cpuMs(), gdiStart=gui(handle,0);
    await delay(10000);
    const cpuElapsed=cpuMs()-cpuStart, elapsed=performance.now()-started, after=await surface();
    assert.ok(after.decodedFramesRendered>before.decodedFramesRendered+100);
    samples.push({visible,wallMs:elapsed,cpuMs:cpuElapsed,oneCorePercent:100*cpuElapsed/elapsed,
      frames:after.decodedFramesRendered-before.decodedFramesRendered,gdiStart,gdiEnd:gui(handle,0)});
    await manager.invoke('detachSurface',{surface:'preview-cpu-owned'});
  }
  const report={ok:true,samples,gpuReadyEvents,logicalProcessors:os.cpus().length,
    agentSha256:crypto.createHash('sha256').update(fs.readFileSync(manager.resolveBinaryPath())).digest('hex'),
    metric:'oneCorePercent: 100% means one fully used logical CPU, not whole-machine utilization'};
  const outputDirectory=path.resolve(__dirname,'../tmp');
  fs.mkdirSync(outputDirectory,{recursive:true});
  fs.writeFileSync(path.join(outputDirectory,`host-preview-cpu-${label}.json`),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{
  if(stimulus)stimulus();
  await manager.stop();
  if(handle)close(handle);
  assert.equal(manager.child,null);
});
