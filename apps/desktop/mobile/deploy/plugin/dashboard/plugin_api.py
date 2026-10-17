"""Mobile static files and narrow native security controls.

The official host owns authentication and the enabled-plugin gate. The relay
only discovers verified original owners and answers their existing requests;
it never starts work, rebinds sessions or implements its own request resolver.
"""
import asyncio
import json
import logging
import os
from pathlib import Path
import re
import uuid


def read_owners(home: Path):
    """Read this profile's registry without its pruning/write-back snapshot API."""
    import psutil
    from hermes_cli.active_sessions import _read_entries, _pid_liveness

    path = home / 'runtime/active_sessions.json'
    if not path.exists():
        return []
    info = path.lstat()
    if path.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise RuntimeError('Untrusted owner registry')
    owners = []
    for entry in _read_entries(path, strict=True):
        pid, start = entry.get('pid'), entry.get('process_start_time')
        live_id = entry.get('metadata', {}).get('live_session_id')
        if not start or not isinstance(live_id, str) or not live_id:
            continue
        if _pid_liveness(pid, start) is not True:
            continue
        try:
            process = psutil.Process(int(pid))
            if process.uids().real != os.getuid() or abs(process.create_time() - float(start)) >= 0.001:
                continue
            ports = sorted({c.laddr.port for c in process.net_connections(kind='tcp')
                            if c.status == psutil.CONN_LISTEN and c.laddr.ip == '127.0.0.1'})
        except (psutil.Error, OSError, ValueError):
            continue
        if ports:
            owners.append({'entry': entry, 'ports': ports})
    return owners



class NativePeer:
    """Only a registry-pinned loopback process, never a browser-supplied URL."""

    def __init__(self, home, entry, port):
        self.home, self.entry, self.port = home, entry, port
        self.socket = None
        self.counter = 0

    async def check_owner(self):
        owners = await asyncio.to_thread(read_owners, self.home)
        matches = [o for o in owners if o['entry']['session_id'] == self.entry['session_id']]
        def identity(entry):
            return tuple(entry.get(k) for k in ('session_id', 'lease_id', 'pid', 'process_start_time', 'surface')) + (
                entry.get('metadata', {}).get('live_session_id'),)
        if (len(matches) != 1 or identity(matches[0]['entry']) != identity(self.entry)
                or self.port not in matches[0]['ports']):
            raise RuntimeError('Original owner changed')

    async def connect(self, *, client=None, connector=None):
        import httpx
        from urllib.parse import urlencode
        from websockets.asyncio.client import connect

        await self.check_owner()
        origin = f'http://127.0.0.1:{self.port}'
        own_client = client is None
        if own_client:
            client = httpx.AsyncClient(timeout=5, trust_env=False, follow_redirects=False)
        try:
            page = await client.get(origin + '/')
            page.raise_for_status()
            match = re.search(r'__HERMES_SESSION_TOKEN__\s*=\s*("(?:[^"\\]|\\.)*")', page.text)
            if not match:
                raise RuntimeError('Native private connection unavailable')
            credential = json.loads(match.group(1))
            identity = await client.get(origin + '/api/host/identity', headers={
                'X-Hermes-Session-Token': credential,
            })
            identity.raise_for_status()
            ident = identity.json()
            if ident.get('pid') != self.entry['pid'] or ident.get('role') != 'desktop-serve':
                raise RuntimeError('Native identity mismatch')
            await self.check_owner()
            # Never let optional library wire-debug logging record response values.
            quiet = logging.Logger('mobile-native-security', level=logging.CRITICAL + 1)
            quiet.propagate = False
            self.socket = await (connector or connect)(
                origin.replace('http:', 'ws:', 1) + '/api/ws?' + urlencode({'token': credential}),
                origin=origin, open_timeout=5, close_timeout=2, max_size=1048576,
                logger=quiet, proxy=None,
            )
        finally:
            if own_client:
                await client.aclose()

    async def rpc(self, method, params):
        if method not in ('session.active_list', 'session.events.since', 'request.answer') or self.socket is None:
            raise RuntimeError('Native method unavailable')
        self.counter += 1
        rid = f'mobile-security-{self.counter}'
        async with asyncio.timeout(8):
            await self.socket.send(json.dumps({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params}))
            while True:
                frame = json.loads(await self.socket.recv())
                if frame.get('id') == rid:
                    if 'error' in frame or not isinstance(frame.get('result'), dict):
                        raise RuntimeError('Native security protocol unavailable')
                    return frame['result']

    async def check(self):
        await self.check_owner()
        result = await self.rpc('session.active_list', {})
        live_id = self.entry['metadata']['live_session_id']
        matches = [r for r in result.get('sessions', []) if r.get('session_key') == self.entry['session_id']]
        if len(matches) != 1 or matches[0].get('id') != live_id:
            raise RuntimeError('Original session changed')

    async def close(self):
        if self.socket is not None:
            await self.socket.close()
            self.socket = None


