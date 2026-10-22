import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';
import { Controller } from '../src/controller.mjs';
import { runCli } from '../src/cli.mjs';
import { execFileSync } from 'node:child_process';

test('unchanged projection preserves reply bytes without rewriting ledger or reply assets', async t => {
  const f = await fixture(t);
  await f.controller.send({task:'test',text:'input',allowModel:true});
  const id=(await f.store.task('test')).requests[0].requestId;
  const events=turn(id); await f.controller.apply('test',events);
  const written=[], write=f.store.writeFile.bind(f.store);
  f.store.writeFile=async(name,content)=>{written.push(name);return write(name,content);};
  await f.controller.apply('test',events);
  assert.deepEqual(written,[]);
  const request=(await f.store.task('test')).requests[0];
  assert.equal(request.resultSha256.length,64);
  await fs.writeFile(request.resultFile,'damaged');
  await f.controller.apply('test',events);
  assert.ok(written.some(name=>name.startsWith('reply-')));
});

test('observer lease rejects duplicate watcher and releases after close', async t => {
  const f=await fixture(t), first=await f.controller.watch('test');
  await assert.rejects(f.controller.watch('test'),{code:'STATE_LOCKED'});
  await first.close(); await first.close();
  const second=await f.controller.watch('test'); await second.close();
});

test('watch coalesces a native event burst into one projection without dropping frames', async t=>{
  const f=await fixture(t); await f.controller.send({task:'test',text:'input',allowModel:true});
  const id=(await f.store.task('test')).requests[0].requestId;
  const watcher=await f.controller.watch('test');
  try {
    const apply=f.controller.apply.bind(f.controller); let projections=0;
    f.controller.apply=async(...args)=>{projections++;return apply(...args);};
    for(const event of turn(id)){f.events.push(event);f.streams.get('session/follow').onItem({type:'event',event});}
    await watcher.tick();
    assert.equal(projections,1); assert.equal((await f.store.task('test')).requests[0].state,'COMPLETED');
  } finally {await watcher.close();}
});

async function workspaceFixture(f) {
  const client=await f.controller.client(await f.store.task('test'));
  const workspace={workspaceId:'workspace:fixture',path:f.root,title:'Native workspace',sessionIds:[]};
  const stream=client.stream.bind(client), rpc=client.rpc.bind(client);
  client.stream=(endpoint,args,callbacks)=>{
    if(endpoint!=='workspace/follow')return stream(endpoint,args,callbacks);
    let close;
    const closed=new Promise(resolve=>{close=resolve;});
    queueMicrotask(()=>callbacks.onItem({type:'baseline',value:{items:[{...workspace,sessionIds:[...workspace.sessionIds]}],archivedSessionIds:[],pinnedSessionIds:[]}}));
    return {ready:Promise.resolve(),closed,close};
  };
  client.rpc=async(method,args)=>{
    if(method==='session/create'){
      f.calls.push({method,args}); f.header.id=args.request.sessionId;
      workspace.sessionIds.push(args.request.sessionId);return {sessionId:args.request.sessionId};
    }
    return rpc(method,args);
  };
  return workspace;
}

test('workspace start uses native workspaceId and verifies actual membership', async t=>{
  const f=await fixture(t), workspace=await workspaceFixture(f);
  const value=await f.controller.start({connection:'local',cwd:f.root,task:'registered',workspace:workspace.workspaceId});
  const request=f.calls.find(c=>c.method==='session/create').args.request;
  assert.equal(request.workspaceId,workspace.workspaceId);assert.equal(request.cwd,undefined);
  assert.ok(workspace.sessionIds.includes(value.sessionId));assert.equal((await f.store.task('registered')).state,'READY');
});

test('workspace mismatch and unaccounted existing session reject without native mutation', async t=>{
  const f=await fixture(t), workspace=await workspaceFixture(f), original={...f.header};
  await assert.rejects(f.controller.start({connection:'local',cwd:f.root,task:'unaccounted',session:f.header.id,workspace:workspace.workspaceId}),{code:'SESSION_WORKSPACE_MEMBERSHIP_UNKNOWN'});
  const other=path.join(f.root,'other');await fs.mkdir(other);workspace.path=other;
  await assert.rejects(f.controller.start({connection:'local',cwd:f.root,task:'wrong-workspace',workspace:workspace.workspaceId}),{code:'SESSION_WORKSPACE_CWD_MISMATCH'});
  assert.equal(f.calls.filter(c=>['session/create','session/prompt'].includes(c.method)).length,0);
  assert.deepEqual(f.header,original);
});

test('workspace membership loss blocks a previously bound task before prompt',async t=>{
  const f=await fixture(t), workspace=await workspaceFixture(f);
  await f.controller.start({connection:'local',cwd:f.root,task:'registered',workspace:workspace.workspaceId});
  workspace.sessionIds=[];
  await assert.rejects(f.controller.send({task:'registered',text:'must not send',allowModel:true}),{code:'SESSION_WORKSPACE_MEMBERSHIP_UNKNOWN'});
  assert.equal(f.calls.filter(c=>c.method==='session/prompt').length,0);
});

