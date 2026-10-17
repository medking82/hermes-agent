"""Synthetic, memory-only security relay fixtures. No production peer or secret."""
import importlib.util
import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psutil

if runtime := os.environ.get('MOBILE_TEST_RUNTIME'):  # health: allow HX005 -- fixture selects its isolated native runtime before imports, not production profile state
    sys.path.insert(0, runtime)

SPEC = importlib.util.spec_from_file_location(
    'fixture_mobile_security', Path(__file__).parent / 'plugin/dashboard/plugin_api.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class NativePeer:
    def __init__(self):
        self.calls = []
        self.live = True
        self.epoch = 'fixture-native-epoch'
        self.requests = [{'id': 'fixture-request', 'method': 'sudo',
                          'params': {'session_id': 'fixture-runtime', 'command': 'sudo -v'}}]

    async def check(self):
        if not self.live:
            raise RuntimeError('fixture owner changed')

    async def rpc(self, method, params):
        self.calls.append((method, params))
        if method == 'session.events.since':
            return {'epoch': self.epoch, 'open_requests': self.requests}
        if method == 'request.answer':
            if any(r['id'] == params['id'] for r in self.requests):
                self.requests = []
                return {'status': 'ok'}
            return {'status': 'expired'}
        raise AssertionError('Unexpected native method')


class SecurityControls(unittest.IsolatedAsyncioTestCase):
    async def test_real_loopback_peer_delivers_only_once_to_native_resolver(self):
        from urllib.parse import parse_qs, urlsplit
        from websockets.asyncio.server import serve
        from websockets.datastructures import Headers
        from websockets.http11 import Response
        from tui_gateway import server_requests as native

        # A synthetic private HTTP/WS host, not desktop startup: no lifecycle
        # sweep, model, tool, real identity or production request is executed.
        outcomes, methods = [], []
        def http(_connection, request):
            if request.path == '/':
                body = b'<script>window.__HERMES_SESSION_TOKEN__="fixture-peer-credential";</script>'
                return Response(200, 'OK', Headers({'Content-Type': 'text/html'}), body)
            if request.path == '/api/host/identity':
                assert request.headers['X-Hermes-Session-Token'] == 'fixture-peer-credential'
                body = json.dumps({'pid': os.getpid(), 'role': 'desktop-serve'}).encode()
                return Response(200, 'OK', Headers({'Content-Type': 'application/json'}), body)
            assert urlsplit(request.path).path == '/api/ws'
            assert parse_qs(urlsplit(request.path).query) == {'token': ['fixture-peer-credential']}
            return None

        async def wire(ws):
            async for raw in ws:
                request = json.loads(raw)
                method, params = request['method'], request['params']
                methods.append(method)
                if method == 'session.active_list':
                    result = {'sessions': [{'id': 'fixture-runtime', 'session_key': 'fixture-stored'}]}
                elif method == 'session.events.since':
                    result = {'epoch': 'fixture-epoch', 'open_requests': native.open_requests('fixture-runtime')}
                else:
                    assert method == 'request.answer'
                    accepted = native.resolve_response({'id': params['id'], 'result': params['result']})
                    result = {'status': 'ok' if accepted else 'expired'}
                await ws.send(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}))

        with tempfile.TemporaryDirectory() as temp, patch.object(native, '_write'), \
                patch.object(native, '_emit'), patch.object(native, '_answerable', return_value=True):
            home = Path(temp)
            (home / 'runtime').mkdir()
            entry = {'lease_id': 'fixture-lease', 'session_id': 'fixture-stored', 'pid': os.getpid(),
                     'process_start_time': psutil.Process().create_time(), 'surface': 'desktop',
                     'metadata': {'live_session_id': 'fixture-runtime'}}
            registry = home / 'runtime/active_sessions.json'
            registry.write_text(json.dumps({'entries': [entry]}))
            registry.chmod(0o600)
            before = registry.read_bytes()
            async with serve(wire, '127.0.0.1', 0, process_request=http) as server:
                peer = module.NativePeer(home, entry, server.sockets[0].getsockname()[1])
                settle = native.send_async('sudo', 'fixture-runtime', {'command': 'sudo -v'}, outcomes.append)
                try:
                    await peer.connect()
                    channel = module.SecurityChannel(peer, 'fixture-stored', 'fixture-runtime', 'fixture-backend')
                    snapshot = await channel.snapshot()
                    rid = snapshot['requests'][0]['id']
                    answer = {'generation': snapshot['generation'], 'id': rid,
                              'result': {'value': 'fixture-password-value'}}
                    self.assertEqual((await channel.answer(answer))['status'], 'ok')
                    self.assertEqual((await channel.answer(answer))['status'], 'expired')
                    self.assertEqual(outcomes, [{'value': 'fixture-password-value'}])
                    self.assertEqual(methods.count('request.answer'), 1)
                    self.assertEqual(registry.read_bytes(), before)
                finally:
                    await peer.close()
                    settle('fixture-cleanup')

    async def test_native_first_responder_wins_and_cancelled_requests_cannot_be_replayed(self):
        from tui_gateway import server_requests as native
        outcomes = []
        with patch.object(native, '_write'), patch.object(native, '_emit'), \
                patch.object(native, '_answerable', return_value=True):
            class QueuePeer(NativePeer):
                def __init__(self):
                    super().__init__()
                    self.racing = asyncio.Event()
                async def rpc(self, method, params):
                    if method == 'session.events.since':
                        return {'epoch': self.epoch, 'open_requests': native.open_requests('fixture-runtime')}
                    if method == 'request.answer':
                        self.calls.append((method, params))
                        if len(self.calls) == 2:
                            self.racing.set()
                        await asyncio.wait_for(self.racing.wait(), 1)
                        accepted = native.resolve_response({'id': params['id'], 'result': params['result']})
                        return {'status': 'ok' if accepted else 'expired'}
                    raise AssertionError(method)
            peer = QueuePeer()
            settle = native.send_async('sudo', 'fixture-runtime', {'command': 'sudo -v'}, outcomes.append)
            try:
                first, second = [module.SecurityChannel(peer, 'fixture-stored', 'fixture-runtime', 'fixture-backend') for _ in range(2)]
                for channel in (first, second):
                    await channel.snapshot()
                rid = next(iter(first.pending))
                replies = await asyncio.gather(*[channel.answer({'generation': channel.generation, 'id': rid,
                    'result': {'value': 'fixture-password-value'}}) for channel in (first, second)])
                self.assertEqual(sorted(r['status'] for r in replies), ['expired', 'ok'])
                self.assertEqual(outcomes, [{'value': 'fixture-password-value'}])
                self.assertEqual(len(peer.calls), 2)
                self.assertEqual(native.open_requests('fixture-runtime'), [])
            finally:
                settle('fixture-cleanup')
            settle = native.send_async('approval', 'fixture-runtime', {
                'command': 'fixture-command', 'description': 'fixture', 'choices': ['once', 'deny']}, outcomes.append)
            try:
                await first.snapshot()
                rid = next(iter(first.pending))
                native.cancel('fixture-runtime', 'timeout')
                reply = await first.answer({'generation': first.generation, 'id': rid, 'result': {'choice': 'once'}})
                self.assertEqual(reply['status'], 'expired')
                self.assertEqual(len(peer.calls), 2)
            finally:
                settle('fixture-cleanup')

    async def test_binding_rejects_wrong_generation_owner_epoch_and_modified_request(self):
        for change in ('generation', 'request', 'owner', 'epoch', 'command'):
            with self.subTest(change=change):
                peer = NativePeer()
                channel = module.SecurityChannel(peer, 'fixture-stored', 'fixture-runtime', 'fixture-backend')
                await channel.snapshot()
                answer = {'generation': channel.generation, 'id': 'fixture-request', 'result': {'value': 'fixture-password-value'}}
                if change == 'generation': answer['generation'] = 'fixture-stale'
                if change == 'request': answer['id'] = 'fixture-foreign'
                if change == 'owner': peer.live = False
                if change == 'epoch': peer.epoch = 'fixture-restarted'
                if change == 'command': peer.requests[0]['params']['command'] = 'fixture-replacement'
                if change in ('owner', 'epoch'):
                    with self.assertRaises(RuntimeError): await channel.answer(answer)
                else:
                    self.assertEqual((await channel.answer(answer))['status'], 'expired')
                self.assertFalse(any(m == 'request.answer' for m, _ in peer.calls))

    async def test_security_scope_rejects_persistent_approval_and_foreign_session_and_never_retries_unknown_ack(self):
        peer = NativePeer()
        peer.requests.extend([{'id': 'fixture-foreign', 'method': 'sudo', 'params': {'session_id': 'foreign'}},
                              {'id': 'fixture-secret', 'method': 'secret', 'params': {'session_id': 'fixture-runtime'}}])
        channel = module.SecurityChannel(peer, 'fixture-stored', 'fixture-runtime', 'fixture-backend')
        self.assertEqual([r['id'] for r in (await channel.snapshot())['requests']], ['fixture-request'])
        peer.requests[0] = {'id': 'fixture-request', 'method': 'approval',
                            'params': {'session_id': 'fixture-runtime', 'command': 'fixture', 'choices': ['once', 'deny']}}
        await channel.snapshot()
        with self.assertRaises(ValueError):
            await channel.answer({'generation': channel.generation, 'id': 'fixture-request', 'result': {'choice': 'always'}})
        original_rpc = peer.rpc
        async def timeout_rpc(method, params):
            if method == 'request.answer': raise TimeoutError('fixture unknown delivery')
            return await original_rpc(method, params)
        peer.rpc = timeout_rpc
        message = {'generation': channel.generation, 'id': 'fixture-request', 'result': {'choice': 'deny'}}
        with self.assertRaises(TimeoutError): await channel.answer(message)
        self.assertEqual((await channel.answer(message))['status'], 'expired')

    async def test_answer_uses_original_native_id_and_is_never_replayed(self):
        self.assertTrue(hasattr(module, 'SecurityChannel'), 'Missing security-only native relay')
        peer = NativePeer()
        channel = module.SecurityChannel(peer, 'fixture-stored', 'fixture-runtime', 'fixture-backend')
        snapshot = await channel.snapshot()
        answer = {'generation': snapshot['generation'], 'id': 'fixture-request',
                  'result': {'value': 'fixture-password-value'}}
        self.assertEqual(await channel.answer(answer), {'id': 'fixture-request', 'status': 'ok'})
        self.assertEqual(await channel.answer(answer), {'id': 'fixture-request', 'status': 'expired'})
        writes = [p for m, p in peer.calls if m == 'request.answer']
        self.assertEqual(writes, [{'id': 'fixture-request', 'result': {'value': 'fixture-password-value'}}])
        self.assertEqual((await channel.snapshot())['requests'], [])


    async def test_owner_heartbeat_is_not_a_new_connection_but_lease_change_is(self):
        entry = {'session_id': 'fixture-stored', 'lease_id': 'fixture-lease', 'pid': 17,
                 'process_start_time': 12.5, 'updated_at': 10, 'surface': 'desktop',
                 'metadata': {'live_session_id': 'fixture-runtime', 'status': 'working'}}
        peer = module.NativePeer(Path('/fixture'), entry, 34567)
        updated = {**entry, 'updated_at': 11, 'metadata': {**entry['metadata'], 'status': 'waiting'}}
        with patch.object(module, 'read_owners', return_value=[{'entry': updated, 'ports': [34567]}]):
            await peer.check_owner()
            updated['lease_id'] = 'fixture-replacement'
            with self.assertRaisesRegex(RuntimeError, 'Original owner changed'):
                await peer.check_owner()

    async def test_native_peer_authenticates_pinned_loopback_and_keeps_password_out_of_urls(self):
        self.assertTrue(hasattr(module, 'NativePeer'), 'Missing original-backend peer')
        import httpx
        class Wire:
            def __init__(self):
                self.sent = []
            async def send(self, text):
                self.sent.append(json.loads(text))
            async def recv(self):
                req = self.sent[-1]
                result = {'sessions': [{'id': 'fixture-runtime', 'session_key': 'fixture-stored'}]}
                if req['method'] == 'request.answer':
                    result = {'status': 'ok'}
                return json.dumps({'id': req['id'], 'result': result})
            async def close(self):
                pass
        wire, urls = Wire(), []
        async def connect(url, **kwargs):
            urls.append(url)
            return wire
        def http(request):
            urls.append(str(request.url))
            if request.url.path == '/':
                return httpx.Response(200, text='<script>window.__HERMES_SESSION_TOKEN__="fixture-peer-credential";</script>')
            return httpx.Response(200, json={'pid': 17, 'role': 'desktop-serve'})
        entry = {'session_id': 'fixture-stored', 'pid': 17, 'process_start_time': 12.5,
                 'metadata': {'live_session_id': 'fixture-runtime'}}
        with patch.object(module, 'read_owners', return_value=[{'entry': entry, 'ports': [34567]}]):
            async with httpx.AsyncClient(transport=httpx.MockTransport(http)) as client:
                peer = module.NativePeer(Path('/fixture'), entry, 34567)
                await peer.connect(client=client, connector=connect)
                await peer.check()
                await peer.rpc('request.answer', {'id': 'fixture-request',
                               'result': {'value': 'fixture-password-value'}})
                await peer.close()
        self.assertTrue(all('fixture-password-value' not in url for url in urls))
        self.assertTrue(all(url.startswith(('http://127.0.0.1:34567/', 'ws://127.0.0.1:34567/')) for url in urls))
        self.assertEqual([r['method'] for r in wire.sent], ['session.active_list', 'request.answer'])


