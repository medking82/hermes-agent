# Hermes Web — isolated mobile frontend

This is a **versioned mobile sidecar trial**, not a fully accepted native iOS product. Exact deployed frontend versions and verification belong to the per-release receipt, not this source document.
Frontend: separate `feat/mobile-web-v5` worktree, based on published mobile commit `4162956700fdaf28673a8070934050471829cb9d`, with Desktop-parity projection, saved-derived pagination and native-only tool matching. The alias-fix-only independent GPT review passed; subsequent P3 fixes have primary regression-test coverage, not another model-review claim. Backend candidate: a separate worktree based on installed `d923a5eb487a17c0a68801bba9ef0f56c81040a8`; its final read-only lease implementation is **not installed by this frontend release**. Earlier lease edits remain on disk in the installation tree; maintenance may have loaded them, so do not claim they were never active. No credentials, model/provider/effort or authentication policy are changed.

## What is reused

- Desktop `HermesGateway` and its shared JSON-RPC channel/replay/heartbeat implementation.
- Desktop `Button`, media-query hook, global CSS/fonts and the actual Nous theme palettes.
- The same Streamdown package used by Desktop for Markdown.
- Existing dashboard cookie authentication and `/api/auth/ws-ticket`, `/api/ws`, session/search/image-upload APIs.

This does **not** pretend to run the entire Electron App in Safari. The mobile shell, composer and conversation projection are separate. No Electron APIs are stubbed. Agent execution remains on the existing backend.

## Run

From the repository root (isolated checkout only):

```sh
npm ci --ignore-scripts --workspace=apps/desktop --include-workspace-root=true --no-audit --no-fund
cd apps/desktop
../../node_modules/.bin/vite build --config vite.mobile.config.ts
../../node_modules/.bin/vite preview --config vite.mobile.config.ts
```

Open `http://127.0.0.1:19420/mobile/`. This is a **GA401 loopback-only** preview, not a phone-accessible public URL. Desktop may tunnel it automatically; do not interpret a successful preview-open acknowledgement as proof the PC loaded the page.

The preview proxies only to the existing authenticated dashboard at `127.0.0.1:9119`; sign in using its existing login page. Browser requests use same-origin HttpOnly cookies and freshly minted, single-use WS tickets. No provider credentials, passwords, bearer tokens or private native-gateway credentials are embedded in the bundle or stored in localStorage. Only drafts and appearance preferences are stored locally. Vite must remain loopback-only. Production publication requires separate exact-target approval, HTTPS and serving the bundle under the existing authenticated origin (or an explicitly reviewed deployment design). Do not expose Vite or change the backend bind/auth to make the demo accessible.

## Candidate capabilities

- iPhone single-column chat with accessible, focus-trapped conversation drawer and an explicitly draggable handle; iPad two-column view when available space permits, narrow/split-view drawer fallback.
- Conversation history, full-text search and incremental listing. Project, runtime-status, recorded-source and recent-activity filters combine by intersection, including during search. Filtering is explicitly limited to the loaded/result set, not an unbounded database-wide query. Default profile only in this iteration.
- Markdown, code blocks, collapsible tool activity, copy, explicit stop and queue-on-busy. Photos use the existing authenticated upload endpoint and immutable `@image:` references in the existing prompt text; no new submit parameter or backend-wide pending-attachment buffer is introduced.
- Enter is newline; Cmd/Ctrl+Enter sends. Composition state and keyCode 229 guard candidate-confirmation events. Explicit click still respects active composition.
- Per-profile/durable-session local drafts, visible-viewport keyboard geometry, safe areas, system text selection/zoom and reduced motion.
- Auth expiry, reconnect limit/backoff, fresh ticket per reconnect, server snapshot recovery on return to foreground; never automatically resend an ambiguous prompt. Disconnection never interrupts the backend task.
- Optimistic user bubbles are marked pending; unknown delivery is disclosed, never reported as successful delivery.

## Model selection

