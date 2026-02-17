(function bootstrapGameCapture() {
  const INJECTED_EVENT = "sap-live-play";
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/inject/network-hook.js");
  script.dataset.eventName = INJECTED_EVENT;
  script.async = false;

  script.onload = () => script.remove();
  (document.documentElement || document.head || document.body).appendChild(script);

  window.addEventListener(INJECTED_EVENT, (event) => {
    const payload = event?.detail ?? null;
    if (!payload) {
      return;
    }

    chrome.runtime.sendMessage({
      type: "SAP_GAME_STATE_UPDATE",
      state: payload,
      context: {
        href: location.href,
        isTop: window === window.top
      }
    });
  });
})();