class SecurityRoute(unittest.TestCase):
    def test_phone_can_list_held_tasks_without_resuming_them(self):
        with tempfile.TemporaryDirectory() as temp, socket.socket() as listener:
            home = Path(temp)
            (home / 'runtime').mkdir()
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            registry = home / 'runtime/active_sessions.json'
            registry.write_text(json.dumps({'entries': [{'lease_id': 'fixture-lease',
                'session_id': 'fixture-stored', 'pid': os.getpid(),
                'process_start_time': psutil.Process().create_time(), 'surface': 'desktop',
                'metadata': {'live_session_id': 'fixture-runtime'}}]}))
            registry.chmod(0o600)
            before = registry.read_bytes()
            app = FastAPI()
            app.include_router(module.router, prefix='/api/plugins/neo-mobile-web')
            with patch.object(module, '_security_home', return_value=home), \
                    patch.object(module, '_plugin_enabled', return_value=True), TestClient(app) as client:
                reply = client.get('/api/plugins/neo-mobile-web/security/sessions')
                self.assertEqual(reply.status_code, 200)
                self.assertEqual(reply.json()['sessions'][0]['session_key'], 'fixture-stored')
                self.assertEqual(reply.headers['cache-control'], 'no-store')
                self.assertEqual(client.get('/api/plugins/neo-mobile-web/security/sessions?profile=other').status_code, 404)
            self.assertEqual(registry.read_bytes(), before)
            self.assertFalse((home / 'state.db').exists())

    def test_socket_forwards_only_selected_task_and_closing_never_answers(self):
        self.assertTrue(hasattr(module, '_open_peer'), 'Missing authenticated security route')
        peer = NativePeer()
        peer.entry = {'session_id': 'fixture-stored', 'pid': 17, 'process_start_time': 12.5,
                      'metadata': {'live_session_id': 'fixture-runtime'}}
        async def open_peer(home, key):
            self.assertEqual(key, 'fixture-stored')
            return peer
        async def admit(ws):
            return True
        async def close():
            pass
        peer.close = close
        app = FastAPI()
        app.include_router(module.router, prefix='/api/plugins/neo-mobile-web')
        with patch.object(module, '_open_peer', open_peer), patch.object(module, '_security_admit', admit), \
                patch.object(module, '_security_home', return_value=Path('/fixture')), \
                patch.object(module, '_plugin_enabled', return_value=True), TestClient(app) as client:
            with client.websocket_connect('/api/plugins/neo-mobile-web/security/ws') as ws:
                ws.send_json({'session_key': 'fixture-stored'})
                snapshot = ws.receive_json()
                self.assertEqual(snapshot['type'], 'snapshot')
                self.assertEqual(snapshot['session_key'], 'fixture-stored')
                ws.send_json({'generation': snapshot['generation'], 'id': 'fixture-request',
                              'result': {'value': 'fixture-password-value'}})
                self.assertEqual(ws.receive_json(), {'type': 'answer', 'id': 'fixture-request', 'status': 'ok'})
                self.assertEqual(ws.receive_json()['requests'], [])
        writes = [p for m, p in peer.calls if m == 'request.answer']
        self.assertEqual(len(writes), 1)


