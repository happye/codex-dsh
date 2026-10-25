import { createHash, randomUUID } from 'node:crypto';
import { fault } from './store.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value), 'utf8');
const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined && scalar(value[key])).map(key => [key, value[key]]));
const words = text => text.split(' ');
const identity = words('schema task sessionId requestId connection state scope blocked cursor generation changed observationTimedOut leaseOpen contractSha baselineFingerprint sourceFingerprint sourceBefore sourceAfter byteSourceBefore byteSourceAfter testFingerprint testFingerprintAfter sourceError runId caseId owner purpose domain runner executable cwd executionRoot baseCommit sourceManifestSha executionState exitCode signal termination cleanup valid passed evidenceComplete reused reusable reuseOf stopReason skillInstalled toolRoot stateDir profilePath url authenticationRequired attached approval status sampleCount missingUsageCount inconsistentCount adapter lastSeq');
const requestFields = words('requestId state turn terminalSeq messageId resultFile resultSha256 resultBytes association');
const diagnosticFields = words('code stage category knownRejected method operation sessionId requestId httpStatus status transport');
const stopFields = words('id startedAt endedAt scope phase failedPhase cancelRequested cancelSkippedReason');
const snapshotFields = words('running queueCount ownedQueueCount sharedStopRequired unknownUserActivity');
const usageFields = words('uncachedInputTokens cacheReadTokens cacheWriteTokens outputTokens totalInputTokens totalTokens');
const coverageFields = words('uniqueEvents usageEvents selectedEvents unassociatedEvents excludedEvents historyStartsAtZero');

export function validateOutputBudget(raw) {
  if (raw === undefined) return undefined;
  if ((typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+$/.test(raw))) || !Number.isSafeInteger(Number(raw))) throw fault('INVALID_OUTPUT_BUDGET');
  const value = Number(raw);
  if (value !== 0 && (value < 1024 || value > 1048576)) throw fault('INVALID_OUTPUT_BUDGET');
  return value;
}

async function asset(store, bytes, prefix) {
  const file = `${prefix}-${randomUUID()}.json`;
  const path = await store.writeFile(file, bytes);
  return { file, path, bytes: bytes.length, sha256: hash(bytes) };
}

function diagnostic(value) {
  if (scalar(value)) return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value) ? value : { detailsInArtifact: true };
  const result = pick(value, diagnosticFields);
  if (value?.diagnostic) result.diagnostic = pick(value.diagnostic, diagnosticFields);
  return result;
}

