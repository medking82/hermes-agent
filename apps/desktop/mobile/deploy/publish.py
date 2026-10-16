"""One-shot, exact-target static publish. No service/config/auth changes."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys

HOME = Path(__file__).resolve().parent
WEB_DIST = Path('/home/marck/.hermes/hermes-agent/hermes_cli/web_dist')


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


def checked_plan(check_dashboard=True):
    plan = json.loads((HOME / 'plan.json').read_text())
    if plan['domain'] != 'neo.hankee.com' or plan['web_dist'] != str(WEB_DIST):
        raise RuntimeError('Target differs from approved Neo deployment')
    if not re.fullmatch(r'v5-[0-9a-f]{16}', plan['release']):
        raise RuntimeError('Invalid release identity')
    bundle = hashlib.sha256(json.dumps(plan['manifest'], sort_keys=True).encode()).hexdigest()
    if bundle != plan['bundle_sha256'] or plan['release'] != 'v5-' + bundle[:16] or len(plan['manifest']) != plan['artifact_files']:
        raise RuntimeError('Artifact identity/count drift')
    if 'release.json' in plan['manifest']:
        raise RuntimeError('Root release.json is reserved for non-sensitive build metadata')
    if check_dashboard and digest(WEB_DIST / 'index.html') != plan['dashboard_index_sha256']:
        raise RuntimeError('Original Dashboard changed; stop and reconcile')
    return plan


def verify_previous(plan):
    release = plan.get('previous_release')
    manifest = plan.get('previous_manifest')
    if not isinstance(release, str) or not re.fullmatch(r'v5-[0-9a-f]{16}', release) or not isinstance(manifest, dict):
        raise RuntimeError('Invalid previous release identity')
    bundle = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    if bundle != plan.get('previous_bundle_sha256') or release != 'v5-' + bundle[:16]:
        raise RuntimeError('Previous manifest identity drift')
    if (WEB_DIST / 'mobile-releases').is_symlink():
        raise RuntimeError('Release root must not be a symlink')
    previous = WEB_DIST / 'mobile-releases' / release
    if previous.is_symlink() or inventory(previous, ignore_metadata=True) != manifest:
        raise RuntimeError('Previous artifact is not intact')
    return previous


def switch_entry(plan, expected, desired):
    current = WEB_DIST / 'mobile'
    if not current.is_symlink() or os.readlink(current) != expected:
        raise RuntimeError('Mobile entry drift; refusing to overwrite')
    temporary = WEB_DIST / ('.mobile-' + plan['release'])
    # Lexical symlink targets are bound to verified releases below WEB_DIST.
    os.symlink(desired, temporary)
    try:
        if not current.is_symlink() or os.readlink(current) != expected:
            raise RuntimeError('Mobile entry changed during preparation')
        os.replace(temporary, current)
    finally:
        if temporary.is_symlink(): temporary.unlink()


def apply_dashboard(plan, reverse=False):
    navigation = plan.get('dashboard_navigation')
    if not navigation:
        return
    before = HOME / 'dashboard-before.html'
    after = HOME / 'dashboard-after.html'
    if digest(before) != navigation['before_sha256'] or digest(after) != navigation['after_sha256']:
        raise RuntimeError('Frozen Dashboard navigation bytes drifted')
    current = WEB_DIST / 'index.html'
    expected = navigation['after_sha256'] if reverse else navigation['before_sha256']
    desired = before if reverse else after
    if current.is_symlink() or digest(current) != expected:
        raise RuntimeError('Dashboard changed; refusing to overwrite another task')
    temporary = WEB_DIST / ('.dashboard-' + plan['release'])
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(desired.read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), stat.S_IMODE(current.stat().st_mode))
        if current.is_symlink() or digest(current) != expected:
            raise RuntimeError('Dashboard changed during preparation')
        os.replace(temporary, current)
    finally:
        temporary.unlink(missing_ok=True)
    if digest(current) != digest(desired):
        raise RuntimeError('Dashboard navigation readback mismatch')


def publish():
    plan = checked_plan()
    source = HOME / 'artifact'
    if inventory(source) != plan['manifest']:
        raise RuntimeError('Frozen artifact changed')
    current = WEB_DIST / 'mobile'
    updating = 'previous_release' in plan
    if updating:
        verify_previous(plan)
        if not current.is_symlink() or os.readlink(current) != 'mobile-releases/' + plan['previous_release']:
            raise RuntimeError('Existing entry is not the approved previous release')
    elif os.path.lexists(current):
        raise RuntimeError('Existing mobile entry; refusing to overwrite')
    releases = WEB_DIST / 'mobile-releases'
    if releases.is_symlink():
        raise RuntimeError('Release root must not be a symlink')
    releases.mkdir(exist_ok=True)
    target = releases / plan['release']
    if target.exists():
        raise RuntimeError('Release directory already exists; inspect before retry')
    shutil.copytree(source, target)
    if inventory(target) != plan['manifest']:
        raise RuntimeError('Copied bytes differ; entry has not been switched')
    metadata = {'release': plan['release'], 'bundle_sha256': plan['bundle_sha256'], 'scope': 'dashboard sidecar, default profile'}
    (target / 'release.json').write_text(json.dumps(metadata, indent=2) + '\n')
    # Keep the resolved target beneath WEB_DIST: the existing SPA traversal guard requires it.
    # First publication only: symlink creation is atomic and refuses a racing entry.
    if updating:
        switch_entry(plan, 'mobile-releases/' + plan['previous_release'], 'mobile-releases/' + plan['release'])
    else:
        os.symlink('mobile-releases/' + plan['release'], current)
    if inventory(current, ignore_metadata=True) != plan['manifest'] or current.resolve() != target.resolve():
        raise RuntimeError('Published entry readback mismatch')
    try:
        apply_dashboard(plan)
    except Exception:
        navigation = plan.get('dashboard_navigation')
        if navigation and digest(WEB_DIST / 'index.html') == navigation['after_sha256']:
            apply_dashboard(plan, reverse=True)
        if digest(WEB_DIST / 'index.html') != plan['dashboard_index_sha256']:
            raise RuntimeError('Unexpected Dashboard change; reconcile before reverting Mobile')
        if updating:
            switch_entry(plan, 'mobile-releases/' + plan['release'], 'mobile-releases/' + plan['previous_release'])
        raise
    print(json.dumps({'published': str(current), 'release': metadata, 'files': len(plan['manifest']), 'dashboard_navigation': bool(plan.get('dashboard_navigation'))}))


def rollback():
    plan = checked_plan(check_dashboard=False)
    current = WEB_DIST / 'mobile'
    expected = WEB_DIST / 'mobile-releases' / plan['release']
    if not current.is_symlink() or current.resolve() != expected.resolve():
        raise RuntimeError('Mobile entry no longer belongs to this deployment')
    if 'previous_release' in plan:
        verify_previous(plan)
        apply_dashboard(plan, reverse=True)
        switch_entry(plan, 'mobile-releases/' + plan['release'], 'mobile-releases/' + plan['previous_release'])
        print(json.dumps({'restored_release': plan['previous_release'], 'release_retained': str(expected)}))
        return
    current.unlink()
    if os.path.lexists(current):
        raise RuntimeError('Rollback readback mismatch')
    print(json.dumps({'mobile_entry_removed': True, 'release_retained': str(expected)}))


if __name__ == '__main__':
    actions = {'publish': publish, 'rollback': rollback}
    if len(sys.argv) != 2 or sys.argv[1] not in actions:
        raise SystemExit('Usage: publish.py publish|rollback')
    import fcntl
    fd = os.open(WEB_DIST / '.mobile-publish.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        actions[sys.argv[1]]()
