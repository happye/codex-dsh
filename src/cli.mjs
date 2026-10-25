import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { StateStore, fault } from './store.mjs';
import { Controller } from './controller.mjs';
import { setup, connections, resolveStateDirectory, connectionOrigin } from './setup.mjs';
import { safeDiagnostic } from './native.mjs';
import { taskView } from './view.mjs';
import { budgetOutput, outputFailure, validateOutputBudget } from './output.mjs';

const help = `codex-dsh: native DSH thin controller (JSON output)
  setup --url URL [--name NAME] [--state-dir ABSOLUTE] [--token-stdin | --token-file FILE]
  connections (local connection and task metadata only)
  tasks --connection NAME [--cwd ABSOLUTE] [--title EXACT_TITLE] [--active]
  recover --task ID | --connection NAME [--cwd ABSOLUTE] [--title EXACT_TITLE] [--active]
  attach --name NAME --url URL [--token-stdin]
  workspace --connection NAME [--cwd ABSOLUTE] (list or register native workspace)
  start --connection NAME --cwd ABSOLUTE [--workspace ID] [--task ID] [--title TITLE] [--session ID]
  send --task ID --text-file FILE --allow-model [--contract-sha SHA256] [--wait SECONDS]
  status|resume|stop|approvals --task ID
  follow --task ID [--wait SECONDS] (default 60)
  listen --task ID [--wait SECONDS] (JSON Lines, live approval lease, maximum 60)
  usage --task ID (native usage only, no message bodies)
  contract --task ID [--file CONTRACT_JSON]
  run --task ID --contract-sha SHA256 --case CASE_ID --owner OWNER [--rerun-reason REASON]
  receipt --task ID --run RUN_ID
  readiness --task ID --contract-sha SHA256 --review-file REVIEW_JSON
  status|resume|follow|send [--view summary] [--request latest|REQUEST_ID] [--since-cursor N] [--since-generation SHA256]
  approve --task ID --approval EVENT_ID --decision allowed-once|rejected
All commands: --state-dir DIR (explicit > personal Skill profile > cwd/.codex-dsh)
  --output-budget-bytes N (0 disables; 1024..1048576, opt-in stdout projection only)
  Oversized JSON is preserved in a private artifact; required signals may exceed the budget.
setup installs the repository Skill unchanged into CODEX_HOME/skills/codex-dsh-collab.
Without a token setup only configures locally; stored authentication is not a live check.
Exit codes: 0 success/status, 2 invalid usage, 3 state/conflict, 4 native/transport error.
send requires explicit model authorization; observation timeout never cancels native work.
start creates a native session on an attached Host, without changing native configuration.
stop never kills or archives a Host; STOP_PENDING requires inspection in native UI.
`;
const specs = {
  setup: ['name', 'url', 'token-stdin', 'token-file'], connections: [],
  tasks: ['connection', 'cwd', 'title', 'active'], recover: ['task', 'connection', 'cwd', 'title', 'active'],
  attach: ['name', 'url', 'token-stdin'], workspace: ['connection','cwd'], start: ['connection', 'cwd', 'task', 'title', 'session', 'workspace'],
  send: ['task', 'text-file', 'allow-model', 'wait'], status: ['task'], resume: ['task'], stop: ['task'],
  approvals: ['task'], follow: ['task', 'wait'], listen: ['task', 'wait', 'request', 'since-cursor', 'since-generation'], usage: ['task'], approve: ['task', 'approval', 'decision'],
  contract: ['task','file'], run: ['task','contract-sha','case','owner','rerun-reason'], receipt: ['task','run'], readiness: ['task','contract-sha','review-file'],
};
specs.send.push('contract-sha');
for (const name of ['status','resume','follow','send']) specs[name].push('view','request','since-cursor','since-generation');
const required = { setup: [], connections: [], tasks: ['connection'], recover: [], attach: ['name', 'url'], start: ['connection', 'cwd'], send: ['task', 'text-file'], status: ['task'], resume: ['task'], stop: ['task'], approvals: ['task'], follow: ['task'], listen: ['task'], usage: ['task'], approve: ['task', 'approval', 'decision'] };
Object.assign(required,{workspace:['connection'],contract:['task'],run:['task','contract-sha','case','owner'],receipt:['task','run'],readiness:['task','contract-sha','review-file']});
async function tokenLine(stdin) {
  const lines = readline.createInterface({ input: stdin, terminal: false });
  try { for await (const line of lines) return line.trim(); return ''; } finally { lines.close(); }
}
export async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, cwd = process.cwd(), codexHome } = {}) {
  if (!argv.length || argv[0] === '--help' || argv[0] === 'help' || argv.includes('--help')) { stdout.write(help); return 0; }
  try {
    const command = argv[0], options = {}, allowed = specs[command];
    if (!allowed) throw fault('USAGE', 'Unknown command; use --help');
    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i];
      if (!flag.startsWith('--')) throw fault('USAGE');
      const key = flag.slice(2);
      if (![...allowed, 'state-dir', 'output-budget-bytes'].includes(key) || key in options) throw fault('USAGE', 'Unknown or duplicate option');
      if (['token-stdin', 'allow-model', 'active'].includes(key)) options[key] = true;
      else { const value = argv[++i]; if (!value || value.startsWith('--')) throw fault('USAGE', 'Missing option value'); options[key] = value; }
    }
    for (const name of required[command]) if (!options[name]) throw fault('USAGE', `Missing --${name}`);
    const budgetBytes = validateOutputBudget(options['output-budget-bytes']);
    const emit = async (value, store) => {
      let visible;
      try {
        visible = await budgetOutput(value, { store, budgetBytes, command, readLog: async ref => {
          const { readAsset } = await import('./contract.mjs');
          return readAsset(store, ref);
        } });
      } catch (error) {
        stdout.write(`${JSON.stringify(outputFailure(value, { command, budgetBytes, error }))}\n`);
        throw error;
      }
      stdout.write(`${JSON.stringify(visible)}\n`);
    };
    if (command === 'recover' && (Boolean(options.task) === Boolean(options.connection) || (options.task && ['cwd', 'title', 'active'].some(key => key in options)))) throw fault('USAGE', 'recover requires a task or connection selectors');
    const wait = options.wait === undefined ? undefined : Number(options.wait);
    if (wait !== undefined && (!Number.isFinite(wait) || wait < 0)) throw fault('USAGE', '--wait must be nonnegative seconds');
    if (options.view !== undefined && options.view !== 'summary') throw fault('INVALID_VIEW');
    const sinceCursor = options['since-cursor'] === undefined ? undefined : Number(options['since-cursor']);
    if (sinceCursor !== undefined && (!Number.isSafeInteger(sinceCursor) || sinceCursor < -1)) throw fault('INVALID_CURSOR');
    const viewOptions = { request: options.request, sinceCursor, sinceGeneration: options['since-generation'] };
    if (viewOptions.sinceGeneration !== undefined && !/^[a-f0-9]{64}$/.test(viewOptions.sinceGeneration)) throw fault('INVALID_GENERATION');
    if (command === 'send' && options.request !== undefined && options.request !== 'latest') throw fault('INVALID_REQUEST_SELECTOR');
    if (options['token-stdin'] && options['token-file']) throw fault('USAGE');
    if (options.url) options.url = connectionOrigin(options.url);
    let token;
    if (options['token-stdin']) token = await tokenLine(stdin);
    if (options['token-file']) token = (await fs.readFile(path.resolve(cwd, options['token-file']), 'utf8')).trim();
    if ((options['token-stdin'] || options['token-file']) && !token) throw fault('EMPTY_INPUT');
    if (command === 'setup') {
      const value = await setup(options, { codexHome, token });
      await emit(value, budgetBytes ? await StateStore.open(value.stateDir) : undefined);
      return 0;
    }
    const store = await StateStore.open(await resolveStateDirectory(options['state-dir'], { cwd, codexHome }));
    if (command === 'connections') { await emit(await connections(store), store); return 0; }
    const controller = new Controller({ store });
    if (['contract','run','receipt','readiness'].includes(command)) {
      const { ContractService } = await import('./contract.mjs');
      const service = new ContractService({ store });
      let value;
      if (command === 'contract') value = options.file
        ? await service.bind({ task: options.task, contract: JSON.parse(await fs.readFile(path.resolve(cwd,options.file),'utf8')) })
        : await service.inspect({task:options.task});
      if (command === 'run') value = await service.run({task:options.task,contractSha:options['contract-sha'],case:options.case,owner:options.owner,rerunReason:options['rerun-reason']});
      if (command === 'receipt') value = await service.receipt({task:options.task,run:options.run});
      if (command === 'readiness') value = await service.readiness({task:options.task,contractSha:options['contract-sha'],review:JSON.parse(await fs.readFile(path.resolve(cwd,options['review-file']),'utf8'))});
      await emit(value, store); return 0;
    }
    let args = { ...options, ...(wait === undefined ? {} : { wait }) };
    if (command === 'listen') {
      await controller.listen({ ...args, ...viewOptions, onUpdate: value => emit(value, store) });
      return 0;
    }
    if (command === 'attach') args.token = token;
    if (command === 'send') {
      if (!options['allow-model']) throw fault('MODEL_PERMISSION_REQUIRED', 'send requires --allow-model');
      if (sinceCursor !== undefined) {
        const current = await store.task(options.task);
        if (sinceCursor > (current.cursor ?? -1)) throw fault('INVALID_CURSOR');
      }
      args = { ...args, allowModel: true, contractSha: options['contract-sha'], text: await fs.readFile(path.resolve(cwd,options['text-file']), 'utf8') };
    }
    let result = await controller[command](args);
    if (options.view === 'summary' || options.request !== undefined || options['since-cursor'] !== undefined || options['since-generation'] !== undefined) result = taskView(result, await store.task(options.task), viewOptions);
    await emit(result, store);
    return 0;
  } catch (error) {
    // Native/provider errors can echo request bodies or auth URLs: never print them.
    const code = /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'NATIVE_OR_IO_ERROR';
    const diagnostic = safeDiagnostic(error.diagnostic);
    const candidates = code === 'AMBIGUOUS_TASK' && Array.isArray(error.candidates)
      ? error.candidates.filter(id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) : undefined;
    stderr.write(`${JSON.stringify({ error: code, ...(diagnostic ? { diagnostic } : {}), ...(candidates ? { candidates } : {}) })}\n`);
    if (code === 'USAGE' || code.startsWith('INVALID_') || code === 'MODEL_PERMISSION_REQUIRED' || code === 'ABSOLUTE_CWD_REQUIRED' || code === 'EMPTY_INPUT') return 2;
    if (/^(STATE_|TASK_|SESSION_|CWD_|AMBIGUOUS_TASK|CONNECTION_|WORKSPACE_|UNRESOLVED_|APPROVAL_|UNSAFE_|REQUEST_|CONTRACT_|RUN_|TEST_|READINESS_|REVIEW_|RERUN_|DUPLICATE_|EVIDENCE_)/.test(code)) return 3;
    return 4;
  }
}
