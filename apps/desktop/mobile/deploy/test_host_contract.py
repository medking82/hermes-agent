"""Exercise the installed host in a private test home, never the live server.

Set MOBILE_TEST_RUNTIME to the exact Hermes checkout being validated. Only the
identity provider is synthetic; native auth, plugin discovery/hot mounting and
image upload run unchanged. No gateway/session/model request is made.
"""
import base64
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


class HostContract(unittest.TestCase):
    def test_native_auth_hot_mount_and_photo_upload(self):
        runtime = os.environ.get('MOBILE_TEST_RUNTIME')
        self.assertTrue(runtime, 'Set MOBILE_TEST_RUNTIME to the intended host checkout')
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
            'HOME': temp, 'HERMES_HOME': str(Path(temp) / '.hermes'),
        }):
            home = Path(temp) / '.hermes'
            home.mkdir()
            config = home / 'config.yaml'
            config.write_text('plugins:\n  enabled: []\n  disabled: []\n')
            assert runtime is not None
            sys.path.insert(0, runtime)
            from hermes_cli import web_server
            from hermes_cli.dashboard_auth import (
                DashboardAuthProvider, Session, clear_providers, register_provider,
            )
            from hermes_cli.web_server_dashboard import _plugin_api_mounted
            from starlette.testclient import TestClient

            class FixtureProvider(DashboardAuthProvider):
                name = 'mobile-fixture'
                display_name = 'Isolated test identity'

                def start_login(self, **kwargs):
                    raise AssertionError('No login network request is allowed')

                def complete_login(self, **kwargs):
                    raise AssertionError('No login network request is allowed')

                def verify_session(self, *, access_token):
                    if access_token != 'fixture-cookie-value':
                        return None
                    return Session('fixture-user', '', 'fixture', '', self.name,
                                   int(time.time()) + 3600, access_token, '')

                def refresh_session(self, **kwargs):
                    raise AssertionError('No refresh is expected')

                def revoke_session(self, **kwargs):
                    raise AssertionError('No revocation is expected')

            clear_providers()
            self.addCleanup(clear_providers)
            register_provider(FixtureProvider())
            web_server.app.state.auth_required = True
            client = TestClient(web_server.app, base_url='http://127.0.0.1', follow_redirects=False)
            self.addCleanup(client.close)
            plugin = home / 'plugins/neo-mobile-web'
            shutil.copytree(Path(__file__).parent / 'plugin', plugin)
            release = plugin / 'releases/v5-0123456789abcdef'
            release.mkdir(parents=True)
            (release / 'index.html').write_text('fixture persistent Mobile')
            (release / 'photo.png').write_bytes(b'fixture-static-only')
            (release / 'manifest.webmanifest').write_text('{"name":"Fixture Mobile"}')
            (release / '.private.json').write_text('not public')
            (home / 'private.json').write_text('outside static tree')
            (release / 'escape.json').symlink_to(home / 'private.json')
            (plugin / 'current').symlink_to('releases/' + release.name)
            url = '/api/plugins/neo-mobile-web/site/index.html'
            self.assertEqual(client.get(url).status_code, 401)
            self.assertFalse(_plugin_api_mounted(web_server.app, 'neo-mobile-web'))
            client.cookies.set('hermes_session_at', 'fixture-cookie-value')
            self.assertEqual(client.get(url).status_code, 404)
            self.assertFalse(_plugin_api_mounted(web_server.app, 'neo-mobile-web'))
            config.write_text('plugins:\n  enabled: [neo-mobile-web]\n  disabled: []\n')
            response = client.get(url)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.text, 'fixture persistent Mobile')
            self.assertTrue(_plugin_api_mounted(web_server.app, 'neo-mobile-web'))
            self.assertEqual(response.headers['cache-control'], 'no-store')
            self.assertIn('text/html', response.headers['content-type'])
            manifest = client.get('/api/plugins/neo-mobile-web/site/manifest.webmanifest')
            self.assertEqual(manifest.status_code, 200)
            self.assertEqual(manifest.headers['content-type'], 'application/manifest+json')
            self.assertEqual(manifest.json()['name'], 'Fixture Mobile')
            self.assertEqual(client.get(url + '?profile=default').status_code, 200)
            for path in ['.private.json', 'escape.json', '%2e%2e/private.json', 'missing.js', '']:
                self.assertEqual(client.get('/api/plugins/neo-mobile-web/site/' + path).status_code, 404, path)
            self.assertEqual(client.get(url + '?profile=foreign-fixture').status_code, 404)
            plugins = client.get('/api/dashboard/plugins?profile=default').json()
            self.assertIn('neo-mobile-web', [p['name'] for p in plugins])
            entry = client.get('/dashboard-plugins/neo-mobile-web/index.js')
            self.assertEqual(entry.status_code, 200)
            self.assertIn('header-banner', entry.text)
            self.assertNotIn('export function', entry.text)
            # Real image upload writes only into this isolated profile's images.
            png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')
            upload = client.post('/api/chat/image-upload?profile=default', json={
                'filename': 'fixture.png', 'data_url': 'data:image/png;base64,' + base64.b64encode(png).decode(),
            })
            self.assertEqual(upload.status_code, 200, upload.text)
            saved = Path(upload.json()['path'])
            self.assertEqual(saved.parent, home / 'images')
            self.assertEqual(saved.read_bytes(), png)
            self.assertEqual(upload.json()['bytes'], len(png))
            self.assertEqual(client.get('/api/plugins/neo-mobile-web/site/' + saved.name).status_code, 404)
            # Disable after mounting: the native gate must still refuse every read.
            config.write_text('plugins:\n  enabled: [neo-mobile-web]\n  disabled: [neo-mobile-web]\n')
            self.assertEqual(client.get(url).status_code, 404)
            client.cookies.clear()
            self.assertEqual(client.get(url).status_code, 401)
            self.assertEqual(client.post('/api/chat/image-upload', json={}).status_code, 401)


if __name__ == '__main__':
    unittest.main()
