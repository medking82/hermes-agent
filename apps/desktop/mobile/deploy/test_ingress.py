import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('mobile_ingress', Path(__file__).with_name('ingress.py'))
assert SPEC is not None and SPEC.loader is not None
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class IngressBoundary(unittest.TestCase):
    def test_only_neo_mobile_static_prefix_changes(self):
        before = ('server_name neo.hankee.com;\n' + module.OLD_MOBILE +
                  '        location / { proxy_pass http://original; }\n' +
                  'server_name ai.hankee.com; # unchanged\n' +
                  'server_name hub.hankee.com; # unchanged\n').encode()
        after = module.mobile_candidate(before)
        self.assertEqual(after.replace(module.NEW_MOBILE.encode(), module.OLD_MOBILE.encode()), before)
        self.assertIn(b'/api/plugins/neo-mobile-web/site/', after)
        self.assertIn(b'proxy_intercept_errors on;', after)
        self.assertIn(b'error_page 401 =302 https://neo.hankee.com/login?next=/mobile/;', after)
        self.assertNotIn(b'proxy_set_header Authorization', after)
        with self.assertRaises(RuntimeError):
            module.mobile_candidate(after)
        with self.assertRaises(RuntimeError):
            module.mobile_candidate(before + module.OLD_MOBILE.encode())

    def test_docker_checks_and_switch_are_bounded(self):
        import json
        import tempfile
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            live = home / 'live.conf'
            before = module.OLD_MOBILE.encode()
            after = module.mobile_candidate(before)
            live.write_bytes(before)
            (home / 'nginx.baseline.conf').write_bytes(before)
            (home / 'nginx.candidate.conf').write_bytes(after)
            (home / 'plan.json').write_text(json.dumps({
                'domain': 'neo.hankee.com',
                'nginx_before_sha256': module.sha(before),
                'nginx_after_sha256': module.sha(after),
            }))
            info = {'Mounts': [{'Destination': '/etc/nginx/nginx.conf', 'Source': str(live)}],
                    'Config': {'User': ''}, 'Image': 'fixture-image'}
            commands = []
            def bounded(command, **kwargs):
                self.assertGreater(kwargs.get('timeout', 0), 0, command)
                self.assertLessEqual(kwargs['timeout'], 60)
                commands.append(command)
                return json.dumps([info]).encode() if command[1] == 'inspect' else live.read_bytes()
            with patch.object(module, 'HOME', home), patch.object(module, 'LIVE', live), \
                    patch.object(module.subprocess, 'check_output', bounded), \
                    patch.object(module.subprocess, 'run', bounded):
                module.check()
                module.switch()
                self.assertEqual(live.read_bytes(), after)
                module.switch(True)
                self.assertEqual(live.read_bytes(), before)
            self.assertTrue(any(command[1] == 'run' for command in commands))


if __name__ == '__main__':
    unittest.main()
