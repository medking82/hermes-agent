"""Native host admission in a fresh isolated HOME; no real identity or model/tool.

The private execution peer is synthetic. Ticket mint/consume, plugin mounting,
Host/Origin/profile gates and the one-shot native request resolver are real.
"""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


def host_fixture():
    from fastapi.testclient import TestClient
    from starlette.testclient import WebSocketDenialResponse
    from starlette.websockets import WebSocketDisconnect
    from hermes_cli import web_server
    from hermes_cli.dashboard_auth import DashboardAuthProvider, Session, clear_providers, register_provider
    from tui_gateway import server_requests as native

    class Identity(DashboardAuthProvider):
        name = 'mobile-security-fixture'
        display_name = 'Isolated fixture identity'
        def start_login(self, **kwargs): raise AssertionError('No external login')
        def complete_login(self, **kwargs): raise AssertionError('No external login')
        def verify_session(self, *, access_token):
            if access_token == 'fixture-cookie-value':
                return Session('fixture-user', '', 'fixture', '', self.name, int(time.time()) + 3600, access_token, '')
            return None
        def refresh_session(self, **kwargs): raise AssertionError('No refresh')
        def revoke_session(self, **kwargs): raise AssertionError('No revocation')

    home = Path(os.environ['HERMES_HOME'])
    home.mkdir(exist_ok=True)
    config = home / 'config.yaml'
    config.write_text('plugins:\n  enabled: [neo-mobile-web]\n  disabled: []\n')
    plugin = home / 'plugins/neo-mobile-web'
    shutil.copytree(Path(__file__).parent / 'plugin', plugin)
    clear_providers()
    register_provider(Identity())
    web_server.app.state.auth_required = True
    web_server.app.state.bound_host = '127.0.0.1'
    client = TestClient(web_server.app, base_url='https://127.0.0.1', follow_redirects=False)
    endpoint = '/api/plugins/neo-mobile-web/security'
    assert client.get(endpoint + '/sessions').status_code == 401
    client.cookies.set('hermes_session_at', 'fixture-cookie-value')
    assert client.get(endpoint + '/sessions').status_code == 200
    mounted = next(r.endpoint for r in web_server.app.routes if getattr(r, 'path', '') == endpoint + '/ws')
    outcomes = []

    class Peer:
        entry = {'pid': 17, 'process_start_time': 12.5, 'metadata': {'live_session_id': 'fixture-runtime'}}
        async def check(self): pass
        async def close(self): pass
        async def rpc(self, method, params):
            if method == 'session.events.since':
                return {'epoch': 'fixture-epoch', 'open_requests': native.open_requests('fixture-runtime')}
            assert method == 'request.answer'
            accepted = native.resolve_response({'id': params['id'], 'result': params['result']})
            return {'status': 'ok' if accepted else 'expired'}

    async def open_peer(_home, key):
        assert _home == home and key == 'fixture-stored'
        return Peer()

    def ticket():
        response = client.post('/api/auth/ws-ticket', headers={'Origin': 'https://127.0.0.1'})
        assert response.status_code == 200, response.status_code
        return response.json()['ticket']

    def refused(path, origin='https://127.0.0.1'):
        try:
            with client.websocket_connect('wss://127.0.0.1' + path, headers={'Origin': origin}):
                raise AssertionError('Expected authentication or scope rejection')
        except WebSocketDenialResponse as exc:
            assert exc.status_code in (401, 403, 404), exc.status_code
        except WebSocketDisconnect as exc:
            assert exc.code in (4401, 4403), exc.code

    with patch.dict(mounted.__globals__, _open_peer=open_peer), patch.object(native, '_write'), \
            patch.object(native, '_emit'), patch.object(native, '_answerable', return_value=True):
        refused(endpoint + '/ws')  # Cookies alone cannot authorize a WS upgrade.
        refused(endpoint + '/ws?ticket=fixture-invalid')
        refused(endpoint + '/ws?ticket=' + ticket(), 'https://foreign.invalid')
        refused(endpoint + '/ws?ticket=' + ticket() + '&profile=other')
        settle = native.send_async('sudo', 'fixture-runtime', {'command': 'sudo -v'}, outcomes.append)
        accepted_ticket = ticket()
        try:
            with client.websocket_connect('wss://127.0.0.1' + endpoint + '/ws?ticket=' + accepted_ticket,
                                          headers={'Origin': 'https://127.0.0.1'}) as ws:
                ws.send_json({'session_key': 'fixture-stored'})
                frame = ws.receive_json()
                assert frame['type'] == 'snapshot', frame['type']
                rid = frame['requests'][0]['id']
                ws.send_json({'generation': frame['generation'], 'id': rid,
                              'result': {'value': 'fixture-password-value'}})
                assert ws.receive_json() == {'type': 'answer', 'id': rid, 'status': 'ok'}
                assert ws.receive_json()['requests'] == []
            assert outcomes == [{'value': 'fixture-password-value'}]
            refused(endpoint + '/ws?ticket=' + accepted_ticket)
            fresh = ticket()
            config.write_text('plugins:\n  enabled: [neo-mobile-web]\n  disabled: [neo-mobile-web]\n')
            refused(endpoint + '/ws?ticket=' + fresh)
            assert client.get(endpoint + '/sessions').status_code == 404
        finally:
            settle('fixture-cleanup')
            client.close()
            clear_providers()
    print('native auth, single-use ticket, foreign origin/profile, disable and original resolver: verified')


class NativeHostSecurity(unittest.TestCase):
    def test_isolated_native_host_security(self):
        runtime = os.environ.get('MOBILE_TEST_RUNTIME')
        self.assertTrue(runtime)
        assert runtime is not None
        with tempfile.TemporaryDirectory() as temp:
            env = dict(os.environ, HOME=temp, HERMES_HOME=str(Path(temp) / '.hermes'), PYTHONPATH=runtime)
            child = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--fixture'],
                                   env=env, cwd=temp, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=40, check=False)
            self.assertEqual(child.returncode, 0, child.stdout)


if __name__ == '__main__':
    if '--fixture' in sys.argv:
        host_fixture()
    else:
        unittest.main()
