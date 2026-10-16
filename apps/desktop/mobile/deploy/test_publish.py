import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('photo_publish', Path(__file__).with_name('publish.py'))
assert SPEC is not None and SPEC.loader is not None
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class CombinedStaticPublish(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/home/marck/.hermes/cache/scratch')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.home = root / 'stage'
        self.web = root / 'web'
        self.home.mkdir()
        self.web.mkdir()
        self.before = b'<html><head></head><body>fixture dashboard</body></html>'
        self.after = self.before.replace(b'</head>', b'<script type="module" src="/mobile/dashboard-link.js"></script></head>')
        (self.web / 'index.html').write_bytes(self.before)
        (self.home / 'dashboard-before.html').write_bytes(self.before)
        (self.home / 'dashboard-after.html').write_bytes(self.after)
        artifact = self.home / 'artifact'
        artifact.mkdir()
        (artifact / 'index.html').write_text('fixture mobile')
        (artifact / 'dashboard-link.js').write_text('// fixture static link')
        manifest = module.inventory(artifact)
        previous = self.web / 'mobile-releases' / 'fixture-previous'
        previous.mkdir(parents=True)
        (previous / 'index.html').write_text('fixture previous mobile')
        old_manifest = module.inventory(previous)
        self.old_bundle = hashlib.sha256(json.dumps(old_manifest, sort_keys=True).encode()).hexdigest()
        self.old_release = 'v5-' + self.old_bundle[:16]
        self.new_bundle = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
        self.new_release = 'v5-' + self.new_bundle[:16]
        previous = previous.rename(previous.parent / self.old_release)
        (previous / 'release.json').write_text(json.dumps({'release': self.old_release, 'bundle_sha256': self.old_bundle}))
        (self.web / 'mobile').symlink_to('mobile-releases/' + self.old_release)
        self.plan = {'domain': 'neo.hankee.com', 'web_dist': str(self.web), 'release': 'fixture-next', 'bundle_sha256': hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest(), 'manifest': manifest, 'artifact_files': len(manifest), 'source_commit': 'fixture-source', 'dashboard_index_sha256': hashlib.sha256(self.before).hexdigest(), 'previous_release': 'fixture-previous', 'previous_bundle_sha256': 'fixture-previous-bundle', 'previous_manifest': old_manifest, 'dashboard_navigation': {'before_sha256': hashlib.sha256(self.before).hexdigest(), 'after_sha256': hashlib.sha256(self.after).hexdigest()}}
        self.plan.update(release=self.new_release, previous_release=self.old_release, previous_bundle_sha256=self.old_bundle)
        (self.home / 'plan.json').write_text(json.dumps(self.plan))
        self.addCleanup(patch.stopall)
        patch.object(module, 'HOME', self.home).start()
        patch.object(module, 'WEB_DIST', self.web).start()

    def test_publish_adds_only_frozen_dashboard_hook_after_mobile(self):
        module.publish()
        self.assertEqual((self.web / 'index.html').read_bytes(), self.after)
        self.assertEqual((self.web / 'mobile').resolve().name, self.new_release)

    def test_rollback_restores_both_original_entries(self):
        module.publish()
        module.rollback()
        self.assertEqual((self.web / 'index.html').read_bytes(), self.before)
        self.assertEqual((self.web / 'mobile').resolve().name, self.old_release)

    def test_failed_index_write_restores_previous_mobile(self):
        with patch.object(module, 'apply_dashboard', side_effect=OSError('fixture denied'), create=True):
            with self.assertRaises(OSError):
                module.publish()
        self.assertEqual((self.web / 'index.html').read_bytes(), self.before)
        self.assertEqual((self.web / 'mobile').resolve().name, self.old_release)

    def test_foreign_dashboard_change_prevents_rollback(self):
        module.publish()
        (self.web / 'index.html').write_text('fixture foreign edit')
        with self.assertRaises(RuntimeError):
            module.rollback()
        self.assertEqual((self.web / 'mobile').resolve().name, self.new_release)
        self.assertEqual((self.web / 'index.html').read_text(), 'fixture foreign edit')


if __name__ == '__main__':
    unittest.main()