test('bound contract rejects missing or stale hash with zero prompt and sends an explicit contract reference',async t=>{
  const f=await fixture(t); const git=(...args)=>execFileSync('git',['-C',f.root,...args],{stdio:'pipe'});
  git('init');git('config','user.email','fixture@example.invalid');git('config','user.name','fixture');
  await fs.writeFile(path.join(f.root,'source.txt'),'baseline');git('add','.');git('commit','-m','baseline');
  const {ContractService}=await import('../src/contract.mjs');
  const contract={id:'contract',revision:1,nativeCwd:f.root,executionRoot:f.root,gitOwner:'Codex',authorizationRef:'fixture-user-task',feeAuthorizationRef:null,stopConditions:['stop on scope conflict'],allowedFiles:['source.txt'],protectedFiles:[],requirements:[{id:'r1',text:'preserve all requirements'}],testPlan:[]};
  const {contractSha}=await new ContractService({store:f.store}).bind({task:'test',contract});
  await assert.rejects(f.controller.send({task:'test',text:'delta',allowModel:true}),{code:'CONTRACT_HASH_MISMATCH'});
  await assert.rejects(f.controller.send({task:'test',text:'delta',allowModel:true,contractSha:'old'}),{code:'CONTRACT_HASH_MISMATCH'});
  assert.equal(f.calls.filter(c=>c.method==='session/prompt').length,0);
  await f.controller.send({task:'test',text:'delta',allowModel:true,contractSha});
  const text=f.calls.find(c=>c.method==='session/prompt').args.request.content[0].text;
  assert.ok(text.includes(contractSha));assert.ok(text.includes('preserve all requirements'));assert.ok(text.endsWith('delta'));
  const stored=(await f.store.task('test')).requests.at(-1);
  assert.equal(await fs.readFile(stored.dispatchFile,'utf8'),text);
});

test('stop requested during contract validation prevents dispatch after validation completes',async t=>{
  const f=await fixture(t);await f.store.transaction(s=>{s.tasks.test.contractRef={file:'contract-fixture.json',sha:'current'};});
  const {ContractService}=await import('../src/contract.mjs');const check=ContractService.prototype.check;
  let release,entered;const gate=new Promise(r=>{release=r;}),reached=new Promise(r=>{entered=r;});
  ContractService.prototype.check=async()=>{entered();await gate;return{contract:{id:'contract',revision:1}};};
  try{
    const sending=f.controller.send({task:'test',text:'delta',allowModel:true,contractSha:'current'});
    const rejection=assert.rejects(sending,{code:'TASK_STOPPED'});await reached;
    const stopping=f.controller.stop({task:'test'});
    const deadline=Date.now()+2000;while(!(await f.store.task('test')).stopRequested && Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    assert.equal((await f.store.task('test')).stopRequested,true);release();await rejection;await stopping;
    assert.equal(f.calls.filter(c=>c.method==='session/prompt').length,0);
  }finally{release?.();ContractService.prototype.check=check;}
});

test('stop after final preflight read prevents native RPC initiation',async t=>{
  const f=await fixture(t),read=f.store.task.bind(f.store);
  let armed=false,readsAfterHeader=0;
  const history=f.controller.historyReader;
  f.controller.historyReader=async(...args)=>{const value=await history(...args);if((await read('test')).requests.length)armed=true;return value;};
  f.store.task=async id=>{
    const value=await read(id);
    if(armed && ++readsAfterHeader===2 && !value.stopRequested){
      armed=false;
      await f.store.transaction(s=>{s.tasks.test.stopRequested=true;});
      return value;
    }
    return value;
  };
  await assert.rejects(f.controller.send({task:'test',text:'input',allowModel:true}),{code:'TASK_STOPPED'});
  assert.equal(f.calls.filter(c=>c.method==='session/prompt').length,0);
  assert.equal((await read('test')).requests[0].state,'REJECTED');
});

test('listen publishes approval while lease remains live and sends explicit decision', async t => {
  const f=await fixture(t); await f.controller.send({task:'test',text:'input',allowModel:true});
  const requestId=(await f.store.task('test')).requests[0].requestId;
  f.events.push(...turn(requestId).slice(0,2),{seq:2,type:'tool/call',data:{callId:'known',name:'write'}});
  const updates=[]; let injected=false, decided=false, ended=false;
  await f.controller.listen({task:'test',wait:2,onUpdate:async value=>{
    updates.push(value);
    if(value.leaseOpen && !injected){injected=true;f.streams.get('$events').onItem({type:'waterfall',eventId:'approve-write',event:'approval/request',agentId:'native-session',request:{callId:'known',path:'file-to-review'}});}
    const pending=value.approvals.find(a=>a.state==='PENDING');
    if(pending && !decided){decided=true;assert.equal(value.leaseOpen,true);await f.controller.approve({task:'test',approval:pending.eventId,decision:'allowed-once'});}
    if(decided && !ended && f.calls.some(c=>c.method==='$events/result')){ended=true;const end={seq:3,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}};f.events.push(end);f.streams.get('session/follow').onItem({type:'event',event:end});}
  }});
  assert.equal(decided,true);
  assert.ok(f.calls.some(c=>c.method==='$events/result' && c.args.outcome.kind==='result' && c.args.outcome.value==='allowed-once'));
  assert.equal(updates.at(-1).leaseOpen,false);
  assert.equal(updates.at(-1).state,'COMPLETED');
});

test('listen closes unresolved approval on lease expiry rather than returning a stale approval', async t => {
  const f=await fixture(t); await f.controller.send({task:'test',text:'input',allowModel:true});
  const id=(await f.store.task('test')).requests[0].requestId;
  f.events.push(...turn(id).slice(0,2),{seq:2,type:'tool/call',data:{callId:'known',name:'write'}});
  let injected=false; const updates=[];
  await f.controller.listen({task:'test',wait:0.2,onUpdate:value=>{updates.push(value);if(!injected){injected=true;f.streams.get('$events').onItem({type:'waterfall',eventId:'expire-this',event:'approval/request',agentId:'native-session',request:{callId:'known'}});}}});
  assert.ok(updates.some(v=>v.leaseOpen && v.approvals.some(a=>a.eventId==='expire-this')));
  assert.deepEqual(updates.at(-1).approvals,[]); assert.equal(updates.at(-1).leaseOpen,false);
  await assert.rejects(f.controller.approve({task:'test',approval:'expire-this',decision:'allowed-once'}),{code:'APPROVAL_EXPIRED'});
});

