"""Exact-target Mobile publish outside the official Hermes installation.

Does not enable plugins, reload ingress, alter auth or touch official web_dist.
Retain each frozen plan for its exact rollback. Plugin code is pinned separately
from versioned static releases: changing installed code requires reconciliation.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys

HOME = Path(__file__).resolve().parent
# health: allow HX001, HX005 -- standalone one-shot publisher pins one profile per process; no gateway import or profile switching
SITE_ROOT = Path(os.environ.get('HERMES_HOME', Path.home() / '.hermes')) / 'plugins/neo-mobile-web'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(root, ignore_metadata=False):
    result = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise RuntimeError(f'Symlink in artifact: {path}')
        if path.is_file():
            relative = str(path.relative_to(root))
            if ignore_metadata and relative == 'release.json':
                continue
            result[relative] = digest(path)
    return result


def bundle_id(manifest):
    return hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()


def checked_plan():
    plan = json.loads((HOME / 'plan.json').read_text())
    if plan['domain'] != 'neo.hankee.com' or plan['site_root'] != str(SITE_ROOT):
        raise RuntimeError('Target differs from approved Neo plugin directory')
    # Refuse any symlinked ancestor, including a profile/plugin root redirected
    # into the official installation or another task's tree.
    if any(p.is_symlink() for p in (SITE_ROOT, *SITE_ROOT.parents)):
        raise RuntimeError('Plugin root must not traverse symlinks')
    bundle = bundle_id(plan['manifest'])
    if (plan['bundle_sha256'] != bundle or plan['release'] != 'v5-' + bundle[:16]
            or len(plan['manifest']) != plan['artifact_files'] or 'release.json' in plan['manifest']):
        raise RuntimeError('Artifact identity/count drift')
    for name in plan['manifest']:
        path = Path(name)
        if path.is_absolute() or any(p.startswith('.') for p in path.parts) or '\\' in name:
            raise RuntimeError('Unsafe artifact path')
    if set(plan['plugin_manifest']) != {'dashboard/manifest.json', 'dashboard/index.js', 'dashboard/plugin_api.py'}:
        raise RuntimeError('Unexpected plugin payload')
    return plan


def verify_plugin(plan):
    if (SITE_ROOT / 'dashboard').is_symlink():
        raise RuntimeError('Plugin code directory drift')
    # Native Python imports produce bytecode next to this installed router.
    actual = {'dashboard/' + k: v for k, v in inventory(SITE_ROOT / 'dashboard').items()
              if not re.fullmatch(r'__pycache__/plugin_api\.cpython-[0-9]+(?:\.opt-[0-9]+)?\.pyc', k)}
    if actual != plan['plugin_manifest']:
        raise RuntimeError('Installed plugin code differs; reconcile before changing it')


def verify_release(release, manifest):
    if not isinstance(release, str) or not re.fullmatch(r'v5-[0-9a-f]{16}', release):
        raise RuntimeError('Invalid release identity')
    if release != 'v5-' + bundle_id(manifest)[:16]:
        raise RuntimeError('Release identity drift')
    root = SITE_ROOT / 'releases'
    target = root / release
    if root.is_symlink() or target.is_symlink() or inventory(target, True) != manifest:
        raise RuntimeError('Release payload drift')
    return target


def switch_entry(expected, desired):
    current = SITE_ROOT / 'current'
    def check_current():
        if expected is None:
            if os.path.lexists(current):
                raise RuntimeError('Unexpected current entry')
        elif not current.is_symlink() or os.readlink(current) != expected:
            raise RuntimeError('Current entry drift')
    check_current()
    if desired is None:
        current.unlink()
        return
    temporary = SITE_ROOT / '.current-next'
    os.symlink(desired, temporary)  # exclusive: an interrupted switch needs inspection
    try:
        check_current()
        os.replace(temporary, current)
    finally:
        temporary.unlink(missing_ok=True)


def publish():
    plan = checked_plan()
    source = HOME / 'artifact'
    if inventory(source) != plan['manifest'] or inventory(HOME / 'plugin') != plan['plugin_manifest']:
        raise RuntimeError('Frozen payload changed')
    previous = plan.get('previous_release')
    expected = 'releases/' + previous if previous else None
    if SITE_ROOT.exists():
        verify_plugin(plan)
        if previous:
            verify_release(previous, plan['previous_manifest'])
    elif previous:
        raise RuntimeError('Previous plugin installation missing')
    else:
        SITE_ROOT.parent.mkdir(parents=True, exist_ok=True)
        # The new tree is complete before discovery can observe its manifest.
        temporary = SITE_ROOT.with_name('.neo-mobile-web-install')
        shutil.copytree(HOME / 'plugin', temporary)
        if SITE_ROOT.exists():
            raise RuntimeError('Another task installed the plugin')
        temporary.rename(SITE_ROOT)
    current = SITE_ROOT / 'current'
    if expected is None and os.path.lexists(current):
        raise RuntimeError('Unexpected existing release')
    if expected and (not current.is_symlink() or os.readlink(current) != expected):
        raise RuntimeError('Previous entry changed')
    releases = SITE_ROOT / 'releases'
    if releases.is_symlink():
        raise RuntimeError('Release root must not be a symlink')
    releases.mkdir(exist_ok=True)
    target = releases / plan['release']
    shutil.copytree(source, target)  # exclusive, no overwrite/retry on drift
    verify_release(plan['release'], plan['manifest'])
    metadata = {'release': plan['release'], 'bundle_sha256': plan['bundle_sha256'],
                'scope': 'persistent authenticated Mobile plugin, default profile'}
    (target / 'release.json').write_text(json.dumps(metadata, indent=2) + '\n')
    switch_entry(expected, 'releases/' + plan['release'])
    print(json.dumps({'published': str(current), 'release': metadata, 'files': len(plan['manifest'])}))


def rollback():
    plan = checked_plan()
    verify_plugin(plan)
    verify_release(plan['release'], plan['manifest'])
    previous = plan.get('previous_release')
    if previous:
        verify_release(previous, plan['previous_manifest'])
    switch_entry('releases/' + plan['release'], 'releases/' + previous if previous else None)
    print(json.dumps({'restored_release': previous, 'retained_release': plan['release']}))


if __name__ == '__main__':
    actions = {'publish': publish, 'rollback': rollback}
    if len(sys.argv) != 2 or sys.argv[1] not in actions:
        raise SystemExit('Usage: publish.py publish|rollback')
    import fcntl
    checked_plan()
    SITE_ROOT.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(SITE_ROOT.parent / '.neo-mobile-web-publish.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        actions[sys.argv[1]]()