- The composer model label opens an accessible chooser on desktop and touch layouts. The catalog comes from the existing profile/session-scoped `model.options` RPC; unconfigured providers are excluded. Opening/cancelling never creates a session or sends a prompt.
- New-chat picks stay local until the existing Send action passes `model` and `provider` to `session.create`. Existing chats use `config.set` with an explicit `--session` flag; profile defaults and reasoning settings are not edited. Running/disconnected/ambiguous-send states block switching. Refusals and confirmation requirements remain visible; there is no force/takeover, automatic confirmation, or retry. Models requiring an additional backend confirmation must be selected in Desktop.
- Model changes do not clear text or uploaded-photo drafts. Photo upload, immutable image references, and existing session ownership checks remain unchanged. Browser fixture tests cover both phone and desktop layouts, not physical Safari acceptance or real inference.

## Photo upload scope

- Selecting a photo uploads it to the existing same-origin `POST /api/chat/image-upload?profile=default` endpoint. It does not create/resume a session, submit a prompt, or invoke a model/tool. The thumbnail uses a local object URL; filenames are text, not HTML. Only after the user presses Send are uploaded paths included as ordinary `@image:` references in that one message. This keeps photos out of the shared mutable next-turn attachment queue and preserves the existing model/provider selection.
- Supported types: JPEG, PNG, GIF, WebP and BMP. HEIC/HEIF and SVG are not silently accepted; the current backend rejects them, and the picker explains conversion to JPEG. Physical Safari library transcoding is not claimed. No camera permission or forced capture is requested by the page.
- The backend cap is25 MiB. The client deliberately limits each photo to20 MiB so base64 history thumbnails fit the existing32 MiB reader budget; at most4 photos and50 MiB total are admitted. Uploads are serialized, carry a60-second cancellation deadline and never automatically retry. Errors remain visible and block Send until the failed item is removed.
- Uploaded path/name/size metadata is scoped to the local profile/session draft; no photo bytes, data URLs or blob URLs enter localStorage. New-draft → newly created session adoption is limited to the same send/navigation generation. Explicit navigation cancels pending requests; late responses cannot attach to a different conversation. Unknown send ACKs retain refs and require explicit reconciliation, never automatic resubmission. A successful late ACK clears only its own submitted refs even after navigation.
- Remove cancels/drops the item from the draft and releases its preview. It does not delete an already uploaded server file or retract a message already admitted by the server. Actual image analysis/model interaction and physical iPhone/iPad acceptance remain separate and were not exercised by this implementation.
- Mobile → management Dashboard targets `/sessions?profile=default`, not terminal `/chat`. The persistent `neo-mobile-web` Dashboard plugin registers a plain same-tab `/mobile/` exit in the host's `header-banner` slot, with a44px touch target. It fails closed without a compatible SDK and hides on non-default management profiles. The native loader requires a classic IIFE; build `public/dashboard-link.js` into `deploy/plugin/dashboard/index.js`. No official Dashboard HTML/JS/CSS is patched.

## Persistent hosting (rebuild-compatible)

The deploy target is `$HERMES_HOME/plugins/neo-mobile-web/`, outside the Hermes installation:

- `dashboard/{manifest.json,index.js,plugin_api.py}`: pinned native Dashboard extension and static router.
- `releases/v5-<bundle digest>/`: immutable, manifest-verified static bundle.
- `current`: atomically switched relative symlink to that release.

The existing publisher now refuses legacy `web_dist` plans. Its frozen plan binds the source bundle, installed plugin files and exact target; a changed installed Python/JS plugin requires separate reconciliation, not a silent hot overwrite. Native Python bytecode caches are not treated as source drift. The rollback and source-only tests live in `deploy/`.

The Neo ingress maps only `/mobile/*` to `/api/plugins/neo-mobile-web/site/*` through the same backend. The native cookie gate and enabled-plugin gate remain authoritative. Unauthenticated Mobile requests return to the existing login page; API401 behavior, `/sessions`, `/api`, WebSockets and the AI/Hub virtual hosts are unchanged. Uploaded photos remain under the existing profile image directory, never inside the static release. Dot paths, traversal, symlink escapes and other profiles are rejected by the static router.

Activation explicitly enables this one default-profile plugin while preserving all pre-existing enable/disable entries. The inspected host supports first-request API hot mounting; a newly installed plugin can activate without a gateway/client restart. This does not imply already-imported Python code can be hot-reloaded. Future host/API compatibility still needs verification; this layout prevents official output-directory cleanup from deleting the Mobile payload, not arbitrary future breaking changes. No updater hook, automatic reinstaller or additional service is installed.

Build/test the native entry as well as the Mobile bundle:

