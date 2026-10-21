import test from 'node:test';
import assert from 'node:assert/strict';
import { taskView } from '../src/view.mjs';

const task = () => ({ requests: [{requestId:'one',resultSha256:'a',resultBytes:5},{requestId:'two',resultSha256:'b',resultBytes:8}], toolSignals:[{name:'read',seq:4},{name:'edit',seq:8}], currentStep:{turn:2,step:1} });
const value = () => ({task:'demo',sessionId:'native',scope:'exclusive',state:'RUNNING',blocked:false,cursor:9,requests:[{requestId:'one',state:'COMPLETED',resultFile:'old-file',turn:1},{requestId:'two',state:'RUNNING',resultFile:'new-file',turn:2}],approvals:[]});
test('summary defaults to latest request and reports only tools after cursor', () => {
  const v=taskView(value(),task(),{sinceCursor:4});
  assert.deepEqual(v.requests.map(r=>r.requestId),['two']);
  assert.deepEqual(v.counts.tools,{edit:1}); assert.equal(v.counts.newTools,1);
  assert.ok(!JSON.stringify(v).includes('old-file'));
});
test('unchanged generation suppresses repeated answer references without declaring idle', () => {
  const first=taskView(value(),task());
  const next=taskView(value(),task(),{sinceGeneration:first.generation});
  assert.equal(next.changed,false); assert.equal(next.state,'RUNNING');
  assert.deepEqual(next.requests,[]); assert.ok(!JSON.stringify(next).includes('new-file'));
});
test('stop and pending approval changes remain visible without native cursor movement', () => {
  const first=taskView(value(),task());
  const stopped={...value(),state:'STOP_PENDING',blocked:true};
  assert.equal(taskView(stopped,task(),{sinceGeneration:first.generation}).changed,true);
  const approval={...value(),approvals:[{eventId:'approval',state:'PENDING',operation:{path:'review-this-file'}}]};
  const pending=taskView(approval,task(),{sinceGeneration:first.generation});
  assert.equal(pending.changed,true); assert.equal(pending.approvals[0].operation.path,'review-this-file');
  assert.notEqual(taskView({...approval,approvals:[]},task()).generation,pending.generation);
});
test('changed answer bytes affect generation even at the same cursor', () => {
  const first=taskView(value(),task()); const changed=task(); changed.requests[1].resultSha256='changed';
  assert.equal(taskView(value(),changed,{sinceGeneration:first.generation}).changed,true);
});
test('invalid cursors, generations and unknown requests are rejected', () => {
  for(const sinceCursor of [-2,1.5,10]) assert.throws(()=>taskView(value(),task(),{sinceCursor}),{code:'INVALID_CURSOR'});
  assert.throws(()=>taskView(value(),task(),{sinceGeneration:'bad'}),{code:'INVALID_GENERATION'});
  assert.throws(()=>taskView(value(),task(),{request:'missing'}),{code:'REQUEST_NOT_FOUND'});
});
test('changing request selector invalidates the view generation and tool names are data', () => {
  const first=taskView(value(),task());
  const selected=taskView(value(),task(),{request:'one',sinceGeneration:first.generation});
  assert.equal(selected.changed,true); assert.equal(selected.requests[0].requestId,'one');
  const data=task(); data.toolSignals=[{name:'constructor',seq:1},{name:'__proto__',seq:2}];
  assert.equal(taskView(value(),data).counts.newTools,2);
});
