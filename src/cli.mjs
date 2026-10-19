import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { StateStore, fault } from './store.mjs';
import { Controller } from './controller.mjs';
import { setup, connections, resolveStateDirectory, connectionOrigin } from './setup.mjs';

const help = `codex-dsh: native DSH thin controller (JSON output)
  setup --url URL [--name NAME] [--state-dir ABSOLUTE] [--token-stdin | --token-file FILE]
  connections (local connection and task metadata only)
  attach --name NAME --url URL [--token-stdin]
  start --connection NAME --cwd ABSOLUTE [--task ID] [--title TITLE] [--session ID]
  send --task ID --text-file FILE --allow-model [--wait SECONDS]
  status|resume|stop|approvals --task ID
  follow --task ID [--wait SECONDS] (default 60)
  approve --task ID --approval EVENT_ID --decision allowed-once|rejected
All commands: --state-dir DIR (explicit > personal Skill profile > cwd/.codex-dsh)
setup installs the repository Skill unchanged into CODEX_HOME/skills/codex-dsh-collab.
Without a token setup only configures locally; stored authentication is not a live check.
Exit codes: 0 success/status, 2 invalid usage, 3 state/conflict, 4 native/transport error.
send requires explicit model authorization; observation timeout never cancels native work.
start creates a native session on an attached Host, without changing native configuration.
stop never kills or archives a Host; STOP_PENDING requires inspection in native UI.
`;
const specs = {
  setup: ['name', 'url', 'token-stdin', 'token-file'], connections: [],
  attach: ['name', 'url', 'token-stdin'], start: ['connection', 'cwd', 'task', 'title', 'session'],
  send: ['task', 'text-file', 'allow-model', 'wait'], status: ['task'], resume: ['task'], stop: ['task'],
  approvals: ['task'], follow: ['task', 'wait'], approve: ['task', 'approval', 'decision'],
};
const required = { setup: [], connections: [], attach: ['name', 'url'], start: ['connection', 'cwd'], send: ['task', 'text-file'], status: ['task'], resume: ['task'], stop: ['task'], approvals: ['task'], follow: ['task'], approve: ['task', 'approval', 'decision'] };
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
      if (![...allowed, 'state-dir'].includes(key) || key in options) throw fault('USAGE', 'Unknown or duplicate option');
      if (['token-stdin', 'allow-model'].includes(key)) options[key] = true;
      else { const value = argv[++i]; if (!value || value.startsWith('--')) throw fault('USAGE', 'Missing option value'); options[key] = value; }
    }
    for (const name of required[command]) if (!options[name]) throw fault('USAGE', `Missing --${name}`);
    const wait = options.wait === undefined ? undefined : Number(options.wait);
    if (wait !== undefined && (!Number.isFinite(wait) || wait < 0)) throw fault('USAGE', '--wait must be nonnegative seconds');
    if (options['token-stdin'] && options['token-file']) throw fault('USAGE');
    if (options.url) options.url = connectionOrigin(options.url);
    let token;
    if (options['token-stdin']) token = await tokenLine(stdin);
    if (options['token-file']) token = (await fs.readFile(path.resolve(cwd, options['token-file']), 'utf8')).trim();
    if ((options['token-stdin'] || options['token-file']) && !token) throw fault('EMPTY_INPUT');
    if (command === 'setup') {
      stdout.write(`${JSON.stringify(await setup(options, { codexHome, token }))}\n`);
      return 0;
    }
    const store = await StateStore.open(await resolveStateDirectory(options['state-dir'], { cwd, codexHome }));
    if (command === 'connections') { stdout.write(`${JSON.stringify(await connections(store))}\n`); return 0; }
    const controller = new Controller({ store });
    let args = { ...options, ...(wait === undefined ? {} : { wait }) };
    if (command === 'attach') args.token = token;
    if (command === 'send') {
      if (!options['allow-model']) throw fault('MODEL_PERMISSION_REQUIRED', 'send requires --allow-model');
      args = { ...args, allowModel: true, text: await fs.readFile(options['text-file'], 'utf8') };
    }
    const result = await controller[command](args);
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    // Native/provider errors can echo request bodies or auth URLs: never print them.
    const code = /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'NATIVE_OR_IO_ERROR';
    stderr.write(`${JSON.stringify({ error: code })}\n`);
    if (code === 'USAGE' || code.startsWith('INVALID_') || code === 'MODEL_PERMISSION_REQUIRED' || code === 'ABSOLUTE_CWD_REQUIRED' || code === 'EMPTY_INPUT') return 2;
    if (/^(STATE_|TASK_|SESSION_ALREADY|CONNECTION_|UNRESOLVED_|APPROVAL_|UNSAFE_)/.test(code)) return 3;
    return 4;
  }
}
