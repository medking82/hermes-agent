"""Mobile static files under the host's existing authenticated plugin API.

No model, tool, session, upload or authentication implementation lives here.
The official host owns authentication and the enabled-plugin gate.
"""
from pathlib import Path
import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter()
_PLUGIN = Path(__file__).resolve().parent.parent
_TYPES = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
}


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
