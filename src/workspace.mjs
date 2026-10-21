import { NativeClient } from './native.mjs';
import { fault, identifier } from './store.mjs';
import { directoryIdentity, sameDirectory } from './identity.mjs';

const nativeId = value => typeof value === 'string' && value.length > 0;

function workspaceView(value) {
  if (!nativeId(value?.workspaceId) || typeof value.path !== 'string' || typeof value.title !== 'string'
      || !Array.isArray(value.sessionIds) || !value.sessionIds.every(nativeId)) throw fault('WORKSPACE_PROTOCOL_UNKNOWN');
  return { workspaceId: value.workspaceId, path: value.path, title: value.title, sessionIds: [...value.sessionIds] };
}

export class WorkspaceService {
  constructor({ store, clientFactory = config => new NativeClient(config), timeoutMs = 15000 }) {
    this.store = store; this.clientFactory = clientFactory; this.timeoutMs = timeoutMs;
  }

  async client(connection) {
    identifier(connection);
    const config = await this.store.transaction(state => structuredClone(state.connections[connection]));
    if (!config) throw fault('CONNECTION_NOT_FOUND');
    return this.clientFactory(config);
  }

  async list({ connection }) {
    const client = await this.client(connection);
    let resolveBaseline, rejectBaseline, rejectFailure, handle, timer;
    const baseline = new Promise((resolve, reject) => { resolveBaseline = resolve; rejectBaseline = reject; });
    const failure = new Promise((resolve, reject) => { rejectFailure = reject; });
    // A synchronous stream factory can reject before the consumer installs its await.
    baseline.catch(() => {});
    failure.catch(() => {});
    try {
      timer = setTimeout(() => rejectFailure(fault('WORKSPACE_OPEN_TIMEOUT')), this.timeoutMs);
      handle = client.stream('workspace/follow', {}, {
        onItem: item => {
          try {
            if (item?.type !== 'baseline' || !Array.isArray(item.value?.items)
                || !Array.isArray(item.value.archivedSessionIds) || !item.value.archivedSessionIds.every(nativeId)
                || !Array.isArray(item.value.pinnedSessionIds) || !item.value.pinnedSessionIds.every(nativeId)) {
              throw fault('WORKSPACE_PROTOCOL_UNKNOWN');
            }
            const items = item.value.items.map(workspaceView);
            if (new Set(items.map(item => item.workspaceId)).size !== items.length) throw fault('WORKSPACE_PROTOCOL_UNKNOWN');
            resolveBaseline(items);
          } catch (error) { rejectBaseline(error); }
        },
        onError: rejectFailure,
        onClose: error => rejectFailure(error ?? fault('WORKSPACE_NO_BASELINE')),
      });
      handle.closed.then(() => rejectFailure(fault('WORKSPACE_NO_BASELINE')), rejectFailure);
      const [, items] = await Promise.race([Promise.all([handle.ready, baseline]), failure]);
      return items;
    } finally { clearTimeout(timer); handle?.close(); }
  }

  async get({ connection, workspaceId }) {
    if (!nativeId(workspaceId)) throw fault('INVALID_WORKSPACE_ID');
    const workspace = (await this.list({ connection })).find(item => item.workspaceId === workspaceId);
    if (!workspace) throw fault('WORKSPACE_NOT_FOUND');
    return workspace;
  }

  async create({ connection, cwd }) {
    const expected = await directoryIdentity(cwd);
    const client = await this.client(connection);
    const result = await client.rpc('workspace/create', { request: { path: expected.path } });
    if (typeof result?.created !== 'boolean') throw fault('WORKSPACE_PROTOCOL_UNKNOWN');
    const returned = workspaceView(result.workspace);
    const verify = async workspace => {
      let actual;
      try { actual = await directoryIdentity(workspace.path); } catch { throw fault('WORKSPACE_CWD_MISMATCH'); }
      if (!sameDirectory(expected, actual)) throw fault('WORKSPACE_CWD_MISMATCH');
    };
    await verify(returned);
    const workspace = await this.get({ connection, workspaceId: returned.workspaceId });
    await verify(workspace);
    return { workspace, created: result.created };
  }
}