test('stop cancels exclusive session while another observer holds the lease', async t=>{
  const f=await fixture(t); await f.controller.send({task:'test',text:'input',allowModel:true});
  const id=(await f.store.task('test')).requests[0].requestId;
  f.events.push(...turn(id).slice(0,2)); f.running(true);
  const watcher=await f.controller.watch('test');
  try {
  const client=await f.controller.client(await f.store.task('test')), rpc=client.rpc.bind(client);
  client.rpc=async(method,args)=>{const result=await rpc(method,args);if(method==='session/cancel'){f.running(false);const end={seq:2,type:'turn/end',data:{turn:1,reason:{kind:'aborted'}}};f.events.push(end);f.streams.get('session/follow').onItem({type:'event',event:end});await watcher.tick();}return result;};
  const result=await f.controller.stop({task:'test'});
  assert.equal(result.state,'STOPPED'); assert.equal(result.stopAttempt.cancelAck.accepted,true);
  assert.equal(f.calls.filter(c=>c.method==='session/cancel').length,1);
  await assert.rejects(f.controller.watch('test'),{code:'STATE_LOCKED'});
  } finally { await watcher.close(); }
});

test('stop barrier prevents queued approval delivery and further approval decisions',async t=>{
  const f=await fixture(t);await f.controller.send({task:'test',text:'input',allowModel:true});
  const id=(await f.store.task('test')).requests[0].requestId;
  f.events.push(...turn(id).slice(0,2),{seq:2,type:'tool/call',data:{callId:'known',name:'write'}});
  const watcher=await f.controller.watch('test');
  try{
    f.streams.get('$events').onItem({type:'waterfall',eventId:'queued-before-stop',event:'approval/request',agentId:'native-session',request:{callId:'known'}});
    await watcher.tick();await f.controller.approve({task:'test',approval:'queued-before-stop',decision:'allowed-once'});
    await f.store.transaction(s=>{s.tasks.test.stopRequested=true;});
    await watcher.tick();
    assert.equal(f.calls.filter(c=>c.method==='$events/result' && c.args.outcome.kind==='result').length,0);
    assert.equal((await f.store.task('test')).approvals['queued-before-stop'].state,'EXPIRED');
    await assert.rejects(f.controller.approve({task:'test',approval:'queued-before-stop',decision:'allowed-once'}),{code:'TASK_STOPPED'});
  }finally{await watcher.close();}
});

test('stop arriving after approval selection but before dispatch prevents delivery',async t=>{
  const f=await fixture(t);await f.controller.send({task:'test',text:'input',allowModel:true});
  const id=(await f.store.task('test')).requests[0].requestId;
  f.events.push(...turn(id).slice(0,2),{seq:2,type:'tool/call',data:{callId:'known',name:'write'}});
  const watcher=await f.controller.watch('test');
  const original=f.store.withLock.bind(f.store);
  try{
    f.streams.get('$events').onItem({type:'waterfall',eventId:'racing-stop',event:'approval/request',agentId:'native-session',request:{callId:'known'}});
    await watcher.tick();await f.controller.approve({task:'test',approval:'racing-stop',decision:'allowed-once'});
    let intercepted=false;
    f.store.withLock=async(name,callback,options)=>{
      if(name==='dispatch-test.lock' && !intercepted){
        intercepted=true;
        assert.equal((await f.store.task('test')).approvals['racing-stop'].state,'SENDING');
        await f.store.transaction(s=>{s.tasks.test.stopRequested=true;});
      }
      return original(name,callback,options);
    };
    await watcher.tick();assert.equal(intercepted,true);
    assert.equal(f.calls.filter(c=>c.method==='$events/result' && c.args.outcome.kind==='result').length,0);
    assert.equal((await f.store.task('test')).approvals['racing-stop'].state,'EXPIRED');
  }finally{f.store.withLock=original;await watcher.close();}
});

