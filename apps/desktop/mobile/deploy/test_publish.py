import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('mobile_publish', Path(__file__).with_name('publish.py'))
assert SPEC is not None and SPEC.loader is not None
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class PersistentPublish(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.home = root / 'stage'
        self.target = root / 'profile/plugins/neo-mobile-web'
        self.official = root / 'installation/web_dist'
        self.official.mkdir(parents=True)
        (self.official / 'index.html').write_text('official dashboard')
        self.home.mkdir()
        artifact = self.home / 'artifact'
        artifact.mkdir()
        (artifact / 'index.html').write_text('fixture Mobile')
        plugin = self.home / 'plugin/dashboard'
        plugin.mkdir(parents=True)
        (plugin / 'manifest.json').write_text('{"name":"neo-mobile-web"}')
        (plugin / 'index.js').write_text('// fixture navigation')
        (plugin / 'plugin_api.py').write_text('# fixture router')
        manifest = module.inventory(artifact)
        bundle = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
        self.plan = {'domain': 'neo.hankee.com', 'site_root': str(self.target),
                     'release': 'v5-' + bundle[:16], 'bundle_sha256': bundle,
                     'manifest': manifest, 'artifact_files': len(manifest),
                     'plugin_manifest': module.inventory(self.home / 'plugin'),
                     'source_commit': 'fixture-source'}
        self.save_plan()
        self.addCleanup(patch.stopall)
        patch.object(module, 'HOME', self.home).start()
        patch.object(module, 'SITE_ROOT', self.target, create=True).start()

    def save_plan(self):
        (self.home / 'plan.json').write_text(json.dumps(self.plan))

    def test_publish_is_outside_official_output_and_survives_rebuild(self):
        module.publish()
        self.assertEqual((self.target / 'current/index.html').read_text(), 'fixture Mobile')
        self.assertEqual((self.official / 'index.html').read_text(), 'official dashboard')
        import shutil
        shutil.rmtree(self.official)
        self.official.mkdir()
        self.assertEqual((self.target / 'current/index.html').read_text(), 'fixture Mobile')

    def test_first_install_rollback_removes_only_current_and_keeps_release(self):
        module.publish()
        module.rollback()
        self.assertFalse(os.path.lexists(self.target / 'current'))
        self.assertTrue((self.target / 'releases' / self.plan['release']).is_dir())
        self.assertTrue((self.target / 'dashboard/plugin_api.py').is_file())

    def test_update_rollback_restores_previous_mobile(self):
        module.publish()
        self.plan.update(previous_release=self.plan['release'], previous_manifest=self.plan['manifest'])
        (self.home / 'artifact/index.html').write_text('fixture next Mobile')
        manifest = module.inventory(self.home / 'artifact')
        bundle = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
        self.plan.update(release='v5-' + bundle[:16], manifest=manifest, bundle_sha256=bundle)
        self.save_plan()
        module.publish()
        self.assertEqual((self.target / 'current/index.html').read_text(), 'fixture next Mobile')
        module.rollback()
        self.assertEqual((self.target / 'current/index.html').read_text(), 'fixture Mobile')

    def test_foreign_pointer_prevents_rollback(self):
        module.publish()
        (self.target / 'current').unlink()
        (self.target / 'current').symlink_to(self.official)
        with self.assertRaises(RuntimeError):
            module.rollback()
        self.assertEqual((self.target / 'current').resolve(), self.official)

    def test_artifact_drift_never_creates_live_entry(self):
        (self.home / 'artifact/index.html').write_text('unapproved payload')
        with self.assertRaises(RuntimeError):
            module.publish()
        self.assertFalse(self.target.exists())

    def test_native_python_cache_does_not_prevent_rollback(self):
        module.publish()
        import py_compile
        py_compile.compile(str(self.target / 'dashboard/plugin_api.py'), doraise=True)
        module.rollback()
        self.assertFalse(os.path.lexists(self.target / 'current'))

    def test_foreign_plugin_code_prevents_update(self):
        module.publish()
        (self.target / 'dashboard/plugin_api.py').write_text('foreign edit')
        with self.assertRaises(RuntimeError):
            module.rollback()
        self.assertTrue((self.target / 'current').is_symlink())


if __name__ == '__main__':
    unittest.main()