class SecurityDiscovery(unittest.TestCase):
    def test_registry_discovery_is_read_only_and_pins_live_uid_start_listener(self):
        self.assertTrue(hasattr(module, 'read_owners'), 'Missing identity-pinned owner discovery')
        with tempfile.TemporaryDirectory() as temp, socket.socket() as listener:
            home = Path(temp) / 'fixture-profile'
            self.assertEqual(module.read_owners(home), [])
            self.assertFalse(home.exists())
            (home / 'runtime').mkdir(parents=True)
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            entry = {'lease_id': 'fixture-lease', 'session_id': 'fixture-stored',
                     'pid': os.getpid(), 'process_start_time': psutil.Process().create_time(),
                     'surface': 'desktop', 'metadata': {'live_session_id': 'fixture-runtime',
                     'url': 'https://untrusted.invalid:4444'}}
            registry = home / 'runtime/active_sessions.json'
            registry.write_text(json.dumps({'entries': [entry]}))
            registry.chmod(0o600)
            before = registry.read_bytes()
            owners = module.read_owners(home)
            self.assertEqual(len(owners), 1)
            self.assertEqual(owners[0]['entry'], entry)
            self.assertIn(listener.getsockname()[1], owners[0]['ports'])
            self.assertEqual(registry.read_bytes(), before)
            self.assertFalse((home / 'runtime/active_sessions.lock').exists())
            entry['process_start_time'] -= 100
            registry.write_text(json.dumps({'entries': [entry]}))
            self.assertEqual(module.read_owners(home), [])


if __name__ == '__main__':
    unittest.main()
