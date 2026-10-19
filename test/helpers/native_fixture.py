"""Self-contained LOCAL_MOCK full native Web fixture. No legacy probe imports."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from windows_job import Job

KEY = 'controller-e2e-synthetic-not-real'


def events(number, text, tool):
    yield {'type': 'message_start', 'message': {'id': f'e2e-{number}', 'type': 'message', 'role': 'assistant', 'model': 'LOCAL_MOCK', 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 0}}}
    block = {'type': 'tool_use', 'id': tool[2], 'name': tool[0], 'input': {}} if tool else {'type': 'text', 'text': ''}
    yield {'type': 'content_block_start', 'index': 0, 'content_block': block}
    yield {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(tool[1])} if tool else {'type': 'text_delta', 'text': text}}
    yield {'type': 'content_block_stop', 'index': 0}
    yield {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use' if tool else 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 1}}
    yield {'type': 'message_stop'}


class Provider:
    def __init__(self):
        self.count, self.records, self.errors = 0, [], []
        self.lock = threading.Lock()
        self.release = threading.Event()
        self.hold_started = threading.Event()
        self.disconnected = False
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, body):
                raw = json.dumps(body).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                self.reply(owner.snapshot())

            def do_POST(self):
                if self.path == '/release':
                    owner.release.set()
                    return self.reply({'released': True})
                with owner.lock:
                    owner.count += 1
                    number = owner.count
                try:
                    if number > 40 or self.path not in ('/v1/messages', '/anthropic/v1/messages') or self.headers.get('x-api-key') != KEY:
                        raise ValueError('mock request boundary')
                    length = int(self.headers.get('Content-Length', '-1'))
                    if not 0 <= length <= 8 * 1024 * 1024:
                        raise ValueError('mock body boundary')
                    self.connection.settimeout(5)
                    data = json.loads(self.rfile.read(length))
                    text, tool, phase = owner.response(data)
                    owner.records.append({'number': number, 'phase': phase, 'tool': tool[0] if tool else None})
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    self.close_connection = True
                    if phase == 'HOLD':
                        owner.hold_started.set()
                        until = time.monotonic() + 90
                        while not owner.release.wait(.05) and time.monotonic() < until:
                            self.wfile.write(b': heartbeat\n\n')
                            self.wfile.flush()
                    for event in events(number, text, tool):
                        self.wfile.write(('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n').encode())
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    owner.disconnected = True
                except Exception:
                    owner.errors.append('mock protocol/schema boundary')
                    self.send_error(400, 'mock boundary')

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def snapshot(self):
        return {'kind': 'LOCAL_MOCK', 'count': self.count, 'records': self.records, 'errors': self.errors, 'holdStarted': self.hold_started.is_set(), 'disconnected': self.disconnected}

    def response(self, data):
        if not data.get('tools'):
            return 'Controller E2E', None, 'TITLE'
        phase, results = None, []
        for message in data.get('messages', []):
            if message.get('role') != 'user':
                continue
            blocks = message.get('content', [])
            if isinstance(blocks, str):
                blocks = [{'type': 'text', 'text': blocks}]
            for block in blocks:
                marker = re.findall(r'\[E2E:(BUILD|FIX|HOLD|ALLOW|REJECT|OTHER)\]', block.get('text', ''))
                if marker:
                    phase, results = marker[-1], []
                if block.get('type') == 'tool_result':
                    results.append(block)
        if phase in ('HOLD', 'OTHER'):
            return 'E2E_DONE', None, phase
        if phase not in ('BUILD', 'FIX', 'ALLOW', 'REJECT'):
            raise ValueError('phase')
        call = 'e2e-' + phase.lower()
        if any(r.get('tool_use_id') == call for r in results):
            return 'E2E_' + phase + '_DONE', None, phase
        if phase == 'FIX':
            name, args = 'edit', {'file_path': 'result.txt', 'old_string': 'version=1', 'new_string': 'version=2'}
        else:
            name, args = 'write', {'file_path': 'result.txt' if phase == 'BUILD' else '../outbox/' + phase.lower() + '.txt', 'content': 'version=1\n'}
        if phase in ('ALLOW', 'REJECT'):
            args.update(sandbox_permissions='danger-full-access', justification='Owned isolated E2E outbox approval')
        schema = next(t['input_schema'] for t in data['tools'] if t['name'] == name)
        if not set(schema.get('required', [])) <= args.keys():
            raise ValueError('schema')
        return None, (name, args, call), phase


def worker(run, dsh):
    if sys.stdin.readline().strip() != 'GO':
        return 3
    env = {k: v for k, v in os.environ.items() if not any(s in k.upper() for s in ('KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PROXY')) and not k.upper().startswith(('DSH_', 'DEEPSEEK_', 'CODEX_', 'OPENAI_', 'NODE_'))}
    for key, name in {'DSH_HOME': 'home', 'HOME': 'user', 'USERPROFILE': 'user', 'APPDATA': 'user/roaming', 'LOCALAPPDATA': 'user/local', 'XDG_CONFIG_HOME': 'user/config', 'XDG_CACHE_HOME': 'user/cache', 'TEMP': 'temp', 'TMP': 'temp'}.items():
        path = run / name
        path.mkdir(parents=True, exist_ok=True)
        env[key] = str(path)
    for name in ('workspace', 'outbox'):
        (run / name).mkdir()
    mock = Provider()
    env.update(DEEPSEEK_BASE_URL=f'http://127.0.0.1:{mock.server.server_port}', DEEPSEEK_API_KEY=KEY, DSH_PERMISSION_MODE='workspace-write', DSH_APPROVAL_POLICY='ask')
    guard = Path(__file__).with_name('loopback-only.cjs')
    source_fixture = os.environ.get('DSH_APPROVAL_SOURCE_FIXTURE') == '1'
    source_args = []
    if source_fixture:
        env.update(E2E_NATIVE_ROOT=str(dsh), E2E_FIXTURE_DIR=str(run))
        source_args = ['--require', str(Path(__file__).with_name('approval-source-fixture.cjs'))]
    host = subprocess.Popen([shutil.which('node'), '--require', str(guard), *source_args, str(dsh / 'apps/cli/lib/bin.js'), 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], cwd=run / 'workspace', env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    log, overflow = bytearray(), threading.Event()
    def collect():
        while chunk := host.stdout.read1(4096):
            if len(log) + len(chunk) > 4 * 1024 * 1024:
                overflow.set()
                host.kill()
                return
            log.extend(chunk)
    threading.Thread(target=collect, daemon=True).start()
    until = time.monotonic() + 50
    while time.monotonic() < until:
        match = re.search(rb'dsh web: http://127\.0\.0\.1:(\d+)/\?token=([^\s]+)', log)
        if match:
            break
        if host.poll() is not None:
            raise RuntimeError('isolated native host startup failed')
        time.sleep(.05)
    else:
        raise RuntimeError('isolated native host startup timeout')
    ready = {'ready': True, 'port': int(match[1]), 'token': match[2].decode(), 'mockPort': mock.server.server_port, 'hostPid': host.pid}
    print(json.dumps(ready), flush=True)
    sys.stdin.read()  # EOF from supervisor or owner death ends this fixture.
    (run / 'fixture-result.json').write_text(json.dumps({'provider': mock.snapshot(), 'egressDenied': log.count(b'[e2e-egress-denied]'), 'logOverflow': overflow.is_set(), 'hostPid': host.pid, 'hostPort': ready['port'], 'mockPort': ready['mockPort'], 'executionMode': 'SOURCE_FIXTURE' if source_fixture else 'INSTALLED_BUILT'}))
    mock.release.set()
    return 0


def released(port):
    stable, until = 0, time.monotonic() + 5
    while time.monotonic() < until and stable < 3:
        with socket.socket() as sock:
            sock.settimeout(.2)
            stable = stable + 1 if sock.connect_ex(('127.0.0.1', port)) != 0 else 0
        time.sleep(.05)
    return stable == 3


def supervisor(run, dsh):
    job, child = Job(), None
    timer = threading.Timer(240, job.terminate)
    timer.daemon = True
    timer.start()
    try:
        child = subprocess.Popen([sys.executable, '-B', __file__, '--worker', str(run), str(dsh)], stdin=subprocess.PIPE)
        job.attach(child)
        child.stdin.write(b'GO\n')
        child.stdin.flush()
        sys.stdin.read()
        child.stdin.close()
        child.wait(timeout=10)
    finally:
        job.terminate()
        for _ in range(100):
            if job.active() == 0:
                break
            time.sleep(.02)
        active = job.active()
        job.close()
        timer.cancel()
        report_file = run / 'fixture-result.json'
        report = json.loads(report_file.read_text()) if report_file.exists() else {'fixtureIncomplete': True}
        report['jobActiveAfterCleanup'] = active
        report['hostPortReleased'] = released(report['hostPort']) if report.get('hostPort') else False
        report['mockPortReleased'] = released(report['mockPort']) if report.get('mockPort') else False
        report_file.write_text(json.dumps(report))


if __name__ == '__main__':
    try:
        if sys.argv[1] == '--worker':
            sys.exit(worker(Path(sys.argv[2]), Path(sys.argv[3])))
        supervisor(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception:
        print(json.dumps({'fixtureError': 'isolated native fixture failed; private local evidence retained'}), flush=True)
        sys.exit(1)