class SecurityChannel:
    """A single viewer, bound to one original owner; the native resolver arbitrates races."""

    def __init__(self, peer, session_key: str, runtime_id: str, backend_id: str):
        self.peer = peer
        self.session_key, self.runtime_id, self.backend_id = session_key, runtime_id, backend_id
        self.generation = uuid.uuid4().hex
        self.epoch = None
        self.pending = {}
        self.attempted = set()
        self.lock = asyncio.Lock()

    async def snapshot(self):
        await self.peer.check()
        data = await self.peer.rpc('session.events.since', {
            'session_id': self.runtime_id, 'last_seen': 9007199254740991,
        })
        epoch = data.get('epoch')
        if not isinstance(epoch, str) or not epoch or (self.epoch and self.epoch != epoch):
            raise RuntimeError('Native connection changed')
        self.epoch = epoch
        requests = []
        for row in data.get('open_requests', []):
            params = row.get('params', {})
            if (row.get('method') not in ('approval', 'sudo')
                    or params.get('session_id') != self.runtime_id
                    or not isinstance(row.get('id'), str)
                    or row['id'] in self.attempted):
                continue
            # Only the native security card contract crosses this channel, never history or secrets.
            requests.append({'id': row['id'], 'method': row['method'], 'params': {
                key: params[key] for key in ('session_id', 'command', 'description', 'choices') if key in params
            }})
        self.pending = {row['id']: row for row in requests}
        return {'generation': self.generation, 'backend': self.backend_id, 'profile': 'default',
                'session_key': self.session_key, 'runtime_id': self.runtime_id, 'requests': requests}

    async def answer(self, message):
        async with self.lock:
            rid = message.get('id')
            if (message.get('generation') != self.generation or not isinstance(rid, str)
                    or rid not in self.pending or rid in self.attempted):
                return {'id': rid if isinstance(rid, str) else '', 'status': 'expired'}
            original = self.pending[rid]
            await self.snapshot()
            if self.pending.get(rid) != original:
                return {'id': rid, 'status': 'expired'}
            result = message.get('result')
            params = original['params']
            command = params.get('command')
            if not isinstance(result, dict):
                raise ValueError('Invalid security response')
            if original['method'] == 'approval':
                if set(result) != {'choice'} or result['choice'] not in ('once', 'deny'):
                    raise ValueError('Invalid approval response')
                if result['choice'] == 'once' and (not isinstance(command, str) or not command.strip()
                        or 'once' not in params.get('choices', ['once', 'deny'])):
                    raise ValueError('One-time approval unavailable')
            elif (set(result) != {'value'} or not isinstance(result['value'], str)
                  or len(result['value']) > 4096
                  or (result['value'] and (not isinstance(command, str) or not command.strip()))):
                raise ValueError('Invalid sudo response')
            self.attempted.add(rid)  # Before I/O: a missing ACK never authorizes a resend.
            self.pending.pop(rid, None)
            reply = await self.peer.rpc('request.answer', {'id': rid, 'result': result})
            return {'id': rid, 'status': 'ok' if reply.get('status') == 'ok' else 'expired'}

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse

router = APIRouter()
_PLUGIN = Path(__file__).resolve().parent.parent
_TYPES = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
}


def _security_home():
    from hermes_constants import get_hermes_home, profile_name_for_home
    home = get_hermes_home()
    if profile_name_for_home(home) != 'default':
        raise RuntimeError('Unsupported profile')
    return home


def _plugin_enabled():
    from hermes_cli.plugins_cmd import _get_disabled_set, _get_enabled_set
    return 'neo-mobile-web' in _get_enabled_set() and 'neo-mobile-web' not in _get_disabled_set()


async def _security_admit(ws):
    from hermes_cli.web_routers.chat_ws import _close_unless_sidecar_allowed
    if ws.query_params.get('profile') not in (None, 'default') or not _plugin_enabled():
        await ws.close(code=4403)
        return False
    # Native gate validates identity, Host, Origin and allowed client. Only TLS (or the
    # existing isolated loopback test context) may display a password prompt.
    if ws.url.scheme != 'wss' and ws.url.hostname not in ('127.0.0.1', 'localhost', '::1'):
        await ws.close(code=4403)
        return False
    return await _close_unless_sidecar_allowed(ws)


