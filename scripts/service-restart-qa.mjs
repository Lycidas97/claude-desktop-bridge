// Isolated real Electron + SDK/CLI test. No model requests or production configuration.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, chmod } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';
import { build as buildClient } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron } from 'playwright-core';
const repo = resolve(import.meta.dirname, '..');
const mobileMode = process.argv.includes('--mobile');
const root = await mkdtemp(join(repo, 'output/service-restart-'));
const application = join(root, 'app');
const home = join(root, 'home');
const userData = join(root, 'user-data');
await Promise.all([mkdir(application, { recursive: true }), mkdir(home), mkdir(userData), mkdir(join(root, 'project'))]);
const alias = { '@bridge/protocol': join(repo, 'packages/protocol/src/index.ts') };
let relay;let rendererServer;let rendererOrigin;let mobile;let mobilePage;
const relayFrames=[];
if(mobileMode){
 await build({entryPoints:[join(repo,'apps/relay/src/server.ts')],outfile:join(root,'relay.cjs'),bundle:true,platform:'node',format:'cjs',alias});
 const {startRelayServer}=await import(join(root,'relay.cjs'));
 relay=await startRelayServer({host:'127.0.0.1',port:0});
 relay.wsServer.on('connection',socket=>socket.on('message',data=>{const frame=JSON.parse(String(data));if(frame.type==='envelope')relayFrames.push({at:Date.now(),envelope:frame.envelope});}));
}
await buildClient({configFile:false,root:join(repo,'apps/client'),envDir:root,base:'./',plugins:[react()],resolve:{alias},
 define:{'import.meta.env.VITE_BRIDGE_PUBLIC_RELAY_URL':JSON.stringify(relay?.url??''),'import.meta.env.VITE_BRIDGE_SERVICE_ORIGIN':JSON.stringify(relay?.url.replace('ws:','http:').replace('/ws','')??'http://127.0.0.1:1'),'import.meta.env.VITE_BRIDGE_ICE_SERVERS':JSON.stringify('[]')},
 build:{outDir:join(application,'renderer'),emptyOutDir:false,target:'es2022',assetsInlineLimit:0}});
if(mobileMode){
 rendererServer=createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  try{const file=join(application,'renderer',pathname==='/'?'index.html':pathname);res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));}
  catch(error){if(error.code!=='ENOENT')throw error;res.writeHead(404);res.end();}
 });
 rendererServer.listen(0,'127.0.0.1');await once(rendererServer,'listening');rendererOrigin=`http://127.0.0.1:${rendererServer.address().port}`;
}
await build({ entryPoints: [join(repo,'apps/desktop/src/main.ts')], outfile: join(application,'main.cjs'), bundle:true, platform:'node', format:'cjs', target:'node22', external:['electron'], alias,
  define: { 'import.meta.url':'__bridgeImportMetaUrl', __BRIDGE_DEFAULT_RELAY__:JSON.stringify('ws://127.0.0.1:1/ws'), __BRIDGE_DEFAULT_PUBLIC_RELAY__:JSON.stringify(''), __BRIDGE_DEFAULT_PAIRING_BASE__:JSON.stringify('http://127.0.0.1:1'), __BRIDGE_DEFAULT_SERVICE_ORIGIN__:JSON.stringify('http://127.0.0.1:1'), __BRIDGE_DEFAULT_ICE_SERVERS__:JSON.stringify('[]') },
  banner:{js:"const __bridgeImportMetaUrl = require('node:url').pathToFileURL(__filename).href;"} });