async function fixture(t, { shared = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dsh-controller-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await StateStore.open(path.join(root, 'state'));
  const events = [], calls = [], streams = new Map();
  const header = { id: 'native-session', cwd: root };
  let failure, queue = [], running = false;
  const client = {
    async rpc(method, args) {
      calls.push({ method, args });
      if (method === 'session/projections') return { values: { inbox: { 'next-turn': queue, 'next-step': [] } } };
      if (method === 'session/list') return { items: [{ sessionId: 'native-session', running }] };
      if (method === 'session/prompt' && failure) throw failure;
      return { accepted: true };
    },
    stream(endpoint, args, callbacks) {
      streams.set(endpoint, callbacks);
      queueMicrotask(() => callbacks.onItem(endpoint === '$events' ? { type: 'ready', clientId: 'test-client' } : { type: 'snapshot', header, records: events.map(event => ({ type: 'event', event })) }));
      return { ready: Promise.resolve(), closed: Promise.resolve(), close() { callbacks.onClose?.(); } };
    },
  };
  const controller = new Controller({ store, clientFactory: () => client, historyReader: async () => ({ header, events: [...events] }) });
  await store.transaction(state => {
    state.connections.local = { baseUrl: 'http://127.0.0.1:9000', cookie: 'secret-fixture' };
    state.tasks.test = { cwd: root, id: 'test', sessionId: 'native-session', connection: 'local', state: 'READY', scope: shared ? 'shared' : 'exclusive', requests: [], approvals: {}, liveSeqs: [] };
  });
  return { root, store, controller, header, calls, events, streams, fail: value => { failure = value; }, queue: value => { queue = value; }, running: value => { running = value; } };
}
test('wrong native cwd blocks an old READY task before prompt', async t => {
  const f = await fixture(t);
  f.header.cwd = path.join(f.root, 'other');
  await fs.mkdir(f.header.cwd);
  await assert.rejects(f.controller.send({ task: 'test', text: 'input', allowModel: true }), { code: 'SESSION_CWD_MISMATCH' });
  assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 0);
});
test('missing native cwd and incorrect session id reject resume and send without prompt', async t => {
  const f = await fixture(t);
  delete f.header.cwd;
  await assert.rejects(f.controller.resume({ task: 'test' }), { code: 'SESSION_CWD_UNKNOWN' });
  await assert.rejects(f.controller.send({ task: 'test', text: 'input', allowModel: true }), { code: 'SESSION_CWD_UNKNOWN' });
  f.header.cwd = f.root; f.header.id = 'different';
  await assert.rejects(f.controller.resume({ task: 'test' }), { code: 'SESSION_ID_MISMATCH' });
  assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 0);
});
test('shared attach verifies actual native cwd and does not alter its header', async t => {
  const f = await fixture(t);
  const other = path.join(f.root, 'other'); await fs.mkdir(other);
  await assert.rejects(f.controller.start({ connection: 'local', task: 'shared', cwd: other, session: 'other-session' }), { code: 'SESSION_ID_MISMATCH' });
  f.header.id = 'other-session';
  await assert.rejects(f.controller.resume({ task: 'shared' }), { code: 'SESSION_CWD_MISMATCH' });
  assert.equal(f.header.cwd, f.root);
  assert.equal((await f.store.task('shared')).state, 'CREATING');
  assert.equal(f.calls.filter(c => ['session/create', 'session/prompt'].includes(c.method)).length, 0);
});
test('watch snapshot missing cwd rejects before prompt even after valid history', async t => {
  const f = await fixture(t), client = await f.controller.client(await f.store.task('test'));
  const original = client.stream.bind(client);
  client.stream = (endpoint, args, callbacks) => original(endpoint, args, {
    ...callbacks, onItem: item => callbacks.onItem(item.type === 'snapshot' ? { ...item, header: { id: 'native-session' } } : item),
  });
  await assert.rejects(f.controller.send({ task: 'test', text: 'input', allowModel: true, wait: 0.01 }), { code: 'SESSION_CWD_UNKNOWN' });
  assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 0);
});
test('watch disconnection retains safe native diagnostic through close without secret payloads', async t => {
  const f = await fixture(t), watcher = await f.controller.watch('test');
  const diagnostic = { stage: 'stream', category: 'protocol_unknown', knownRejected: false, method: 'session/follow', raw: 'SECRET', details: { cookie: 'SECRET' } };
  f.streams.get('session/follow').onError(Object.assign(new Error('SECRET'), { diagnostic }));
  f.streams.get('session/follow').onClose();
  await assert.rejects(watcher.tick(), error => {
    assert.equal(error.code, 'WATCH_DISCONNECTED');
    assert.deepEqual(error.diagnostic, { stage: 'stream', category: 'protocol_unknown', knownRejected: false, method: 'session/follow' });
    assert.ok(!error.message.includes('SECRET')); assert.ok(!JSON.stringify(error).includes('SECRET'));
    assert.equal(error.cause, undefined); return true;
  });
  await watcher.close();
});
test('native cwd changed during dispatch setup rejects persisted intent without sending', async t => {
  const f = await fixture(t), original = f.controller.client.bind(f.controller);
  const other = path.join(f.root, 'other'); await fs.mkdir(other);
  f.controller.client = async task => {
    const client = await original(task);
    if (task.requests.at(-1)?.state === 'SUBMITTING') f.header.cwd = other;
    return client;
  };
  await assert.rejects(f.controller.send({ task: 'test', text: 'input', allowModel: true }), { code: 'SESSION_CWD_MISMATCH' });
  assert.equal((await f.store.task('test')).requests[0].state, 'REJECTED');
  assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 0);
});