```sh
../../node_modules/.bin/esbuild mobile/public/dashboard-link.js --bundle --format=iife --target=es2022 --outfile=mobile/deploy/plugin/dashboard/index.js
MOBILE_TEST_RUNTIME=/path/to/intended/hermes-checkout python3 -m unittest discover -s mobile/deploy -p 'test_*.py' -v
MOBILE_DASHBOARD_FIXTURE_ROOT=/path/to/intended/hermes-checkout/hermes_cli/web_dist ../../node_modules/.bin/playwright test --config playwright.mobile.config.ts
```

The host integration uses a temporary HOME/profile and a synthetic identity provider. Real native auth/discovery/hot mounting and image-upload code run unchanged, but no real credentials, sessions, inference or tools are invoked. The Dashboard browser regression loads the actual compiled host via its native plugin loader, not an injected HTML hook. Rebuild rehearsal replaces only an isolated official-output copy; it is not a live `hermes update` or service-restart test.

## Session filter data and scope

- Search uses the existing authenticated full-text/title/ID search endpoint with `limit=100`. That endpoint has no paging contract; reaching100 results displays a narrow-your-keywords warning. Search can include archived hits under the existing backend contract. Normal history still uses40-row saved pages and its existing archive exclusion. The shown matching/loaded count is **not** the database-wide filtered total; loading earlier pages widens the candidates. Project/source options accumulate from metadata actually returned in this mounted controller, not inferred from every backend session.
- Project uses `git_repo_root || cwd`, exact path identity. Search no longer bypasses a selected project. When project + search is selected and a hit omits project fields, use the existing same-origin authenticated session-detail GET, max4 concurrent reads and max100 hits. Superseded/disposed searches stop dispatching further reads and never commit their old rows/options. In-flight reads retain BrowserApi's existing60-second deadline. The detail endpoint can return a full session record; the projection retains only id/title/snippet/model/source/project/activity fields, never prompt/config/message bodies. No message-history request or session resume is used to discover filters. Missing/unreadable metadata displays an incomplete-project warning, never invents a path.
- Source is the persisted `source` creation-channel value. It is **not** the currently viewing client, process, model/provider, or hostname. `desktop` is labelled Desktop/Web because a browser sidecar can reuse that source; it cannot reliably split those consumers. Unexpected source strings remain their actual values; missing source has an explicit unrecorded option. No session-title or path heuristic guesses provenance.
- Running means current-connection runtime `working` only. `waiting`, `starting` and confirmed `idle` have distinct choices. Disconnect or failed active-list refresh removes positive runtime evidence; unknown never becomes idle. A verified backend-held lease stays **run status unknown**, and is never admitted to running. The lease-only choice is available only where the current response provides the optional `live_lease`; search responses from the present backend omit that annotation, so those hits remain unknown instead of inheriting an invented lease.
- Time uses a positive finite `last_active`, falling back to `started_at`/search's `session_started` only when activity metadata is absent/invalid. Today starts at browser-local midnight;7/30 days are rolling ranges ending now. Missing/future dates do not pass a restricted range. Time-filtered views update their clock each minute while mounted. These are activity filters, not message-content date searches.
- More Filters is collapsible, with native44-CSS-pixel selects, active-condition count, clear-filters action that preserves the keyword, and visible loaded-scope count. Short screens keep navigation scrollable; no filter mutation changes stored sessions or starts work. This feature is currently an isolated candidate: it does not authorize backend changes, installing the separate lease candidate, production cutover or client/service restarts.

## Local visual settings

Appearance is grouped into Theme/language, Typography, and Glass/backdrop tabs, matching Desktop's separation of concerns without presenting unsupported native settings. Phone-sized windows use a near-full-height sheet; larger windows use a capped dialog. The header, section navigation and footer remain outside the scrolling body, so Done/reset/close stay reachable even at 175% text size and in short landscape layouts.

Theme choices use Desktop's selectable-card emphasis and current light/dark palettes with four real swatches per theme. The font picker reuses Desktop's Select/portal primitives and family resolver, renders option glyph samples, and includes the official localized sample sentence. Unavailable device fonts fall back; a CSS family name is not proof the face is installed. No font downloads are added. Browser-local UI base and chat-relative presets use90/100/110/125/150/175%. UI base sizing applies once through root rem units; conversation and editor sizes derive from Desktop conversation tokens, with an additional chat-only multiplier (new defaults: UI100%, chat110%). User, assistant, code/tool output and tables share that scope; changing chat size does not resize the sidebar or header. Existing explicit saved choices, including chat100%, are preserved. Native touch input/select fields retain a16-CSS-pixel minimum while their hit targets stay44px; desktop controls no longer inherit that touch-only font floor. This is not Electron/browser window zoom or synchronization of PC-local settings.