function summarize(value, omitted) {
  const result = pick(value, identity);
  const source = {
    executionRoot: value?.executionRoot ?? value?.cwd ?? value?.contract?.executionRoot,
    baseCommit: value?.baseCommit ?? value?.baseline?.head,
    sourceManifestSha: value?.sourceManifestSha ?? value?.sourceBefore ?? value?.sourceFingerprint ?? value?.baseline?.fingerprint,
  };
  result.source = Object.fromEntries(Object.entries(source).map(([key, item]) => [key, typeof item === 'string' ? item : null]));
  if (value?.binding) result.binding = pick(value.binding, words('task sessionId nativeCwd'));
  if (value?.contract) result.contractIdentity = pick(value.contract, words('id revision gitOwner nativeCwd executionRoot'));
  for (const key of ['observationError', 'stopDiagnostic', 'error']) if (value?.[key] !== undefined) result[key] = diagnostic(value[key]);
  if (value?.errors !== undefined) result.errors = Array.isArray(value.errors) ? value.errors.map(diagnostic) : diagnostic(value.errors);
  if (value?.stopAttempt) {
    result.stopAttempt = pick(value.stopAttempt, stopFields);
    if (value.stopAttempt.cancelAck) result.stopAttempt.cancelAck = pick(value.stopAttempt.cancelAck, ['accepted', 'durationMs']);
    for (const key of ['before', 'after']) if (value.stopAttempt[key]) {
      result.stopAttempt[key] = pick(value.stopAttempt[key], snapshotFields);
      if (Array.isArray(value.stopAttempt[key].associatedTurns)) result.stopAttempt[key].associatedTurns = value.stopAttempt[key].associatedTurns.filter(Number.isSafeInteger);
    }
  }
  if (Array.isArray(value?.requests)) result.requests = value.requests.map(item => ({ ...pick(item, requestFields),
    ...(item.reason !== undefined ? { reason: typeof item.reason === 'string' ? item.reason : pick(item.reason, ['kind']) } : {}),
    ...(item.diagnostic ? { diagnostic: diagnostic(item.diagnostic) } : {}) }));
  // Approval operations are deliberately complete: reviewers need the actual operation.
  if (Array.isArray(value?.approvals)) result.approvals = value.approvals.map(item => ({ ...pick(item, words('eventId callId state watchId expiresAt')),
    ...(item.operation !== undefined ? { operation: item.operation } : {}) }));
  if (Array.isArray(value?.tasks)) {
    result.tasks = value.tasks.map(item => pick(item, words('task sessionId connection cwd state blocked active running unresolved')));
    omitted.push({ pointer: '/tasks', count: value.tasks.length, projection: 'summary.tasks contains all task identities and activity states; other task fields are omitted' });
  }
  for (const key of ['stdout', 'stderr', 'pytestAsset', 'contractRef', 'receiptRef']) if (value?.[key]) result[key] = pick(value[key], words('file path bytes sha256 sha id revision'));
  if (value?.pytest) {
    const pytest = value.pytest;
    const outcomes = Array.isArray(pytest.outcomes) ? pytest.outcomes : [];
    result.pytest = { ...pick(pytest, words('exitstatus finished')), collectedCount: Array.isArray(pytest.collected) ? pytest.collected.length : null, outcomeCount: outcomes.length,
      outcomes: Object.fromEntries(['passed', 'failed', 'skipped'].map(outcome => [outcome, outcomes.filter(item => item.outcome === outcome).length])) };
    for (const key of ['collected', 'outcomes', 'observedCwds']) if (Array.isArray(pytest[key])) omitted.push({ pointer: `/pytest/${key}`, count: pytest[key].length });
  }
  for (const key of ['expectedNodeids', 'argv', 'connections', 'records', 'turns', 'associationIssues']) if (Array.isArray(value?.[key])) omitted.push({ pointer: `/${key}`, count: value[key].length });
  for (const key of ['contract', 'baseline', 'current']) if (value?.[key] !== undefined) omitted.push({ pointer: `/${key}` });
  for (const key of ['totals', 'reportedTotals']) if (value?.[key]) result[key] = pick(value[key], usageFields);
  if (value?.coverage) result.coverage = pick(value.coverage, coverageFields);
  if (value?.fieldCoverage) result.fieldCoverage = Object.fromEntries(usageFields.filter(key => value.fieldCoverage[key]).map(key => [key, pick(value.fieldCoverage[key], ['reported', 'missing'])]));
  if (value?.cacheReadRatio) result.cacheReadRatio = pick(value.cacheReadRatio, words('numerator denominator denominatorField value'));
  return result;
}

// Classification is descriptive evidence, not a claim about the root cause.
function errorType(line) {
  if (/^\s*FAILED(?:\s|$)/.test(line)) return 'pytest-FAILED';
  if (/^\s*ERROR(?:\s|$)/.test(line)) return 'pytest-ERROR';
  const match = line.match(/^\s*(?:E\s+)?(?:[\w.]+\.)?([A-Za-z_]\w*(?:Error|Exception)|Exception)(?:\s*:|\s*$)/);
  if (!match) return null;
  return ['AssertionError', 'TypeError', 'ValueError', 'RuntimeError', 'ImportError', 'ModuleNotFoundError', 'AttributeError', 'KeyError', 'IndexError', 'NameError', 'SyntaxError', 'OSError', 'IOError', 'FileNotFoundError', 'PermissionError', 'TimeoutError', 'Exception'].includes(match[1]) ? match[1] : 'PythonErrorOrException';
}

async function logGroups(ref, readLog, store) {
  if (!readLog) throw fault('OUTPUT_LOG_READER_REQUIRED');
  const bytes = await readLog(ref); // The caller verifies the original asset; failures propagate.
  if (!Buffer.isBuffer(bytes)) throw fault('INVALID_OUTPUT_LOG');
  const groups = new Map();
  // ASCII error classifiers need no Unicode decoding; keep every raw byte in
  // the equality key so distinct non-UTF8 messages cannot collapse to U+FFFD.
  for (const [index, line] of bytes.toString('latin1').split(/\r?\n/).entries()) {
    const type = errorType(line);
    if (!type) continue;
    let group = groups.get(line);
    if (!group) {
      group = { id: `${ref.sha256}:g${groups.size + 1}`, type, count: 0, firstLine: index + 1, sampleLines: [index + 1] };
      groups.set(line, group);
    }
    group.count++;
  }
  const all = [...groups.values()];
  const index = { schema: 'dsh-error-groups/v1', sourceRef: ref, identity: 'exact-error-line-within-one-original-log', groups: all };
  return { sourceRef: ref, classification: all.length ? 'recognized-error-lines' : 'unclassified', rootCause: 'unverified',
    groupCount: all.length, errorLineCount: all.reduce((sum, group) => sum + group.count, 0),
    groupIndexRef: await asset(store, jsonBytes(index), 'output-groups'), groups: [], omittedGroups: { first: all.length ? 1 : null, last: all.length || null }, all };
}