test('bound discovery uses exact wire titles and canonical cwd; recovery never creates or prompts', async t => {
  const f = await fixture(t), client = await f.controller.client(await f.store.task('test'));
  const rpc = client.rpc.bind(client);
  client.rpc = (method, args) => method === 'session/list' ? Promise.resolve({ items: [
    { sessionId: 'native-session', running: false, projections: { values: { title: 'Exact title' } } },
    { sessionId: 'unbound', running: true, projections: { values: { title: 'Exact title' } } },
  ] }) : rpc(method, args);
  const result = await f.controller.tasks({ connection: 'local', cwd: f.root, title: 'Exact title', active: false });
  assert.deepEqual(result.tasks.map(row => row.task), ['test']);
  assert.equal(result.tasks[0].title, 'Exact title'); assert.equal(result.tasks[0].active, false);
  assert.equal((await f.controller.tasks({ connection: 'local', title: 'exact title' })).tasks.length, 0);
  await assert.rejects(f.controller.recover({ connection: 'local', title: 'missing' }), { code: 'TASK_NOT_FOUND' });
  assert.equal((await f.controller.recover({ connection: 'local', title: 'Exact title' })).task, 'test');
  assert.equal(f.calls.filter(c => ['session/create', 'session/prompt'].includes(c.method)).length, 0);
});
test('ambiguous bound recovery reports only candidate task IDs; unresolved submission is active', async t => {
  const f = await fixture(t);
  await f.store.transaction(state => {
    state.tasks.second = { ...structuredClone(state.tasks.test), id: 'second', sessionId: 'second-session' };
    state.tasks.test.requests.push({ requestId: 'unknown', state: 'SUBMISSION_UNKNOWN' });
  });
  const read = f.controller.historyReader;
  f.controller.historyReader = async (client, sessionId) => ({ ...(await read(client, sessionId)), header: { id: sessionId, cwd: f.root } });
  await assert.rejects(f.controller.recover({ connection: 'local' }), error => {
    assert.equal(error.code, 'AMBIGUOUS_TASK'); assert.deepEqual(error.candidates, ['test', 'second']); return true;
  });
  assert.deepEqual((await f.controller.tasks({ connection: 'local', active: true })).tasks.map(row => row.task), ['test']);
  assert.equal((await f.controller.recover({ connection: 'local', active: true })).state, 'SUBMISSION_UNKNOWN');
  assert.equal(f.calls.filter(c => ['session/create', 'session/prompt'].includes(c.method)).length, 0);
  await assert.rejects(f.controller.recover({ task: 'test', connection: 'local' }), { code: 'INVALID_RECOVERY_SELECTOR' });
});
test('unknown native activity remains unknown and cannot satisfy inactive recovery', async t => {
  const f = await fixture(t), client = await f.controller.client(await f.store.task('test'));
  const rpc = client.rpc.bind(client);
  client.rpc = (method, args) => method === 'session/list' ? Promise.resolve({ items: [] }) : rpc(method, args);
  assert.equal((await f.controller.tasks({ connection: 'local' })).tasks[0].active, null);
  await assert.rejects(f.controller.recover({ connection: 'local', active: false }), { code: 'TASK_NOT_FOUND' });
});
test('unknown and rejected prompt diagnostics retain only safe fields in ledger and summaries', async t => {
  const f = await fixture(t);
  const diagnostic = { stage: 'rpc', category: 'transport_unknown', knownRejected: false, method: 'session/prompt', details: 'SECRET', raw: 'SECRET' };
  f.fail(Object.assign(new Error('SECRET'), { diagnostic }));
  const result = await f.controller.send({ task: 'test', text: 'input', allowModel: true });
  assert.deepEqual(result.requests[0].diagnostic, { stage: 'rpc', category: 'transport_unknown', knownRejected: false, method: 'session/prompt' });
  assert.ok(!JSON.stringify(await f.store.task('test')).includes('SECRET'));
  await f.store.transaction(state => { state.tasks.test.requests[0].state = 'REJECTED'; });
  f.fail(Object.assign(new Error('SECRET'), { knownRejected: true, diagnostic: { ...diagnostic, category: 'invalid_request', knownRejected: true } }));
  await assert.rejects(f.controller.send({ task: 'test', text: 'new input', allowModel: true }), error => {
    assert.equal(error.code, 'NATIVE_REJECTED'); assert.equal(error.diagnostic.category, 'invalid_request');
    assert.ok(!JSON.stringify(error).includes('SECRET')); return true;
  });
});
test('stop raised during final identity read still blocks dispatch', async t => {
  const f = await fixture(t), read = f.controller.historyReader;
  let reads = 0;
  f.controller.historyReader = async (...args) => {
    const result = await read(...args);
    if (++reads === 2) await f.store.transaction(state => { state.tasks.test.stopRequested = true; });
    return result;
  };
  await assert.rejects(f.controller.send({ task: 'test', text: 'input', allowModel: true }), { code: 'TASK_STOPPED' });
  assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 0);
});
test('a stale legacy refresh cannot replace a concurrently established directory identity', async t => {
  const f = await fixture(t), project = path.join(f.root, 'project');
  await fs.mkdir(project); f.header.cwd = project;
  await f.store.transaction(state => { state.tasks.test.cwd = project; });
  const original = f.controller.historyReader;
  let release, entered, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  f.controller.historyReader = async (...args) => {
    if (++reads === 1) { entered(); await gate; }
    return original(...args);
  };
  const stale = f.controller.refresh('test');
  await reached;
  await f.controller.refresh('test');
  const established = (await f.store.task('test')).cwdIdentity;
  await fs.rename(project, path.join(f.root, 'original-project')); await fs.mkdir(project);
  const rejected = assert.rejects(stale, { code: 'SESSION_CWD_MISMATCH' });
  release(); await rejected;
  assert.deepEqual((await f.store.task('test')).cwdIdentity, established);
  await assert.rejects(f.controller.send({ task: 'test', text: 'input', allowModel: true }), { code: 'SESSION_CWD_MISMATCH' });
  assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 0);
});
function turn(id, answer = 'answer') { return [
  { seq: 0, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, type: 'user/message', data: { source: { rpcId: id }, id: 'message-one' } },
  { seq: 2, type: 'assistant/message', data: { content: [{ type: 'text', text: answer }] } },
  { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]; }
test('unacknowledged submission persists intent and cannot be blindly retried, including after restart', async t => {
  const f = await fixture(t); f.fail(new Error('secret URL must not escape'));
  const result = await f.controller.send({ task: 'test', text: 'private input', allowModel: true });
  assert.equal(result.state, 'SUBMISSION_UNKNOWN');
  const request = (await f.store.task('test')).requests[0];
  assert.equal(await fs.readFile(request.inputFile, 'utf8'), 'private input');
  await assert.rejects(f.controller.send({ task: 'test', text: 'retry', allowModel: true }), { code: 'UNRESOLVED_REQUEST' });
  assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 1);
  await f.store.transaction(state => { state.tasks.test.requests[0].state = 'SUBMITTING'; });
  assert.equal((await f.controller.resume({ task: 'test' })).state, 'SUBMISSION_UNKNOWN');
});
test('unrelated completed turn does not complete request; correlated full answer is preserved', async t => {
  const f = await fixture(t);
  await f.controller.send({ task: 'test', text: 'input', allowModel: true });
  f.events.push(...turn('someone-else'));
  assert.equal((await f.controller.status({ task: 'test' })).state, 'SUBMITTED');
  const id = (await f.store.task('test')).requests[0].requestId;
  const answer = '完整答复'.repeat(400000);
  f.events.splice(0, f.events.length, ...turn(id, answer));
  const result = await f.controller.status({ task: 'test' });
  assert.equal(result.state, 'COMPLETED');
  assert.equal(await fs.readFile(result.requests[0].resultFile, 'utf8'), answer);
  assert.ok(!JSON.stringify(result).includes('完整答复'));
});
test('known native rejection allows a later explicit request and requires authorization every time', async t => {
  const f = await fixture(t);
  await assert.rejects(f.controller.send({ task: 'test', text: 'input' }), { code: 'MODEL_PERMISSION_REQUIRED' });
  f.fail(Object.assign(new Error('native rejection'), { knownRejected: true }));
  await assert.rejects(f.controller.send({ task: 'test', text: 'input', allowModel: true }), { code: 'NATIVE_REJECTED' });
  assert.equal((await f.store.task('test')).requests[0].state, 'REJECTED');
  f.fail(undefined);
  await f.controller.send({ task: 'test', text: 'new authorized input', allowModel: true });
  assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 2);
});
test('resume reconciles uncertain session creation without creating or prompting again', async t => {
  const f = await fixture(t);
  await f.store.transaction(state => { state.tasks.test.state = 'CREATE_UNKNOWN'; });
  assert.equal((await f.controller.resume({ task: 'test' })).state, 'READY');
  assert.equal(f.calls.filter(c => ['session/create', 'session/prompt'].includes(c.method)).length, 0);
});
test('connection aliases cannot attach a second controller task to the same native session', async t => {
  const f = await fixture(t);
  await f.store.transaction(state => { state.connections.alias = { ...state.connections.local }; });
  await assert.rejects(f.controller.start({ task: 'second', connection: 'alias', session: 'native-session', cwd: f.root }), { code: 'SESSION_ALREADY_ATTACHED' });
  assert.equal(f.calls.filter(c => c.method === 'session/create').length, 0);
});
test('an older concurrent status snapshot cannot regress cursor or completed request', async t => {
  const f = await fixture(t);
  await f.controller.send({ task: 'test', text: 'input', allowModel: true });
  const id = (await f.store.task('test')).requests[0].requestId;
  await f.controller.apply('test', turn(id));
  const stale = await f.controller.apply('test', turn(id).slice(0, 3));
  assert.equal(stale.state, 'COMPLETED'); assert.equal(stale.cursor, 3);
});
test('exclusive idle session with observed tool activity cannot be reported fully stopped', async t => {
  const f = await fixture(t);
  await f.controller.send({ task: 'test', text: 'input', allowModel: true });
  const id = (await f.store.task('test')).requests[0].requestId;
  f.events.push(...turn(id).slice(0, 2),
    { seq: 2, type: 'tool/call', data: { name: 'schedule_create', callId: 'schedule-one' } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  const result = await f.controller.stop({ task: 'test' });
  assert.equal(result.state, 'STOP_PENDING');
  assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 1);
  assert.equal(f.calls.filter(c => /archive|schedule.*(remove|delete)/.test(c.method)).length, 0);
});
test('missing native queue projection is unknown rather than proof of an empty queue', async t => {
  const f = await fixture(t), client = await f.controller.client(await f.store.task('test'));
  const rpc = client.rpc.bind(client);
  client.rpc = (method, args) => method === 'session/projections' ? Promise.resolve({ values: {} }) : rpc(method, args);
  assert.equal((await f.controller.stop({ task: 'test' })).state, 'STOP_PENDING');
});
test('stop receipt persists accepted cancel separately from a still running associated turn', async t => {
  const f = await fixture(t);
  await f.controller.send({ task: 'test', text: 'input', allowModel: true });
  const requestId = (await f.store.task('test')).requests[0].requestId;
  f.events.push(...turn(requestId).slice(0, 2)); f.running(true);
  const client = await f.controller.client(await f.store.task('test')), rpc = client.rpc.bind(client);
  client.rpc = async (method, args) => {
    if (method === 'session/cancel') {
      const attempt = (await f.store.task('test')).stopAttempt;
      assert.equal(attempt.phase, 'cancel'); assert.equal(attempt.cancelRequested, true);
      assert.equal(attempt.before.running, null);
    }
    return rpc(method, args);
  };
  const result = await f.controller.stop({ task: 'test' });
  assert.equal(result.state, 'STOP_PENDING');
  assert.equal(result.stopAttempt.phase, 'finished');
  assert.equal(result.stopAttempt.cancelAck.accepted, true);
  assert.ok(result.stopAttempt.cancelAck.durationMs >= 0);
  assert.deepEqual(result.stopAttempt.after, { running: true, queueCount: 0, ownedQueueCount: 0, associatedTurns: [1] });
  assert.equal(result.stopDiagnostic.code, 'STOP_REQUEST_RUNNING');
  assert.ok(Date.parse(result.stopAttempt.endedAt) >= Date.parse(result.stopAttempt.startedAt));
  assert.deepEqual((await f.store.task('test')).stopAttempt, result.stopAttempt);
  assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 1);
});
test('stop receipt records watch readiness failure without cancel or raw error data', async t => {
  const f = await fixture(t);
  f.controller.watch = async () => { throw Object.assign(new Error('SECRET'), { code: 'SECRET', details: 'SECRET', diagnostic: { stage: 'stream', category: 'timeout', knownRejected: false, raw: 'SECRET' } }); };
  const result = await f.controller.stop({ task: 'test' });
  assert.equal(result.state, 'STOP_PENDING');
  assert.equal(result.stopAttempt.phase, 'failed');
  assert.equal(result.stopAttempt.failedPhase, 'watch-ready');
  assert.equal(result.stopAttempt.cancelRequested, false);
  assert.equal(result.stopAttempt.cancelAck, undefined);
  assert.deepEqual(result.stopDiagnostic, { code: 'STOP_WATCH_READY_FAILED', diagnostic: { stage: 'stream', category: 'timeout', knownRejected: false } });
  assert.ok(!JSON.stringify(await f.store.task('test')).includes('SECRET'));
  assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 0);
});
test('stop receipt distinguishes cancel transport unknown and never retries it', async t => {
  const f = await fixture(t), client = await f.controller.client(await f.store.task('test')), rpc = client.rpc.bind(client);
  let cancels = 0;
  client.rpc = async (method, args) => {
    if (method !== 'session/cancel') return rpc(method, args);
    cancels++;
    throw Object.assign(new Error('SECRET'), { code: 'SECRET', body: 'SECRET', diagnostic: { stage: 'rpc', method, category: 'transport_unknown', knownRejected: false, cookie: 'SECRET' } });
  };
  const result = await f.controller.stop({ task: 'test' });
  assert.equal(result.state, 'STOP_PENDING');
  assert.equal(result.stopAttempt.failedPhase, 'cancel');
  assert.equal(result.stopAttempt.cancelRequested, true);
  assert.equal(result.stopAttempt.cancelAck.accepted, undefined);
  assert.ok(result.stopAttempt.cancelAck.durationMs >= 0);
  assert.equal(result.stopDiagnostic.code, 'STOP_CANCEL_UNKNOWN');
  assert.equal(result.stopDiagnostic.diagnostic.category, 'transport_unknown');
  assert.equal(cancels, 1);
  assert.ok(!JSON.stringify(await f.store.task('test')).includes('SECRET'));
});
test('stop receipt for idle shared session never requests cancel and preserves pending scope', async t => {
  const f = await fixture(t, { shared: true });
  const result = await f.controller.stop({ task: 'test' });
  assert.equal(result.state, 'STOP_PENDING');
  assert.equal(result.stopAttempt.scope, 'shared');
  assert.equal(result.stopAttempt.phase, 'finished');
  assert.equal(result.stopAttempt.cancelRequested, false);
  assert.equal(result.stopAttempt.cancelAck, undefined);
  assert.deepEqual(result.stopAttempt.before, { running: null, queueCount: 0, ownedQueueCount: 0, associatedTurns: [] });
  assert.deepEqual(result.stopAttempt.after, { ...result.stopAttempt.before, running: false });
  assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 0);
});
test('stop still sends cancel once before a failed native list read', async t => {
  const f = await fixture(t), client = await f.controller.client(await f.store.task('test')), rpc = client.rpc.bind(client);
  let lists = 0;
  client.rpc = async (method, args) => {
    if (method !== 'session/list') return rpc(method, args);
    lists++;
    assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 1);
    throw new Error('list unavailable');
  };
  const result = await f.controller.stop({ task: 'test' });
  assert.equal(lists, 1);
  assert.equal(result.state, 'STOP_PENDING');
  assert.equal(result.stopAttempt.before.running, null);
  assert.equal(result.stopAttempt.cancelAck.accepted, true);
  assert.equal(result.stopAttempt.failedPhase, 'reconcile');
  assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 1);
});
for (const oldFails of [false, true]) test(`older stop ${oldFails ? 'failure' : 'completion'} cannot overwrite the latest pending attempt`, async t => {
  const f = await fixture(t), client = await f.controller.client(await f.store.task('test')), rpc = client.rpc.bind(client);
  let releaseOld, oldEntered, releaseLatest, latestEntered;
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  const oldReached = new Promise(resolve => { oldEntered = resolve; });
  const latestGate = new Promise(resolve => { releaseLatest = resolve; });
  const latestReached = new Promise(resolve => { latestEntered = resolve; });
  client.rpc = async (method, args) => {
    if (method === 'session/list') { oldEntered(); await oldGate; if (oldFails) throw new Error('old list failed'); }
    return rpc(method, args);
  };
  const old = f.controller.stop({ task: 'test' });
  await oldReached;
  const oldId = (await f.store.task('test')).stopAttempt.id;
  const second = new Controller({ store: await StateStore.open(f.store.directory), clientFactory: async () => { latestEntered(); await latestGate; throw new Error('latest client unavailable'); } });
  const latest = second.stop({ task: 'test' });
  await latestReached;
  const pending = await f.store.task('test');
  assert.notEqual(pending.stopAttempt.id, oldId);
  releaseOld();
  const result = await old;
  assert.equal(result.stopAttempt.id, pending.stopAttempt.id);
  assert.equal(result.state, 'STOP_PENDING');
  assert.equal(result.stopReason, pending.stopReason);
  assert.deepEqual(result.stopAttempt, pending.stopAttempt);
  assert.equal(result.stopDiagnostic, undefined);
  releaseLatest();
  const failed = await latest;
  assert.equal(failed.stopAttempt.id, pending.stopAttempt.id);
  assert.equal(failed.stopAttempt.phase, 'failed');
  assert.equal(failed.state, 'STOP_PENDING');
  assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 1);
});
test('wait establishes both streams before prompt; timeout does not cancel', async t => {
  const f = await fixture(t);
  const result = await f.controller.send({ task: 'test', text: 'input', allowModel: true, wait: 0.03 });
  assert.equal(f.streams.size, 2);
  assert.equal(result.observationTimedOut, true);
  assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 0);
});
for (const foreign of ['rpc-turn', 'queue', 'unknown-user']) test(`exclusive stop preserves later foreign activity: ${foreign}`, async t => {
  const f = await fixture(t);
  await f.controller.send({ task: 'test', text: 'input', allowModel: true });
  const id = (await f.store.task('test')).requests[0].requestId;
  f.queue([{ id: 'ours', source: { rpcId: id } }, ...(foreign === 'queue' ? [{ id: 'theirs', source: { rpcId: 'foreign' } }] : [])]);
  if (foreign !== 'queue') f.events.push(
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { message: { id: 'external', ...(foreign === 'rpc-turn' ? { source: { rpcId: 'foreign' } } : {}) } } },
  );
  f.running(true);
  const result = await f.controller.stop({ task: 'test' });
  assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 0);
  assert.equal(result.state, 'STOP_PENDING');
  assert.equal(result.stopAttempt.cancelRequested, false);
  assert.equal(result.stopAttempt.cancelSkippedReason, 'foreign-or-unknown-native-activity');
  assert.deepEqual(f.calls.filter(c => c.method === 'session/updateQueue').map(c => c.args.request.itemId), ['ours']);
  await assert.rejects(f.controller.send({ task: 'test', text: 'later', allowModel: true }), { code: 'TASK_STOPPED' });
});

