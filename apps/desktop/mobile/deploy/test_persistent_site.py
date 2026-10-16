"""Isolated contract checks for persistent static hosting; no live credentials."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from fastapi import FastAPI
from fastapi.testclient import TestClient

SOURCE = Path(__file__).parent / 'plugin/dashboard/plugin_api.py'

class PersistentSite(unittest.TestCase):
    def test_site_survives_official_output_replacement(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plugin = root / 'user-home/plugins/neo-mobile-web'
            dashboard = plugin / 'dashboard'
            dashboard.mkdir(parents=True)
            api = dashboard / 'plugin_api.py'
            self.assertTrue(SOURCE.is_file(), 'Persistent authenticated static router is missing')
            api.write_bytes(SOURCE.read_bytes())
            spec = importlib.util.spec_from_file_location('fixture_site', api)
            assert spec is not None and spec.loader is not None
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            release = plugin / 'releases/v5-0123456789abcdef'
            release.mkdir(parents=True)
            (release / 'index.html').write_text('fixture Mobile')
            (plugin / 'current').symlink_to('releases/' + release.name)
            official = root / 'installation/hermes_cli/web_dist'
            official.mkdir(parents=True)
            (official / 'index.html').write_text('official before')
            app = FastAPI()
            app.include_router(mod.router, prefix='/api/plugins/neo-mobile-web')
            with TestClient(app) as client:
                url = '/api/plugins/neo-mobile-web/site/index.html'
                self.assertEqual(client.get(url).text, 'fixture Mobile')
                import shutil
                shutil.rmtree(official)
                official.mkdir()
                (official / 'index.html').write_text('official rebuilt')
                self.assertEqual(client.get(url).text, 'fixture Mobile')
                self.assertEqual((official / 'index.html').read_text(), 'official rebuilt')

if __name__ == '__main__':
    unittest.main()