function measure(envelope) {
  // The counter includes itself. Its decimal width converges after a few passes.
  let length;
  do { length = envelope.statistics.visibleBytes; envelope.statistics.visibleBytes = jsonBytes(envelope).length; } while (length !== envelope.statistics.visibleBytes);
  return envelope.statistics.visibleBytes;
}

// A failed projection cannot certify an artifact or an earlier passing receipt.
// The caller emits this frame and still propagates the original failure.
export function outputFailure(value, { command, budgetBytes, error } = {}) {
  const budget = validateOutputBudget(budgetBytes);
  const omitted = [{ pointer: '', source: 'original-state-or-receipt', reason: 'Projection failed; complete output preservation is unverified. Recover and verify the original state or receipt before any new dispatch.' }];
  const summary = summarize(value, omitted);
  for (const key of ['passed', 'valid', 'evidenceComplete']) if (value?.[key] !== undefined) summary[key] = false;
  const codes = ['ENOSPC', 'EACCES', 'EPERM', 'EIO', 'ENOENT', 'EVIDENCE_TAMPERED', 'EVIDENCE_CHANGED', 'OUTPUT_LOG_READER_REQUIRED', 'INVALID_OUTPUT_LOG'];
  const envelope = { schema: 'dsh-output/v1', command, truncated: true, projectionFailed: true,
    failure: { code: codes.includes(error?.code) ? error.code : 'OUTPUT_PROJECTION_FAILED', acceptanceBlocked: true, reason: 'OUTPUT_PROJECTION_VERIFICATION_BLOCKED', originalValueChanged: false },
    artifactRef: null, artifactPreservation: 'unverified', recoveryRequired: true, automaticResubmissionAllowed: false,
    summary, omitted, statistics: { fullBytes: jsonBytes(value).length, visibleBytes: 0, codexUsage: null,
      dshUsage: value?.schema === 'dsh-usage/v1' ? pick(value.totals, usageFields) : null }, budgetBytes: budget };
  if (budget && measure(envelope) > budget) envelope.budgetExceeded = true;
  measure(envelope);
  return envelope;
}

export async function budgetOutput(value, { store, budgetBytes, command, readLog } = {}) {
  const budget = validateOutputBudget(budgetBytes);
  if (!budget) return value;
  const bytes = jsonBytes(value);
  if (bytes.length <= budget) return value;
  const artifactRef = await asset(store, bytes, 'output');
  // The root entry indexes every omitted value, including unknown/private fields.
  const omitted = [{ pointer: '', source: 'artifactRef', reason: 'Only allowlisted summary fields are projected; the complete original JSON is retained.' }];
  const envelope = { schema: 'dsh-output/v1', command, truncated: true, summary: summarize(value, omitted), artifactRef, omitted,
    statistics: { fullBytes: bytes.length, visibleBytes: 0, codexUsage: null, dshUsage: value?.schema === 'dsh-usage/v1' ? pick(value.totals, usageFields) : null }, budgetBytes: budget };
  const logs = [];
  if (command === 'run' || command === 'receipt' || value?.schema === 'dsh-run/v1') {
    for (const stream of ['stdout', 'stderr']) if (value?.[stream]?.file) {
      const { all, ...summary } = await logGroups(value[stream], readLog, store);
      logs.push({ summary, all });
      (envelope.summary.errorGroups ??= {})[stream] = summary;
    }
  }
  for (const { summary, all } of logs) for (const group of all) {
    summary.groups.push(group);
    summary.omittedGroups.first = summary.groups.length < all.length ? summary.groups.length + 1 : null;
    summary.omittedGroups.last = summary.groups.length < all.length ? all.length : null;
    if (measure(envelope) > budget) {
      summary.groups.pop();
      summary.omittedGroups = { first: summary.groups.length + 1, last: all.length };
      break;
    }
  }
  // Required stop, approval and request evidence may exceed this soft budget.
  if (measure(envelope) > budget) envelope.budgetExceeded = true;
  measure(envelope);
  return envelope;
}
