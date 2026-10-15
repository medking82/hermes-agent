# Hermes Web — isolated mobile frontend

This is a **development candidate**, not a deployed/fully accepted mobile product.
Base: Hermes `297552a9d646119871391d202509822cd86330df` in a separate detached worktree.
The live Hermes checkout, Desktop app, credentials, model/provider/effort, service configuration and public routes are unchanged.

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
- Conversation history, full-text search and incremental listing. Project selector filters **loaded** rows by their existing repo/cwd; load earlier rows to widen it. Default profile only in this iteration.
- Markdown, code blocks, collapsible tool activity, copy, explicit stop and queue-on-busy. Image sending is explicitly disabled in this iteration; the dashboard's submit contract does not accept canonical attachment payloads.
- Enter is newline; Cmd/Ctrl+Enter sends. Composition state and keyCode 229 guard candidate-confirmation events. Explicit click still respects active composition.
- Per-profile/durable-session local drafts, visible-viewport keyboard geometry, safe areas, system text selection/zoom and reduced motion.
- Auth expiry, reconnect limit/backoff, fresh ticket per reconnect, server snapshot recovery on return to foreground; never automatically resend an ambiguous prompt. Disconnection never interrupts the backend task.
- Optimistic user bubbles are marked pending; unknown delivery is disclosed, never reported as successful delivery.

## Local visual settings

Appearance is grouped into Theme/language, Typography, and Glass/backdrop tabs, matching Desktop's separation of concerns without presenting unsupported native settings. Phone-sized windows use a near-full-height sheet; larger windows use a capped dialog. The header, section navigation and footer remain outside the scrolling body, so Done/reset/close stay reachable even at 175% text size and in short landscape layouts.

Theme choices use Desktop's selectable-card emphasis and current light/dark palettes with four real swatches per theme. The font picker reuses Desktop's Select/portal primitives and family resolver, renders option glyph samples, and includes the official localized sample sentence. Unavailable device fonts fall back; a CSS family name is not proof the face is installed. No font downloads are added. Browser-local UI text and chat text presets (90/100/110/125/150/175%) are independent, including assistant text, code and tables. These are text sizes, not Electron window zoom or a browser zoom override; existing Web defaults remain 100%.

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
WEBKIT_TEST_EXECUTABLE=/home/marck/.hermes/cache/scratch/hermes-webkit-libs/launch-webkit.sh \
LD_LIBRARY_PATH=/home/marck/.hermes/cache/scratch/hermes-webkit-libs/unpacked/usr/lib/x86_64-linux-gnu \
../../node_modules/.bin/playwright test --config playwright.mobile.config.ts
```

That scratch launcher is temporary, not a permanent application dependency.

Browser fixture responses are conspicuously labelled **测试夹具**. They are synthetic protocol/UI tests, not real model output. The unauthenticated test uses the real backend and checks that sign-in is still required. Screenshots are in ignored `mobile/test-results/`.

## Remaining acceptance / scope limits

- This candidate targets the dashboard **sidecar** contract, not the canonical private native-gateway protocol. It refuses a socket advertising `session_authority: true` instead of relabelling GUI execution as CLI, emulating native credentials or silently dropping fields on retry. Canonical live-session continuity is therefore a known incomplete requirement, not a verified feature. The legacy submit has no idempotency field; the client deliberately never auto-retries it.

- The existing authenticated browser has loaded the real session list and connected status. The deployed v5 was then found to omit public sidecar text and cross-process saved updates; this fix restores only public output/projections and checks saved history while visible. It is not a cross-process live token mirror. Real model submission and physical-device acceptance remain unverified. Preview actions must respect foreground-session ownership; no credentials are copied and no auth bypass is added.
- iPhone/iPad physical keyboard/IME, touch inertia, actual software keyboard, Safari toolbar/standalone mode and sleep/network transitions need real devices. Linux WebKit is additional engine coverage, not iOS hardware validation.
- Complex/multi-question confirmation cards explicitly defer to Desktop. No auto-approval or permanent allowance is introduced. Native Electron window management, OS file browser, embedded webview and native notifications are not emulated.
- The mobile site is deployed as an attended sidecar trial; this fix candidate and Neo default-entry change still require review and live cutover. It does not include a model-switch UI, multi-profile navigation, full Desktop artifact/media handling, offline cache or push notifications. PWA installation is not physically verified.
- Initial JS is currently a substantial shared-package bundle; no measured iOS performance claim is made. A successful production build is not a performance benchmark.

## Rollback

Stopping the isolated preview only stops local testing; it does not roll back the deployed site. Production rollback uses the release-specific `maintenance/neo-mobile-fix/deploy/publish.py rollback` on GA401 and `ingress.py rollback` from its verified VPS staging directory. The publisher restores only the pinned prior mobile release; ingress removes only this root redirect while retaining the existing mobile routes. Both refuse foreign drift. Retain the exact reviewed plan/scripts/artifact and their hashes; do not apply a different release's rollback. These test commands do not commit, push or deploy.