async def _open_peer(home, session_key):
    owners = await asyncio.to_thread(read_owners, home)
    matches = [o for o in owners if o['entry']['session_id'] == session_key]
    if len(matches) != 1:
        raise RuntimeError('Original owner unavailable')
    owner = matches[0]
    for port in owner['ports']:
        peer = NativePeer(home, owner['entry'], port)
        try:
            await peer.connect()
            await peer.check()
            return peer
        except Exception:  # health: allow BLE001 -- a failed candidate never receives an answer
            await peer.close()
    raise RuntimeError('Verified native connection unavailable')


@router.get('/security/sessions')
async def security_sessions(profile: str | None = None):
    if profile not in (None, 'default') or not _plugin_enabled():
        raise HTTPException(404, 'Security controls unavailable')
    try:
        home = _security_home()
        owners = await asyncio.to_thread(read_owners, home)
        titles = {}
        db_path = home / 'state.db'
        if db_path.is_file():
            import sqlite3
            with sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True, timeout=2) as db:
                for owner in owners:
                    key = owner['entry']['session_id']
                    row = db.execute('SELECT title FROM sessions WHERE id=?', (key,)).fetchone()
                    if row:
                        titles[key] = row[0]
        rows = [{'session_key': o['entry']['session_id'],
                 'title': titles.get(o['entry']['session_id']) or o['entry']['session_id']}
                for o in owners]
        return JSONResponse({'sessions': rows}, headers={'Cache-Control': 'no-store'})
    except Exception:  # health: allow BLE001 -- fail closed; no registry or exception contents sent to the browser
        raise HTTPException(503, 'Verified native owners unavailable') from None


@router.websocket('/security/ws')
async def security_ws(ws: WebSocket):
    if not await _security_admit(ws):
        return
    await ws.accept(subprotocol=getattr(ws, '_hermes_ws_subprotocol', None))
    peer = None
    try:
        initial = json.loads(await asyncio.wait_for(ws.receive_text(), 10))
        if (not isinstance(initial, dict) or set(initial) != {'session_key'}
                or not isinstance(initial['session_key'], str) or len(initial['session_key']) > 128):
            raise ValueError('Invalid selection')
        peer = await _open_peer(_security_home(), initial['session_key'])
        entry = peer.entry
        import socket
        backend = f"{socket.gethostname()} / Desktop / {entry['pid']}:{entry['process_start_time']}"
        channel = SecurityChannel(peer, initial['session_key'], entry['metadata']['live_session_id'], backend)
        while _plugin_enabled():
            await ws.send_json({'type': 'snapshot', **await channel.snapshot()})
            try:
                raw = await asyncio.wait_for(ws.receive_text(), 1)
            except TimeoutError:
                continue
            if len(raw) > 16384:
                raise ValueError('Response too large')
            message = json.loads(raw)
            raw = None
            if not isinstance(message, dict) or set(message) != {'generation', 'id', 'result'}:
                raise ValueError('Invalid response')
            reply = await channel.answer(message)
            message = None
            await ws.send_json({'type': 'answer', **reply})
    except WebSocketDisconnect:
        return
    except Exception:  # health: allow BLE001 -- never serialize exceptions or sensitive response frames
        try:
            await ws.send_json({'type': 'unavailable'})
        except Exception:  # health: allow BLE001 -- socket may already be gone; no response data is logged
            return
    finally:
        if peer is not None:
            await peer.close()
        try:
            await ws.close(code=1000)
        except RuntimeError:  # the browser may already have closed; never answer/cancel on its behalf
            pass


@router.get('/site/{file_path:path}')
def serve_site(file_path: str, profile: str | None = None):
    if profile not in (None, 'default'):
        raise HTTPException(404, 'Mobile supports only the default profile')
    releases = _PLUGIN / 'releases'
    current = _PLUGIN / 'current'
    # A misplaced release pointer must never expose a different local tree.
    root = current.resolve()
    if (releases.is_symlink() or not current.is_symlink()
            or root.parent != releases or not re.fullmatch(r'v5-[0-9a-f]{16}', root.name)):
        raise HTTPException(404, 'Mobile release unavailable')
    relative = Path(file_path)
    if (not file_path or relative.is_absolute() or '\\' in file_path
            or any(part.startswith('.') for part in relative.parts)):
        raise HTTPException(404, 'File not found')
    target = (root / relative).resolve()
    media_type = _TYPES.get(target.suffix.lower())
    if not target.is_relative_to(root) or not media_type or not target.is_file():
        raise HTTPException(404, 'File not found')
    return FileResponse(target, media_type=media_type, headers={
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    })