The palette button opens browser-local appearance settings sourced from Desktop's complete `BUILTIN_THEMES` catalog. The default is the official Nous theme, not the previous forced-gold prototype. `src/themes/palette.ts` is the shared pure implementation extracted without changing Desktop's palette/light-synthesis logic; Desktop's existing theme/contrast regressions are run as well. Font stacks and installed-font choices reuse `DEFAULT_TYPOGRAPHY`, `CHAT_FONT_SUGGESTIONS` and `resolveChatFontFamily`; local JetBrains Mono faces remain bundled. Font URLs are not downloaded automatically.

Desktop and Web share the original pure `BackdropImage` renderer. Its official `public/ds-assets/filler-bg0.jpg` is converted to an optimized mobile JPEG; no private Windows wallpaper is copied. The original source asset remains unchanged. The former ad-hoc radial gradients are removed. Optional glass only reveals page content, never the OS desktop, and reduced-transparency preferences force solid surfaces.

Language selection uses Desktop's nine bundled catalogs and native language names. Chinese and English mobile-shell copy is covered; Desktop-owned common labels reuse each official locale. New Web-only explanatory copy falls back to English in other locales rather than pretending those translations are complete. Document language/direction, relative dates, RTL sidebar/drawer placement, and automatic text direction for message content/input are handled. Session titles, prompts, tool output and protocol identifiers are never translated. Settings are browser-local and do not update Windows or backend/profile configuration.

Layout regressions include unbroken URLs, long multilingual titles and 834/1024/1280 widths. Sidebar `min-width:0` is intentional: a flex-basis alone does not cap min-content width. Short synthetic titles had missed this real-data failure.

Navigation now uses a split layout only at >=1024 CSS px wide and >=540 px high; smaller/short-landscape windows use the drawer. This is based on usable browser geometry, not device names or physical resolution. A header button collapses/restores the desktop sidebar. Its grip supports pointer capture, keyboard arrows, Home/End and double-click/Enter reset. Width defaults to 292 px, is bounded by 240–420 px, 35% of viewport and reserved chat width, and is persisted only on commit. Shrinking the window clamps the visible size without overwriting the larger-window preference. Secondary fingers cannot take over a drag; cancellation restores the starting width. Touch/no-primary-pointer grips have a 44x96 px target. Presentation preferences use browser-local `hermes-web:navigation:v1`, not backend state.

Glass surface opacity is 0–100%. Backdrop strength (0–100%, original 2.5% default) and blur (0–32 px) are independent. The image now spans the page behind both columns, so sidebar glass has an actual backdrop to reveal. Text never fades with the surface. Composer and settings retain minimum tint for readability; they are deliberately not fully transparent at the lowest slider value. Strong images/clear navigation can still reduce text contrast, so appearance has a reset action and solid defaults. Reduced-transparency forces solid surfaces. On wide screens the reading container is capped at 960 px; prose paragraphs are additionally capped at 80ch while code/tables can use the container width.

## Verification

```sh
../../node_modules/.bin/vitest run --config vitest.mobile.config.ts
../../node_modules/.bin/tsc -p tsconfig.mobile.json --noEmit
../../node_modules/.bin/eslint mobile/ vite.mobile.config.ts vitest.mobile.config.ts playwright.mobile.config.ts --no-warn-ignored
../../node_modules/.bin/playwright test --config playwright.mobile.config.ts
```

Playwright projects cover desktop Chromium plus Chromium and WebKit with iPhone/iPad geometry. The responsive test visits eight CSS viewport sizes per project, from phone portrait/landscape through 3840x2160, retaining a draft and checking bounded content. Chromium mobile contexts also exercise trusted touch move/cancel and secondary-finger handling through CDP. A local Chrome path is configured for this host. Use `HEADED_LAYOUT=1 xvfb-run -a` before Playwright for the desktop project's actual fine-pointer branch; the normal headless/no-primary-pointer branch remains supported. This is not a claim of native macOS/iOS or real 4K monitor validation. Standard WebKit installs need their documented OS dependencies. During this session the missing packages were **downloaded and extracted privately**, not installed system-wide; an isolated launcher supplied the bundled WebKit paths plus extracted libraries. Session-specific invocation:

```sh
WEBKIT_TEST_EXECUTABLE=/home/marck/.hermes/workspace/maintenance/neo-mobile-fix/photo-upload/test-deps/launch-webkit.sh \
../../node_modules/.bin/playwright test --config playwright.mobile.config.ts
```

That test-only launcher is not an application dependency. The earlier scratch launcher expired; the replacement retains the same actual Playwright WebKit binary and privately extracted compatibility library without modifying system packages.

Browser fixture responses are conspicuously labelled **测试夹具**. They are synthetic protocol/UI tests, not real model output. The unauthenticated test uses the real backend and checks that sign-in is still required. Screenshots are in ignored `mobile/test-results/`.

## Remaining acceptance / scope limits

- This candidate targets the dashboard **sidecar** contract, not the canonical private native-gateway protocol. The gateway no longer advertises `session_authority` (removed in the Attention prerequisites); live sessions multi-attach viewers (`_attach_session_transport`), `session.active_list` reports real runtime status (`waiting/starting/working/idle`), and `sessions.changed` broadcasts refetch triggers — the mobile list consumes all three without emulating native credentials or silently dropping fields. Cross-process live events are NOT bridged. Desktop SSH connections can own sessions in private `hermes serve --isolated` backends; determine ownership from the actual registry/process topology, never assume `gateway run` owns PC turns. The approved cross-process addition is only a boolean `live_lease` on saved session rows, projected from the selected profile registry after process-liveness verification. It neither exposes private tickets/content nor proves a model turn is running or which client owns it. The optional field is absent on older backends and is not inferred. Lease-only rows use a static outline and explicitly unknown execution status; animated working/waiting states require runtime events from this process. Cross-process content remains saved-state sync, not token streaming. The candidate snapshot read does not create locks/directories, prune, or rewrite the registry; corrupt/unprovable snapshots yield no markers. The legacy submit has no idempotency field; the client deliberately never auto-retries it.

- The existing authenticated browser has loaded the real session list and connected status. The deployed v5 was then found to omit public sidecar text and cross-process saved updates; this fix restores only public output/projections and checks saved history while visible. It is not a cross-process live token mirror. Real model submission and physical-device acceptance remain unverified. Preview actions must respect foreground-session ownership; no credentials are copied and no auth bypass is added.
- iPhone/iPad physical keyboard/IME, touch inertia, actual software keyboard, Safari toolbar/standalone mode and sleep/network transitions need real devices. Linux WebKit is additional engine coverage, not iOS hardware validation.
- Complex/multi-question confirmation cards explicitly defer to Desktop. No auto-approval or permanent allowance is introduced. Native Electron window management, OS file browser, embedded webview and native notifications are not emulated.
- The mobile site and Neo default-entry redirect are an attended sidecar trial. Frontend review/tests/publication are tracked in the exact release receipt; the isolated read-only backend lease candidate still requires its own separately authorized installation and live acceptance. This frontend cutover does not restart or replace that backend. It does not include multi-profile navigation, full Desktop artifact/media handling, offline cache or push notifications. PWA installation is not physically verified.
- Initial JS is currently a substantial shared-package bundle; no measured iOS performance claim is made. A successful production build is not a performance benchmark.

## Rollback

Stopping the isolated preview only stops local testing; it does not roll back the deployed site. Production rollback uses the exact release-specific `publish.py rollback` on GA401 and `ingress.py rollback` in its verified VPS staging directory. The persistent publisher restores the pinned prior `current` symlink (or removes the first installation's entry), retains releases and never touches official Dashboard output. The ingress rollback restores the exact prior configuration, including its root redirect; it does not restore a missing legacy mobile bundle. Restore the original `plugins.enabled` list with `hermes config set` only if it still matches this release's expected value. All steps refuse foreign drift; disable/remove-current is a bounded withdrawal, not a claim that the broken pre-migration site becomes healthy. Retain the exact reviewed plan/scripts/artifact and their hashes; do not apply a different release's rollback. These test commands do not commit, push or deploy.