await build({ entryPoints:[join(repo,'apps/desktop/src/preload.ts')],outfile:join(application,'preload.cjs'), bundle:true,platform:'node',format:'cjs',external:['electron'],alias });
await build({ entryPoints:[join(repo,'apps/desktop/src/service-connection.ts')],outfile:join(root,'service-client.cjs'),bundle:true,platform:'node',format:'cjs',alias });
await Promise.all([
  ...['cmaps','standard_fonts','wasm'].map(directory=>cp(join(repo,'node_modules/pdfjs-dist',directory),join(application,'renderer/pdfjs',directory),{recursive:true})),
  cp(join(repo,'apps/desktop/assets'),join(application,'assets'),{recursive:true}),
  mkdir(join(application,'node_modules'),{recursive:true}).then(()=>cp(join(repo,'node_modules/node-datachannel'),join(application,'node_modules/node-datachannel'),{recursive:true})),
]);
await writeFile(join(application,'package.json'),JSON.stringify({name:'bridge-service-restart-qa',version:'1.0.3',main:'bootstrap.cjs'}));
await writeFile(join(application,'bootstrap.cjs'), `
const {app,safeStorage}=require('electron');
const os=require('node:os');const fs=require('node:fs');const path=require('node:path');
os.homedir=()=>${JSON.stringify(home)};require('node:module').syncBuiltinESMExports();
app.setName('Bridge Service Restart QA');app.setPath('home',${JSON.stringify(home)});app.setPath('userData',${JSON.stringify(userData)});
app.whenReady().then(()=>{
  if(!safeStorage.isEncryptionAvailable())throw new Error('Safe storage unavailable');
  const p=${JSON.stringify(join(root,'test-cipher'))};
  if(process.argv.includes('--bridge-service')) fs.writeFileSync(${JSON.stringify(join(root,'storage-proof'))},safeStorage.decryptString(fs.readFileSync(p)));
  else fs.writeFileSync(p,safeStorage.encryptString('isolated-storage-test'));
});
require('./main.cjs');
`);
const models = createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'test-model',display_name:'Test Model'}]}));});
models.listen(0,'127.0.0.1');await once(models,'listening');
const credential = join(root,'fake-host-creds.json');
await writeFile(credential,JSON.stringify({env:{ANTHROPIC_BASE_URL:`http://127.0.0.1:${models.address().port}`,ANTHROPIC_AUTH_TOKEN:'bridge-qa-placeholder'}}),{mode:0o600});
const fake = join(root,'fake-claude.cjs');
await writeFile(fake, `#!${process.execPath}
const fs=require('node:fs');const readline=require('node:readline');const {randomUUID}=require('node:crypto');
if(process.argv.includes('--version')){console.log('2.1.218-test');process.exit(0);}
const sid=process.argv[process.argv.indexOf('--resume')+1]||process.argv[process.argv.indexOf('--session-id')+1];
fs.appendFileSync(${JSON.stringify(join(root,'cli-pids.jsonl'))},JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');
const trace=(direction,message)=>fs.appendFileSync(${JSON.stringify(join(root,'cli-wire.jsonl'))},JSON.stringify({at:Date.now(),pid:process.pid,direction,message})+'\\n');
const send=x=>{trace('stdout',x);process.stdout.write(JSON.stringify(x)+'\\n');};let user;let request;let heldUser;let stopRequested;
const tasks=new Map();
const system=x=>send({type:'system',uuid:randomUUID(),session_id:sid,...x});
const membership=()=>system({subtype:'background_tasks_changed',tasks:[...tasks.values()].map(({task_id,task_type,description})=>({task_id,task_type,description}))});
function done(){send({type:'assistant',uuid:randomUUID(),session_id:sid,parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:'QA completed'}],stop_reason:'end_turn'}});send({type:'result',subtype:'success',uuid:randomUUID(),session_id:sid,result:'QA completed',is_error:false,user_message_uuid:user.uuid,origin:{kind:'human'},duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{input_tokens:0,output_tokens:0},modelUsage:{},permission_denials:[]});}
process.on('SIGUSR2',()=>{
 if(!heldUser)throw new Error('No input waiting for replay acknowledgement');
 user=heldUser;heldUser=undefined;send({...user,isReplay:true});
 for(const suffix of ['stop','exit']){
  const task={task_id:'qa-background-'+suffix,tool_use_id:'qa-tool-'+suffix,task_type:'local_agent',subagent_type:'Explore',description:'QA background '+suffix};
  tasks.set(task.task_id,task);membership();system({subtype:'task_started',...task});
  system({subtype:'task_progress',...task,usage:{total_tokens:0,tool_uses:1,duration_ms:1},last_tool_name:'Read',summary:'Waiting for explicit QA signal'});
 }
 done();
});
process.on('SIGUSR1',()=>{
 const task=tasks.get(stopRequested);if(!task)throw new Error('No acknowledged task stop waiting for notification');
 tasks.delete(task.task_id);membership();system({subtype:'task_notification',task_id:task.task_id,tool_use_id:task.tool_use_id,status:'stopped',output_file:${JSON.stringify(join(root,'task.output'))},summary:'Stopped after explicit QA notification signal'});stopRequested=undefined;
});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);trace('stdin',m);
 if(m.type==='control_request'){
  if(m.request.subtype==='stop_task')stopRequested=m.request.task_id;
  const response=m.request.subtype==='initialize'?{commands:[],agents:[],models:[{value:'test-model',displayName:'Test',description:''}],output_style:'default',available_output_styles:[],account:{}}:{};
  send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response}});
 } else if(m.type==='user'){
  if(m.message.content.some(block=>block.type==='text'&&block.text==='Run background lifecycle QA')){heldUser=m;return;}
  user=m;send({...user,isReplay:true});request=randomUUID();send({type:'control_request',request_id:request,request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'qa-noop'},tool_use_id:randomUUID(),permission_suggestions:[]}});
 } else if(m.type==='control_response'&&m.response.request_id===request) done();
});
`);
await chmod(fake,0o755);
const sessionId=randomUUID();const projects=join(home,'.claude/projects/qa');await mkdir(projects,{recursive:true});
await mkdir(join(home,'.claude/sessions'),{recursive:true});
await writeFile(join(home,'.claude/sessions/fixture.json'),JSON.stringify({pid:process.pid,sessionId,cwd:join(root,'project'),startedAt:Date.now(),entrypoint:'claude-desktop-3p'}));
await writeFile(join(projects,sessionId+'.jsonl'),[
 {type:'user',uuid:randomUUID(),sessionId,cwd:join(root,'project'),timestamp:new Date().toISOString(),message:{role:'user',content:'QA previous'}},
 {type:'assistant',uuid:randomUUID(),sessionId,cwd:join(root,'project'),timestamp:new Date().toISOString(),message:{role:'assistant',content:[{type:'text',text:'done'}],stop_reason:'end_turn'}},
].map(x=>JSON.stringify(x)).join('\n')+'\n');
const environment={...process.env,BRIDGE_USER_DATA:userData,BRIDGE_CLAUDE_PATH:fake,CLAUDE_CODE_HOST_CREDS_FILE:credential,CLAUDE_CONFIG_DIR:join(home,'.claude'),BRIDGE_RELAY_URL:'ws://127.0.0.1:1/ws',BRIDGE_PAIRING_BASE_URL:'http://127.0.0.1:1',BRIDGE_SERVICE_ORIGIN:'http://127.0.0.1:1',BRIDGE_PUBLIC_RELAY_URL:'',BRIDGE_ICE_SERVERS:'[]',BRIDGE_CODEX_APP_SERVER_PATH:join(root,'no-codex'),BRIDGE_HERMES_EXECUTABLE:join(root,'no-hermes')};
for(const key of ['ELECTRON_RUN_AS_NODE','BRIDGE_SERVICE_DATA_PATH','BRIDGE_DEV_SERVER_URL','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL'])delete environment[key];
if(mobileMode)Object.assign(environment,{BRIDGE_RELAY_URL:relay.url,BRIDGE_PUBLIC_RELAY_URL:relay.url,BRIDGE_PAIRING_BASE_URL:rendererOrigin,BRIDGE_SERVICE_ORIGIN:rendererOrigin});
const {DesktopServiceClient}=await import(join(root,'service-client.cjs'));
const client=new DesktopServiceClient(join(userData,'background-service/connection.json'));
const executablePath=join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
let ui;let servicePid;let launchNumber=0;const proof={root};
async function launch(){
 const instance=await _electron.launch({executablePath,args:[application,'--bridge-packaged-qa'],env:environment,timeout:45000});
 const number=++launchNumber;const diagnostics=[];
 instance.process().stderr.on('data',data=>diagnostics.push(String(data)));
 try{
  const page=await waitFor(()=>{
   if(instance.process().exitCode!==null||instance.process().signalCode!==null)throw Error(`Desktop UI exited before opening: ${instance.process().exitCode??instance.process().signalCode}`);
   return instance.windows().find(candidate=>candidate.url().startsWith('file:'));
  },45000);
  await page.waitForFunction(async()=>Boolean(window.bridgeDesktop)&&(await window.bridgeDesktop.getSnapshot()).sessions.length>0,{},{timeout:30000});
  return {instance,page};
 }catch(error){
  const windows=instance.windows().map(page=>({url:page.url(),closed:page.isClosed()}));
  await writeFile(join(root,`launch-${number}-failure.json`),JSON.stringify({windows,stderr:diagnostics,error:String(error)},null,2));
  for(const [index,page] of instance.windows().entries())if(!page.isClosed())await page.screenshot({path:join(root,`launch-${number}-window-${index}.png`)});
  await instance.close();throw error;
 }
}
async function waitFor(fn,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw Error('QA condition timed out');}
async function events(){const response=await client.call('dispatchLocal',{method:'events.resume',params:{afterSeq:0,limit:1000}});assert.equal(response.ok,true,JSON.stringify(response));return response.result.events;}
async function openMobileSession(){
 if(await mobilePage.locator('textarea').isVisible())return;
 await mobilePage.locator('.project-group-open').first().waitFor();
 if(!await mobilePage.locator(`[data-session-id="${sessionId}"] .session-row-hit`).isVisible())await mobilePage.locator('.project-group-open').first().click();
 await mobilePage.locator(`[data-session-id="${sessionId}"] .session-row-hit`).click();
 await mobilePage.locator('textarea').waitFor();
}
async function mobileTurn(text){
 await openMobileSession();
 const from=relayFrames.length;
 await mobilePage.locator('textarea').fill(text);await mobilePage.getByRole('button',{name:'发送',exact:true}).click();
 const queued=await waitFor(async()=>(await events()).find(event=>event.type==='turn.queued'&&event.data.text===text));
 const outbound=relayFrames.slice(from).filter(frame=>frame.envelope.from==='mobile');
 assert.ok(outbound.length>0,'Mobile submission did not cross the relay');
 assert.ok(outbound.every(frame=>typeof frame.envelope.ciphertext==='string'&&!JSON.stringify(frame).includes(text)),'Relay exposed plaintext input');
 return {ok:true,result:{commandId:queued.data.commandId}};
}
async function taskEvidence(expected){
 const snapshot=await client.call('snapshot');
 const response=await client.call('dispatchLocal',{method:'session.history',params:{sessionId,limit:100}});
 assert.equal(response.ok,true,JSON.stringify(response));
 const session=snapshot.sessions.find(item=>item.sessionId===sessionId);
 assert.ok(snapshot.host.capabilities.includes('subagent.stop.v1'),'Service snapshot lacks task-stop capability');
 const tasks=response.result.history.items.flatMap(item=>item.subagent?[item.subagent]:[]).filter(task=>task.agentId.startsWith('qa-background-'));
 assert.equal(tasks.length,Object.keys(expected).length,JSON.stringify(tasks));
 for(const [taskId,state] of Object.entries(expected))assert.equal(tasks.find(task=>task.agentId===taskId)?.state,state,JSON.stringify(tasks));
 const running=Object.values(expected).filter(state=>state==='running').length;
 assert.equal(session.runningSubagents?.count??0,running);
 assert.equal(snapshot.runtime.activeTurns,0);
 return {at:Date.now(),session,activeTurns:snapshot.runtime.activeTurns,tasks};
}
try{
 ui=await launch();
 await client.connect();servicePid=client.servicePid;
 assert.equal(await readFile(join(root,'storage-proof'),'utf8'),'isolated-storage-test');proof.safeStorage=true;
 await ui.page.getByRole('button',{name:'状态',exact:true}).click();
 await ui.page.screenshot({path:join(root,'01-status.png')});
 const started=await client.call('dispatchLocal',{method:'turn.start',idempotencyKey:'qa-service-turn',params:{sessionId,text:'Run QA'}});
 assert.equal(started.ok,true,JSON.stringify(started));
 const pending=await waitFor(async()=>{const s=await client.call('snapshot');return s.permissions[0];});
 let cliPid=JSON.parse((await readFile(join(root,'cli-pids.jsonl'),'utf8')).trim().split('\n').at(-1)).pid;
 proof.servicePid=servicePid;proof.cliPid=cliPid;
 const queued=await client.call('dispatchLocal',{method:'turn.start',idempotencyKey:'qa-queued-turn',params:{sessionId,text:'Queued QA'}});
 assert.equal(queued.ok,true);assert.equal(queued.result.state,'queued');
 await ui.instance.close();ui=undefined;
 process.kill(servicePid,0);process.kill(cliPid,0);
 assert.equal((await client.call('snapshot')).permissions[0].requestId,pending.requestId);
 proof.normalUiExitPreservesTask=true;
 ui=await launch();
 assert.equal((await ui.page.evaluate(()=>window.bridgeDesktop.getSnapshot())).permissions[0].requestId,pending.requestId);
 const crashExit=once(ui.instance.process(),'exit');ui.instance.process().kill('SIGKILL');await crashExit;ui=undefined;
 process.kill(servicePid,0);process.kill(cliPid,0);proof.uiCrashPreservesTask=true;
 // A second client (like a remote controller) can approve work while no UI exists.
 await client.call('dispatchLocal',{method:'permission.resolve',params:{requestId:pending.requestId,decision:'allow-once'}});
 await waitFor(async()=>{const r=await client.call('dispatchLocal',{method:'events.resume',params:{afterSeq:0,limit:250}});return r.result?.events?.some(e=>e.type==='turn.completed'&&e.data.commandId===started.result.commandId);});
 assert.equal(JSON.parse((await readFile(join(root,'cli-pids.jsonl'),'utf8')).trim().split('\n').at(-1)).pid,cliPid);
 proof.permissionResolvedAfterRestart=true;
 proof.taskCompletesWithoutUi=true;
 const nextPermission=await waitFor(async()=>{const s=await client.call('snapshot');return s.permissions.find(p=>p.requestId!==pending.requestId);});
 proof.queueStartsWithoutUi=true;
 ui=await launch();
 assert.equal((await ui.page.evaluate(()=>window.bridgeDesktop.getSnapshot())).permissions[0].requestId,nextPermission.requestId);
 await client.call('dispatchLocal',{method:'permission.resolve',params:{requestId:nextPermission.requestId,decision:'allow-once'}});
 await waitFor(async()=>{const r=await client.call('dispatchLocal',{method:'events.resume',params:{afterSeq:0,limit:250}});return r.result?.events?.some(e=>e.type==='turn.completed'&&e.data.commandId===queued.result.commandId);});
 proof.queueContinuesAfterRestart=true;
 const duplicate=await client.call('dispatchLocal',{method:'turn.start',idempotencyKey:'qa-service-turn',params:{sessionId,text:'Run QA'}});
 assert.equal(duplicate.ok,true);assert.equal(duplicate.result.commandId,started.result.commandId);proof.idempotencyPreserved=true;
 await ui.page.screenshot({path:join(root,'02-reconnected.png')});
 if(mobileMode){
  const mobileApplication=join(root,'mobile-app');await mkdir(mobileApplication);
  await writeFile(join(mobileApplication,'package.json'),JSON.stringify({name:'bridge-mobile-service-qa',version:'1.0.0',main:'main.cjs'}));
  await writeFile(join(mobileApplication,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(root,'mobile-data'))});app.whenReady().then(()=>{const window=new BrowserWindow({width:430,height:920,webPreferences:{contextIsolation:true,nodeIntegration:false}});window.loadURL(${JSON.stringify(rendererOrigin)});});app.on('window-all-closed',()=>app.quit());`);
  mobile=await _electron.launch({executablePath,args:[mobileApplication],env:environment,timeout:40000});
  mobilePage=await mobile.firstWindow();
  // Exercise encrypted relay delivery without a direct WebRTC connection taking over.
  await mobilePage.context().addInitScript(()=>{Object.defineProperty(globalThis,'RTCPeerConnection',{value:undefined,configurable:true});});
  await mobilePage.reload();
  const pairing=await ui.page.evaluate(()=>window.bridgeDesktop.createPairing());
  assert.ok(pairing.pairingUrl);
  await mobilePage.getByRole('textbox',{name:'配对链接',exact:true}).fill(pairing.pairingUrl);
  await mobilePage.getByRole('button',{name:'连接电脑',exact:true}).click();
  await openMobileSession();
  assert.equal(await mobilePage.evaluate(()=>typeof window.bridgeDesktop),'undefined');
  proof.mobilePairedViaUi=true;
  await ui.instance.close();ui=undefined;
  const mobileRequest=await mobileTurn('Mobile encrypted approval QA');
  await waitFor(async()=>(await client.call('snapshot')).permissions.length===1);
  await mobilePage.getByRole('button',{name:'允许一次',exact:true}).click();
  await waitFor(async()=>(await events()).some(event=>event.type==='turn.completed'&&event.data.commandId===mobileRequest.result.commandId));
  await mobilePage.getByText('QA completed',{exact:true}).last().waitFor();
  proof.mobileEncryptedTurnAndApprovalWithoutDesktopUi=true;
  ui=await launch();
 }
 const background=mobileMode?await mobileTurn('Run background lifecycle QA'):await client.call('dispatchLocal',{method:'turn.start',idempotencyKey:'qa-background-lifecycle',params:{sessionId,text:'Run background lifecycle QA'}});
 assert.equal(background.ok,true,JSON.stringify(background));
 const submitted=await waitFor(async()=>(await events()).find(event=>event.type==='message.delivery'&&event.data.delivery==='submitted'&&event.data.commandId===background.result.commandId));
 await waitFor(async()=> (await readFile(join(root,'cli-wire.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)).some(row=>row.direction==='stdin'&&row.message.uuid===submitted.data.messageId));
 cliPid=JSON.parse((await readFile(join(root,'cli-pids.jsonl'),'utf8')).trim().split('\n').at(-1)).pid;proof.backgroundCliPid=cliPid;
 const beforeReplay=await events();
 assert.equal(beforeReplay.some(event=>event.type==='user.message.accepted'&&event.itemId===submitted.data.messageId),false);
 assert.equal(beforeReplay.some(event=>event.type==='turn.started'&&event.data.commandId===background.result.commandId),false);
 proof.queuedInputNotAcceptedBeforeReplay=true;
 process.kill(cliPid,'SIGUSR2');
 await waitFor(async()=>(await events()).some(event=>event.type==='turn.completed'&&event.data.commandId===background.result.commandId));
 assert.equal((await events()).filter(event=>event.type==='user.message.accepted'&&event.itemId===submitted.data.messageId).length,1);
 proof.echoedUserAcknowledgement=true;
 proof.backgroundBeforeUiExit=await taskEvidence({'qa-background-stop':'running','qa-background-exit':'running'});
 if(mobileMode){
  await waitFor(async()=>await mobilePage.locator('.conversation-subagent-card.is-running').count()===2);
  await waitFor(async()=>await mobilePage.locator('.conversation-subagent-card.is-running .subagent-stop-button').count()===2);
  proof.mobileLiveTaskStopControlsBeforeReload=true;
  await mobilePage.reload();await openMobileSession();
  await waitFor(async()=>await mobilePage.locator('.conversation-subagent-card.is-running').count()===2);
  proof.mobileReloadRestoresRunningTasks=true;
 }
 const backgroundStartedAt=Date.now();
 await ui.instance.close();ui=undefined;
 // Broker releases idle hosts after 15s. Keep actual background tasks alive beyond that boundary.
 while(Date.now()-backgroundStartedAt<20_000){
  process.kill(servicePid,0);process.kill(cliPid,0);
  assert.equal((await client.call('snapshot')).sessions.find(item=>item.sessionId===sessionId).runningSubagents?.count,2);
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 proof.backgroundSurvivesReleaseDelayMs=Date.now()-backgroundStartedAt;
 proof.backgroundWithoutUi=await taskEvidence({'qa-background-stop':'running','qa-background-exit':'running'});
 ui=await launch();
 assert.equal((await ui.page.evaluate(()=>window.bridgeDesktop.getSnapshot())).sessions.find(item=>item.sessionId===sessionId).runningSubagents.count,2);
 await ui.page.getByRole('button',{name:'会话',exact:true}).click();
 await ui.page.getByText('QA background stop',{exact:false}).first().waitFor({timeout:15000});
 await ui.page.screenshot({path:join(root,'03-background-reopened.png')});
 proof.backgroundUiReopen=true;
 if(mobileMode){
  await mobilePage.locator('.conversation-subagent-card').filter({hasText:'QA background stop'}).getByRole('button',{name:'停止',exact:true}).click();
  await mobilePage.getByRole('button',{name:'停止子代理',exact:true}).click();
  await waitFor(async()=>!(await mobilePage.getByRole('button',{name:'停止子代理',exact:true}).isVisible()));
  assert.equal(await mobilePage.locator('.conversation-subagent-card.is-running').count(),2);
  await mobilePage.screenshot({path:join(root,'05-mobile-stop-ack-running.png')});
 }else{
  const stop=await client.call('dispatchLocal',{method:'subagent.stop',params:{sessionId,agentId:'qa-background-stop'}});
  assert.equal(stop.ok,true,JSON.stringify(stop));
 }
 const wire=(await readFile(join(root,'cli-wire.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 const stopRequest=wire.find(row=>row.direction==='stdin'&&row.message.request?.subtype==='stop_task');
 assert.equal(stopRequest.message.request.task_id,'qa-background-stop');
 assert.ok(wire.some(row=>row.direction==='stdout'&&row.message.response?.request_id===stopRequest.message.request_id));
 proof.stopAcknowledgedStillRunning=await taskEvidence({'qa-background-stop':'running','qa-background-exit':'running'});
 process.kill(cliPid,'SIGUSR1');
 await waitFor(async()=>(await events()).some(event=>event.data.task?.taskId==='qa-background-stop'&&event.data.task.state==='stopped'));
 proof.directStopNotification=await taskEvidence({'qa-background-stop':'stopped','qa-background-exit':'running'});
 process.kill(cliPid,'SIGKILL');
 await waitFor(async()=>(await events()).some(event=>event.data.task?.taskId==='qa-background-exit'&&event.data.task.state==='failed'));
 proof.cliExitSettlesUnfinished=await taskEvidence({'qa-background-stop':'stopped','qa-background-exit':'failed'});
 if(mobileMode){
  await waitFor(async()=>await mobilePage.locator('.conversation-subagent-card.is-stopped').count()===1&&await mobilePage.locator('.conversation-subagent-card.is-failed').count()===1);
  await mobilePage.reload();await openMobileSession();
  await waitFor(async()=>await mobilePage.locator('.conversation-subagent-card.is-stopped').count()===1&&await mobilePage.locator('.conversation-subagent-card.is-failed').count()===1);
  assert.equal(await mobilePage.locator('.conversation-subagent-card.is-running').count(),0);
  await mobilePage.screenshot({path:join(root,'06-mobile-terminal-replayed.png')});
  proof.mobileTerminalReplayAfterReload=true;
  proof.mobileRelay={metrics:relay.metrics(),outboundEncryptedEnvelopes:relayFrames.filter(frame=>frame.envelope.from==='mobile').length};
 }
 await ui.page.screenshot({path:join(root,'04-background-terminal.png')});
 await client.call('dispatchLocal',{method:'turn.start',idempotencyKey:'qa-stop-service',params:{sessionId,text:'Wait for service shutdown'}});
 await waitFor(async()=>{const s=await client.call('snapshot');return s.permissions.length>0;});
 const shutdownCliPid=JSON.parse((await readFile(join(root,'cli-pids.jsonl'),'utf8')).trim().split('\n').at(-1)).pid;
 assert.notEqual(shutdownCliPid,cliPid);proof.restartsCliAfterExit=true;
 await ui.instance.close();ui=undefined;
 await client.shutdown();client.close();
 await waitFor(()=>{try{process.kill(servicePid,0);return false;}catch{return true;}});
 await waitFor(()=>{try{process.kill(shutdownCliPid,0);return false;}catch{return true;}});
 proof.explicitShutdownStopsRuntime=true;servicePid=undefined;
 await writeFile(join(root,'proof.json'),JSON.stringify(proof,null,2)+'\n');
 console.log(JSON.stringify(proof,null,2));
} catch(error){
 proof.failure=error instanceof Error?error.stack:String(error);
 await writeFile(join(root,'proof.json'),JSON.stringify(proof,null,2)+'\n');
 if(mobilePage&&!mobilePage.isClosed())await mobilePage.screenshot({path:join(root,'failure-mobile.png')});
 if(ui&&!ui.page.isClosed())await ui.page.screenshot({path:join(root,'failure-desktop.png')});
 console.error(`QA evidence: ${root}`);throw error;
} finally {
 if(ui)await ui.instance.close();
 if(servicePid){await client.shutdown();await waitFor(()=>{try{process.kill(servicePid,0);return false;}catch{return true;}});}
 if(mobile)await mobile.close();
 client.close();await new Promise(resolve=>models.close(resolve));
 if(rendererServer)await new Promise(resolve=>rendererServer.close(resolve));
 if(relay)await relay.close();
}
