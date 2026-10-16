"use strict";
(() => {
  // mobile/public/dashboard-link.js
  function registerMobileNavigation(sdk, registry) {
    if (typeof sdk?.React?.createElement !== "function" || typeof registry?.registerSlot !== "function") return false;
    const createElement = sdk.React.createElement;
    function MobileChatLink() {
      const profile = new URLSearchParams(globalThis.window.location.search).get("profile") || globalThis.window.__HERMES_INITIAL_PROFILE__ || "default";
      if (profile !== "default") return null;
      const label = globalThis.document.documentElement.lang.startsWith("zh") ? "\u8FD4\u56DE\u624B\u673A\u804A\u5929" : "Back To Mobile Chat";
      return createElement(
        "nav",
        {
          "aria-label": "Mobile Chat Navigation",
          style: { display: "flex", justifyContent: "flex-end", padding: "6px 16px", flexShrink: 0 }
        },
        createElement(
          "a",
          {
            href: "/mobile/",
            style: {
              display: "inline-flex",
              alignItems: "center",
              minHeight: "44px",
              maxWidth: "100%",
              padding: "0 12px",
              border: "1px solid currentColor",
              borderRadius: "10px",
              color: "inherit",
              font: "inherit",
              textDecoration: "none",
              overflowWrap: "anywhere"
            }
          },
          label
        )
      );
    }
    registry.registerSlot("neo-mobile-web", "header-banner", MobileChatLink);
    registry.register?.("neo-mobile-web", () => null);
    return true;
  }
  if (typeof globalThis.window !== "undefined") {
    registerMobileNavigation(globalThis.window.__HERMES_PLUGIN_SDK__, globalThis.window.__HERMES_PLUGINS__);
  }
})();
