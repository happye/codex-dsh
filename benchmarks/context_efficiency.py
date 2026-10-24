"""Offline output-text comparison; no native Host, provider, or billing replay."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = r"""
import assert from 'node:assert/strict';
import {taskView} from './src/view.mjs';
const requests = Array.from({length:7}, (_, i) => ({
  requestId:`request-${i+1}`, state:i===6?'RUNNING':'COMPLETED', turn:i+1,
  ...(i===6?{}:{terminalSeq:i*10+9,reason:{kind:'completed'}}),
  resultFile:`/fixture/private/reply-request-${i+1}.txt`,
}));
const task = {requests:requests.map(r=>({...r,resultSha256:'a'.repeat(64),resultBytes:1200})),
  currentStep:{turn:7,step:4},toolSignals:[{name:'read',seq:68},{name:'edit',seq:69}]};
const value = {task:'demo',sessionId:'native-fixture',scope:'exclusive',state:'RUNNING',
  blocked:false,cursor:70,requests,approvals:[]};
const first = taskView(value,task,{request:'latest'});
const next = taskView(value,task,{request:'latest',sinceCursor:70,sinceGeneration:first.generation});
assert.equal(next.changed,false); assert.equal(next.state,'RUNNING');
const checks = ['unchanged-is-still-running'];
function changed(name, patch, stored=task) {
  const source={...value,...patch};
  const result=taskView(source,stored,{request:'latest',sinceGeneration:first.generation});
  assert.equal(result.changed,true,name);
  for(const key of ['state','blocked','approvals'])assert.deepEqual(result[key],source[key],name);
  assert.deepEqual(result.requests.map(r=>[r.requestId,r.state]),source.requests.slice(-1).map(r=>[r.requestId,r.state]));
  for(const key of ['observationError','stopReason','stopAttempt','stopDiagnostic'])
    if(source[key])assert.deepEqual(result[key],source[key],name);
  checks.push(name); return result;
}
changed('approval-at-same-cursor',{approvals:[{eventId:'approval-1',state:'PENDING',operation:{path:'review.txt'}}]});
changed('error-at-same-cursor',{observationError:{code:'STREAM_FAILED',knownRejected:false}});
changed('stop-ack-does-not-prove-stopped',{state:'STOP_PENDING',blocked:true,
  stopReason:'Native activity remains unknown',stopAttempt:{id:'stop-1',phase:'finished',cancelAck:{accepted:true}},
  stopDiagnostic:{code:'STOP_ACTIVITY_UNKNOWN'}});
changed('new-contract-at-same-cursor',{}, {...task,contractRef:{sha:'b'.repeat(64)}});
const completed={...value,state:'COMPLETED',cursor:71,
  requests:requests.map((r,i)=>i===6?{...r,state:'COMPLETED',terminalSeq:71,reason:{kind:'completed'}}:r)};
const final=changed('new-final-answer',completed);
assert.equal(final.requests[0].resultSha256,task.requests[6].resultSha256);
assert.equal(final.requests[0].resultFile,requests[6].resultFile);
const updated=structuredClone(task);updated.requests[6].resultSha256='c'.repeat(64);
changed('same-path-new-answer-bytes',{},updated);
const approved={...value,approvals:[{eventId:'approval-1',state:'PENDING'}]};
const withApproval=taskView(approved,task);
assert.equal(taskView(value,task,{sinceGeneration:withApproval.generation}).changed,true);
checks.push('approval-removal-at-same-cursor');
console.log(JSON.stringify({node:process.version,checks,cases:[
  {id:'seven-request-status',before:[JSON.stringify(value)],after:[JSON.stringify(first)]},
  {id:'ten-identical-observation-windows',before:Array(10).fill(JSON.stringify(first)),
   after:[JSON.stringify(first),...Array(9).fill(JSON.stringify(next))]},
]}));
"""


def main():
    completed = subprocess.run(
        ['node', '--input-type=module', '-'], input=FIXTURE,
        cwd=ROOT, text=True, encoding='utf-8', capture_output=True, check=True,
    )
    fixture = json.loads(completed.stdout)
    material_path = ROOT / 'docs/manuals/contracts.md'
    material = material_path.read_text(encoding='utf-8')
    digest = hashlib.sha256(material.encode('utf-8')).hexdigest()
    reference = json.dumps({'material': 'docs/manuals/contracts.md',
                            'sha256': digest, 'unchanged': True}, separators=(',', ':'))
    fixture['cases'].append({'id': 'four-identical-manual-reads',
                             'before': [material] * 4, 'after': [material] + [reference] * 3})
    encoder, tokenizer_version, tokenizer_status = None, None, 'not-installed'
    try:
        import tiktoken
        from importlib.metadata import version
        encoder = tiktoken.get_encoding('o200k_base')
        tokenizer_version, tokenizer_status = version('tiktoken'), 'available'
    except (ImportError, OSError, ValueError) as error:
        tokenizer_status = 'unavailable:' + type(error).__name__

    def measure(texts):
        return {'characters': sum(len(text) for text in texts),
                'utf8Bytes': sum(len(text.encode('utf-8')) for text in texts),
                'referenceTokens': sum(len(encoder.encode(text, disallowed_special=()))
                                       for text in texts) if encoder else None}

    cases = []
    for case in fixture['cases']:
        before, after = measure(case['before']), measure(case['after'])
        saved = before['referenceTokens'] - after['referenceTokens'] if encoder else None
        cases.append({'id': case['id'], 'before': before, 'after': after,
                      'savedReferenceTokens': saved,
                      'referenceTokenReductionPercent': round(saved / before['referenceTokens'] * 100, 2)
                      if encoder else None})
    print(json.dumps({'status': 'PASS', 'kind': 'OFFLINE_CONTROLLED_OUTPUT_TEXT_ONLY',
                      'python': sys.version.split()[0], 'node': fixture['node'],
                      'tokenizer': {'encoding': 'o200k_base', 'version': tokenizer_version,
                                    'status': tokenizer_status, 'actualBillingTokenizerVerified': False},
                      'fixtureSha256': hashlib.sha256(FIXTURE.encode('utf-8')).hexdigest(),
                      'materialSha256': digest, 'cases': cases,
                      'qualityChecks': fixture['checks'], 'nativeHostCalls': 0, 'modelCalls': 0,
                      'actualHistoricalSavingsKnown': False}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