test('shared stop removes only owned queue and never cancels another session turn', async t => {
  const f = await fixture(t, { shared: true });
  await f.controller.send({ task: 'test', text: 'input', allowModel: true });
  const id = (await f.store.task('test')).requests[0].requestId;
  f.queue([{ id: 'ours', source: { rpcId: id } }, { id: 'theirs', source: { rpcId: 'foreign' } }]);
  const result = await f.controller.stop({ task: 'test' });
  assert.equal(result.state, 'STOP_PENDING');
  assert.deepEqual(f.calls.filter(c => c.method === 'session/updateQueue').map(c => c.args.request.itemId), ['ours']);
  assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 0);
  await assert.rejects(f.controller.send({ task: 'test', text: 'later', allowModel: true }), { code: 'TASK_STOPPED' });
});

test('stop checks latest queue and remembers foreign activity after it disappears', async t => {
  const f = await fixture(t);
  const client = await f.controller.client(await f.store.task('test')), rpc = client.rpc.bind(client);
  let reads = 0;
  client.rpc = async (method, args) => {
    if (method === 'session/projections' && ++reads === 2) f.queue([{ id: 'external', source: {} }]);
    return rpc(method, args);
  };
  const first = await f.controller.stop({ task: 'test' });
  assert.equal(first.stopAttempt.cancelSkippedReason, 'foreign-or-unknown-native-activity');
  f.queue([]);
  const second = await f.controller.stop({ task: 'test' });
  assert.equal(second.state, 'STOP_PENDING');
  assert.equal(second.stopAttempt.cancelSkippedReason, 'foreign-or-unknown-native-activity');
  assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 0);
});

