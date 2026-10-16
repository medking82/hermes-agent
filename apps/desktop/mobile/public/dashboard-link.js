// Static Dashboard navigation bridge; no backend, auth, API or agent actions.
// Loaded only by the explicitly deployed Dashboard HTML hook, not by Mobile.
export function registerMobileNavigation(sdk, registry) {
  if (typeof sdk?.React?.createElement !== 'function' || typeof registry?.registerSlot !== 'function') return false
  const createElement = sdk.React.createElement
  function MobileChatLink() {
    // Mobile currently owns only default. Do not silently switch another profile.
    const profile =
      new URLSearchParams(globalThis.window.location.search).get('profile') ||
      globalThis.window.__HERMES_INITIAL_PROFILE__ ||
      'default'
    if (profile !== 'default') return null
    const label = globalThis.document.documentElement.lang.startsWith('zh') ? '返回手机聊天' : 'Back To Mobile Chat'
    return createElement(
      'nav',
      {
        'aria-label': 'Mobile Chat Navigation',
        style: { display: 'flex', justifyContent: 'flex-end', padding: '6px 16px', flexShrink: 0 }
      },
      createElement(
        'a',
        {
          href: '/mobile/',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: '44px',
            maxWidth: '100%',
            padding: '0 12px',
            border: '1px solid currentColor',
            borderRadius: '10px',
            color: 'inherit',
            font: 'inherit',
            textDecoration: 'none',
            overflowWrap: 'anywhere'
          }
        },
        label
      )
    )
  }
  registry.registerSlot('neo-mobile-navigation', 'header-banner', MobileChatLink)
  return true
}

// DOMContentLoaded waits for the existing Dashboard module to expose its SDK.
// No retries, credential lookup, DOM takeover or simulated Electron bridge.
if (typeof globalThis.window !== 'undefined') {
  const boot = () =>
    registerMobileNavigation(globalThis.window.__HERMES_PLUGIN_SDK__, globalThis.window.__HERMES_PLUGINS__)
  if (globalThis.document.readyState === 'complete') boot()
  else globalThis.document.addEventListener('DOMContentLoaded', boot, { once: true })
}
