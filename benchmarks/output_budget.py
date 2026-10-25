"""Synthetic P0 comparison: captured JSON and optional reference tokens only."""
import hashlib
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = r"""
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {budgetOutput} from './src/output.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const files=new Map(),store={async writeFile(name,bytes){files.set(name,Buffer.from(bytes));return '/fixture/private/'+name;}};
const stdout=Buffer.from('E RuntimeError: synthetic repeated fixture failure\n'.repeat(3506)+'E RuntimeError: a different synthetic failure\n');
const empty=Buffer.alloc(0);
const refs={stdout:{file:'raw.stdout',bytes:stdout.length,sha256:sha(stdout)},stderr:{file:'raw.stderr',bytes:0,sha256:sha(empty)}};
const nodeids=Array.from({length:3506},(_,i)=>`tests/test_fixture.py::case_${i}`);
const value={schema:'dsh-run/v1',task:'synthetic',runId:'run-fixture',scope:'repo-full',cwd:'/fixture/project',
 contractSha:'a'.repeat(64),sourceBefore:'b'.repeat(64),sourceAfter:'b'.repeat(64),
 exitCode:1,termination:'exited',valid:true,evidenceComplete:false,passed:false,...refs,
 pytest:{finished:true,exitstatus:1,collected:nodeids,outcomes:nodeids.map(nodeid=>({nodeid,when:'setup',outcome:'failed'}))}};
const before=JSON.stringify(value);
const result=await budgetOutput(value,{store,command:'receipt',budgetBytes:16384,readLog:async ref=>{
 const bytes=ref.file==='raw.stdout'?stdout:empty;assert.equal(bytes.length,ref.bytes);assert.equal(sha(bytes),ref.sha256);return bytes;
}});
const original=files.get(result.artifactRef.file);
assert.equal(original.toString(),before);assert.equal(sha(original),result.artifactRef.sha256);
assert.equal(result.summary.passed,false);assert.equal(result.summary.pytest.collectedCount,3506);
assert.equal(result.summary.errorGroups.stdout.groupCount,2);
assert.deepEqual(result.summary.errorGroups.stdout.groups.map(g=>g.count),[3506,1]);
assert.ok(!JSON.stringify(result).includes('synthetic repeated fixture failure'));
assert.equal(result.statistics.codexUsage,null);assert.equal(result.statistics.dshUsage,null);
const after=JSON.stringify(result);assert.equal(Buffer.byteLength(after),result.statistics.visibleBytes);
assert.equal(JSON.stringify(value),before);assert.ok(Buffer.byteLength(after)<=16384);
const qualityChecks=['full-original-roundtrip','original-hash','failed-evidence-not-passed','collected-count',
 'distinct-error-count','repeated-error-counts','no-log-body-leak','unknown-codex-usage','unknown-dsh-usage',
 'visible-byte-count','input-value-unchanged','under-soft-budget'];
console.log(JSON.stringify({before,after,rawLogBytes:stdout.length,groupCount:2,qualityChecks}));
"""


def main():
    sample = json.loads(subprocess.run(
        ['node', '--input-type=module', '-'], cwd=ROOT, input=FIXTURE,
        text=True, encoding='utf-8', capture_output=True, check=True,
    ).stdout)
    encoder = None
    try:
        import tiktoken
        encoder = tiktoken.get_encoding('o200k_base')
    except ImportError:
        pass
    def counts(text):
        return {'utf8Bytes': len(text.encode('utf-8')),
                'referenceTokens': len(encoder.encode(text, disallowed_special=())) if encoder else None}
    before, after = counts(sample['before']), counts(sample['after'])
    result = {'kind': 'OFFLINE_SYNTHETIC_RECEIPT_OUTPUT', 'status': 'PASS',
              'before': before, 'after': after,
              'byteReductionPercent': round((1-after['utf8Bytes']/before['utf8Bytes'])*100, 2),
              'referenceTokenReductionPercent': round((1-after['referenceTokens']/before['referenceTokens'])*100, 2) if encoder else None,
              'referenceEncoding': 'o200k_base' if encoder else None,
              'fixtureSha256': hashlib.sha256(FIXTURE.encode('utf-8')).hexdigest(),
              'outputModuleSha256': hashlib.sha256((ROOT/'src/output.mjs').read_bytes()).hexdigest(),
              'rawLogBytes': sample['rawLogBytes'], 'distinctErrorGroups': sample['groupCount'],
              'qualityChecks': sample['qualityChecks'], 'hostCalls': 0, 'deepSeekProviderCalls': 0,
              'actualHistoricalSavingsKnown': False}
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