test('native context messages preserve exclusive cancellation', async t => {
  const f = await fixture(t);
  for (const kind of ['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context', 'compact-checkpoint']) {
    f.events.push({ seq: f.events.length, type: 'user/message', data: { message: { source: { kind } } } });
  }
  const result = await f.controller.stop({ task: 'test' });
  assert.equal(result.state, 'STOPPED');
  assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 1);
});
test('stop serializes with dispatch across controller instances and blocks a gated unsent intent', async t => {
  const f = await fixture(t, { shared: true });
  const original = f.controller.client.bind(f.controller);
  let release, entered, gated = false;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  f.controller.client = async task => {
    const client = await original(task);
    if (!gated && task.requests.at(-1)?.state === 'SUBMITTING') { gated = true; entered(); await gate; }
    return client;
  };
  const sending = f.controller.send({ task: 'test', text: 'input', allowModel: true });
  const rejection = assert.rejects(sending, { code: 'TASK_STOPPED' });
  await reached;
  const second = new Controller({ store: await StateStore.open(f.store.directory), clientFactory: asyncConfig => original({ connection: 'local' }), historyReader: f.controller.historyReader });
  let stopped = false;
  const stopping = second.stop({ task: 'test' }).then(value => { stopped = true; return value; });
  const deadline = Date.now() + 3000;
  while (!(await f.store.task('test')).stopRequested && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await f.store.task('test')).stopRequested, true);
  assert.equal(stopped, false);
  release(); await rejection;
  assert.equal((await stopping).state, 'STOP_PENDING');
  assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 0);
  assert.equal((await f.store.task('test')).requests[0].state, 'REJECTED');
});
test('approval is session and known-call scoped, expires on watch close, never autoallows', async t => {
  const f = await fixture(t);
  await f.controller.send({ task: 'test', text: 'input', allowModel: true });
  const id = (await f.store.task('test')).requests[0].requestId;
  f.events.push(...turn(id).slice(0, 2), { seq: 2, type: 'tool/call', data: { name: 'write', callId: 'known' } });
  const watcher = await f.controller.watch('test');
  f.streams.get('$events').onItem({ type: 'waterfall', eventId: 'other', event: 'approval/request', agentId: 'other-session', request: { callId: 'known' } });
  f.streams.get('$events').onItem({ type: 'waterfall', eventId: 'ours', event: 'approval/request', agentId: 'native-session', request: { callId: 'known', reason: 'write requested', path: '/fixture/output.txt' } });
  await watcher.tick();
  assert.equal(f.calls.find(c => c.method === '$events/result').args.outcome.kind, 'next');
  assert.equal((await f.controller.approvals({ task: 'test' })).approvals[0].eventId, 'ours');
  assert.equal((await f.controller.approvals({ task: 'test' })).approvals[0].operation.path, '/fixture/output.txt');
  await f.controller.approve({ task: 'test', approval: 'ours', decision: 'allowed-once' });
  await watcher.tick();
  assert.deepEqual(f.calls.at(-1).args.outcome, { kind: 'result', value: 'allowed-once' });
  assert.equal((await f.store.task('test')).approvals.ours.state, 'RESULT_SENT_UNCONFIRMED');
  f.streams.get('$events').onItem({ type: 'waterfall', eventId: 'expiring', event: 'approval/request', agentId: 'native-session', request: { callId: 'known' } });
  await watcher.tick(); await watcher.close();
  await assert.rejects(f.controller.approve({ task: 'test', approval: 'expiring', decision: 'rejected' }), { code: 'APPROVAL_EXPIRED' });
});
test('CLI rejects missing authorization without leaking input or credentials', async t => {
  const f = await fixture(t); let output = '';
  const code = await runCli(['send', '--task', 'test', '--text-file', 'secret-not-read', '--state-dir', f.store.directory], { stdout: { write: x => { output += x; } }, stderr: { write: x => { output += x; } } });
  assert.equal(code, 2); assert.match(output, /MODEL_PERMISSION_REQUIRED/); assert.ok(!output.includes('secret-fixture'));
});
