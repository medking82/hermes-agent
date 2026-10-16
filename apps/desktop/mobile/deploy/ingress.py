"""One-shot Neo-only ingress update; preserve bind-mounted inode and other servers."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

HOME = Path(__file__).resolve().parent
LIVE = Path('/opt/strata-relay/nginx.conf')
CONTAINER = 'strata-ai-relay'
OLD_MOBILE = ("        location = /mobile { return 302 https://neo.hankee.com/mobile/; }\n"
              "        location = /mobile/ { rewrite ^ /mobile/index.html last; }\n")
NEW_MOBILE = OLD_MOBILE + """        location /mobile/ {
            proxy_pass http://172.30.40.1:18119/api/plugins/neo-mobile-web/site/;
            proxy_http_version 1.1;
            proxy_set_header Host neo.hankee.com;
            proxy_set_header X-Forwarded-Proto https;
            proxy_set_header X-Forwarded-For $http_cf_connecting_ip;
            proxy_set_header X-Forwarded-Prefix "";
            proxy_set_header X-Forwarded-Host neo.hankee.com;
            proxy_buffering off;
            proxy_request_buffering off;
            proxy_cache off;
            gzip off;
            proxy_connect_timeout 10s;
            proxy_read_timeout 60s;
            proxy_send_timeout 60s;
            # Preserve the existing browser login flow; /api still returns 401.
            proxy_intercept_errors on;
            error_page 401 =302 https://neo.hankee.com/login?next=/mobile/;
        }
"""


def mobile_candidate(before):
    if before.count(OLD_MOBILE.encode()) != 1 or b'location /mobile/ {' in before:
        raise RuntimeError('Expected exactly one original Mobile route pair')
    return before.replace(OLD_MOBILE.encode(), NEW_MOBILE.encode())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def checked_inputs():
    plan = json.loads((HOME / 'plan.json').read_text())
    old = (HOME / 'nginx.baseline.conf').read_bytes()
    new = (HOME / 'nginx.candidate.conf').read_bytes()
    if plan['domain'] != 'neo.hankee.com' or sha(old) != plan['nginx_before_sha256'] or sha(new) != plan['nginx_after_sha256']:
        raise RuntimeError('Input identity changed')
    if mobile_candidate(old) != new:
        raise RuntimeError('Candidate is not the approved Mobile-only routing change')
    info = json.loads(subprocess.check_output(['docker','inspect',CONTAINER], timeout=30))[0]
    mounts = [m for m in info['Mounts'] if m['Destination'] == '/etc/nginx/nginx.conf']
    if len(mounts) != 1 or mounts[0]['Source'] != str(LIVE):
        raise RuntimeError('Live Nginx mount changed')
    return plan, old, new, info


def check():
    _, _, _, info = checked_inputs()
    subprocess.run(['docker','run','--rm','--pull=never','--network','none','--read-only',
        # no-tmp: ok — tmpfs inside the networkless Nginx check container, not host scratch
        '--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--user',info['Config']['User'] or '0',
        '-v',str(HOME / 'nginx.candidate.conf')+':/etc/nginx/nginx.conf:ro',
        '-v','/opt/strata-relay/tls:/tls:ro','--entrypoint','/usr/sbin/nginx',info['Image'],'-t'],check=True, timeout=30)
    print(json.dumps({'candidate_syntax':'valid','image':info['Image']}))


def switch(undo=False):
    _, old, new, _ = checked_inputs()
    expected, desired = (new, old) if undo else (old, new)
    if LIVE.read_bytes() != expected:
        raise RuntimeError('Live configuration drift; refusing to overwrite')
    # This exact file is bind-mounted. Replacing its inode would leave the container on stale bytes.
    inode = LIVE.stat().st_ino
    with LIVE.open('wb') as output:
        output.write(desired)
        output.flush()
        import os
        os.fsync(output.fileno())
    try:
        if LIVE.stat().st_ino != inode or LIVE.read_bytes() != desired:
            raise RuntimeError('Host write readback failed')
        mounted = subprocess.check_output(['docker','exec',CONTAINER,'cat','/etc/nginx/nginx.conf'], timeout=30)
        if mounted != desired:
            raise RuntimeError('Container bind readback mismatch')
        subprocess.run(['docker','exec',CONTAINER,'nginx','-t'],check=True, timeout=30)
        subprocess.run(['docker','exec',CONTAINER,'nginx','-s','reload'],check=True, timeout=30)
    except Exception:
        # Never overwrite a third-party edit during recovery.
        if LIVE.read_bytes() == desired:
            LIVE.write_bytes(expected)
            subprocess.run(['docker','exec',CONTAINER,'nginx','-t'],check=True, timeout=30)
            subprocess.run(['docker','exec',CONTAINER,'nginx','-s','reload'],check=True, timeout=30)
        raise
    if LIVE.read_bytes() != desired:
        raise RuntimeError('Post-reload readback drift')
    print(json.dumps({'mode':'rollback' if undo else 'apply','config_sha256':sha(desired),'container_recreated':False}))


if __name__ == '__main__':
    actions = {'check':check,'apply':switch,'rollback':lambda:switch(True)}
    if len(sys.argv) != 2 or sys.argv[1] not in actions:
        raise SystemExit('Usage: ingress.py check|apply|rollback')
    actions[sys.argv[1]]()
