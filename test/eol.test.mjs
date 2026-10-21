import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileIdentity } from '../src/execution.mjs';
import { StateStore } from '../src/store.mjs';
import { ContractService } from '../src/contract.mjs';

test('explicit text LF/CRLF is equivalent while byte identity is retained',()=>{
  const lf=fileIdentity(Buffer.from('line\n'),'text'),crlf=fileIdentity(Buffer.from('line\r\n'),'text');
  assert.equal(lf.contentSha256,crlf.contentSha256);assert.notEqual(lf.sha256,crlf.sha256);
});
test('different text content is not EOL equivalence',()=>{
  assert.notEqual(fileIdentity(Buffer.from('one\n'),'text').contentSha256,fileIdentity(Buffer.from('two\r\n'),'text').contentSha256);
  assert.throws(()=>fileIdentity(Buffer.from([0xff]),'text'),{code:'INVALID_TEXT_ENCODING'});
});
test('raw evidence LF/CRLF changes identity',()=>{
  assert.notEqual(fileIdentity(Buffer.from('line\n')).contentSha256,fileIdentity(Buffer.from('line\r\n')).contentSha256);
});
test('identical raw evidence preserves exact identity',()=>{
  assert.deepEqual(fileIdentity(Buffer.from('line\r\n')),fileIdentity(Buffer.from('line\r\n')));
});
test('only explicit allowed text source reuses a result after EOL change',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-eol-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const root=path.join(temp,'repo');await fs.mkdir(root);
  const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});git('init');git('config','user.name','fixture');git('config','user.email','fixture@example.invalid');
  await fs.writeFile(path.join(root,'source.txt'),'line\n');await fs.writeFile(path.join(root,'runner.mjs'),'console.log("actual run");\n');git('add','.');git('commit','-m','baseline');
  const store=await StateStore.open(path.join(temp,'state'));await store.transaction(s=>{s.tasks.demo={id:'demo',cwd:root,sessionId:'native'};});
  const contract={id:'eol',revision:1,nativeCwd:root,executionRoot:root,gitOwner:'Codex',authorizationRef:'fixture',feeAuthorizationRef:null,stopConditions:['stop'],requirements:[{id:'r',text:'preserve evidence'}],allowedFiles:['source.txt'],protectedFiles:['runner.mjs'],textFiles:['source.txt'],testPlan:[{id:'unit',owner:'Codex',scope:'targeted',purpose:'regression',domain:'guard',runner:'command',executable:process.execPath,argv:['runner.mjs'],inputs:['runner.mjs','source.txt'],runtimeInputs:[],env:{},expectedNodeids:[],timeoutMs:3000}]};
  const service=new ContractService({store}),{contractSha}=await service.bind({task:'demo',contract});
  const args={task:'demo',contractSha,case:'unit',owner:'Codex'};
  const first=await service.run(args);assert.equal(first.passed,true);
  await fs.writeFile(path.join(root,'source.txt'),'line\r\n');
  const reused=await service.run(args);assert.equal(reused.reused,true);assert.equal(reused.runId,first.runId);
  assert.notEqual((await service.check({task:'demo',contractSha})).current.byteFingerprint,first.byteSourceAfter);
  const invalid={...contract,id:'invalid',textFiles:['runner.mjs']};await store.transaction(s=>{s.tasks.other={id:'other',cwd:root,sessionId:'other'};});
  await assert.rejects(service.bind({task:'other',contract:invalid}),{code:'INVALID_CONTRACT_PATH'});
});
