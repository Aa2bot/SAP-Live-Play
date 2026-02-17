(function bootstrapArenaWatchCapture() {
  const INJECTED_EVENT = "sap-live-play";
  const REFRESH_MS = 1500;
  const ARENA_WATCH_API_URL = "https://api.teamwood.games/0.45/api/arena/watch";
  const VERSUS_WATCH_API_URL = "https://api.teamwood.games/0.45/api/versus/watch";

  let hookInstalled = false;
  let connected = false;
  let captureCount = 0;
  let arenaPostCount = 0;
  let arenaResponseCount = 0;
  let versusPostCount = 0;
  let versusResponseCount = 0;
  let latestWatchEntry = null;

  const SHOULD_RENDER_PANEL =
    window !== window.top &&
    (location.hostname.includes(".itch.zone") || location.hostname.includes(".hwcdn.net"));
  if (!SHOULD_RENDER_PANEL) {
    return;
  }

  function appendToRoot(node) {
    const root = document.documentElement || document.head || document.body;
    if (root) {
      root.appendChild(node);
      return true;
    }
    return false;
  }

  function installHookScript() {
    if (hookInstalled) {
      return;
    }

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/inject/network-hook.js");
    script.dataset.eventName = INJECTED_EVENT;
    script.async = false;
    script.onload = () => script.remove();

    const appended = appendToRoot(script);
    if (appended) {
      hookInstalled = true;
    }
  }

  if (document.documentElement || document.head || document.body) {
    installHookScript();
  } else {
    document.addEventListener("readystatechange", installHookScript, { once: true });
    document.addEventListener("DOMContentLoaded", installHookScript, { once: true });
  }

  const panel = document.createElement("div");
  panel.id = "sap-live-play-panel";
  panel.style.position = "fixed";
  panel.style.right = "12px";
  panel.style.top = "30%";
  panel.style.transform = "translateY(-50%)";
  panel.style.zIndex = "2147483647";
  panel.style.background = "rgba(255,255,255,0.22)";
  panel.style.color = "#111";
  panel.style.border = "1px solid rgba(255,255,255,0.55)";
  panel.style.borderRadius = "8px";
  panel.style.padding = "6px";
  panel.style.width = "240px";
  panel.style.maxHeight = "82vh";
  panel.style.overflow = "auto";
  panel.style.fontFamily = "system-ui, -apple-system, Segoe UI, sans-serif";
  panel.style.fontSize = "9px";
  panel.style.lineHeight = "1.35";
  panel.style.pointerEvents = "auto";

  const title = document.createElement("div");
  title.textContent = "SAP Live Play Monitor";
  title.style.fontWeight = "700";
  title.style.marginBottom = "6px";

  const statusLine = document.createElement("div");
  const countLine = document.createElement("div");
  const latestLine = document.createElement("div");
  statusLine.style.marginBottom = "2px";
  countLine.style.marginBottom = "2px";
  latestLine.style.marginBottom = "6px";

  const copyLatestBtn = document.createElement("button");
  copyLatestBtn.textContent = "Copy Latest watch";
  copyLatestBtn.style.width = "100%";
  copyLatestBtn.style.padding = "4px 6px";
  copyLatestBtn.style.border = "1px solid #505050";
  copyLatestBtn.style.borderRadius = "6px";
  copyLatestBtn.style.background = "rgba(255,255,255,0.35)";
  copyLatestBtn.style.color = "#111";
  copyLatestBtn.style.cursor = "pointer";

  const copyAllBtn = document.createElement("button");
  copyAllBtn.textContent = "Copy Full watch Log";
  copyAllBtn.style.width = "100%";
  copyAllBtn.style.padding = "4px 6px";
  copyAllBtn.style.border = "1px solid #505050";
  copyAllBtn.style.borderRadius = "6px";
  copyAllBtn.style.background = "rgba(255,255,255,0.35)";
  copyAllBtn.style.color = "#111";
  copyAllBtn.style.cursor = "pointer";
  copyAllBtn.style.marginTop = "6px";

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "Clear watch Log";
  clearBtn.style.width = "100%";
  clearBtn.style.padding = "4px 6px";
  clearBtn.style.border = "1px solid #505050";
  clearBtn.style.borderRadius = "6px";
  clearBtn.style.background = "rgba(255,255,255,0.35)";
  clearBtn.style.color = "#111";
  clearBtn.style.cursor = "pointer";
  clearBtn.style.marginTop = "6px";

  const replayBtn = document.createElement("button");
  replayBtn.textContent = "Run Replay From Latest Pid";
  replayBtn.style.width = "100%";
  replayBtn.style.padding = "4px 6px";
  replayBtn.style.border = "1px solid #505050";
  replayBtn.style.borderRadius = "6px";
  replayBtn.style.background = "rgba(255,255,255,0.35)";
  replayBtn.style.color = "#111";
  replayBtn.style.cursor = "pointer";
  replayBtn.style.marginTop = "6px";

  const replayStatus = document.createElement("div");
  replayStatus.style.marginTop = "6px";
  replayStatus.style.minHeight = "16px";
  replayStatus.style.color = "#d5d5d5";

  const replayImage = document.createElement("img");
  replayImage.style.display = "none";
  replayImage.style.width = "100%";
  replayImage.style.marginTop = "8px";
  replayImage.style.border = "1px solid #2f2f2f";
  replayImage.style.borderRadius = "6px";
  replayImage.style.background = "rgba(255,255,255,0.20)";

  const previewTitle = document.createElement("div");
  previewTitle.textContent = "Latest Entry Preview";
  previewTitle.style.marginTop = "8px";
  previewTitle.style.fontWeight = "700";

  const preview = document.createElement("pre");
  preview.style.margin = "6px 0 0";
  preview.style.padding = "6px";
  preview.style.border = "1px solid #2f2f2f";
  preview.style.borderRadius = "6px";
  preview.style.background = "rgba(255,255,255,0.20)";
  preview.style.whiteSpace = "pre-wrap";
  preview.style.wordBreak = "break-word";
  preview.style.maxHeight = "130px";
  preview.style.overflow = "auto";
  preview.textContent = "No watch data captured yet.";

  panel.appendChild(title);
  panel.appendChild(statusLine);
  panel.appendChild(countLine);
  panel.appendChild(latestLine);
  panel.appendChild(copyLatestBtn);
  panel.appendChild(copyAllBtn);
  panel.appendChild(clearBtn);
  panel.appendChild(replayBtn);
  panel.appendChild(replayStatus);
  panel.appendChild(previewTitle);
  panel.appendChild(preview);
  panel.appendChild(replayImage);

  if (!appendToRoot(panel)) {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        appendToRoot(panel);
      },
      { once: true }
    );
  }

  function timeText(ts) {
    if (!ts) return "never";
    return new Date(ts).toLocaleTimeString();
  }

  function entryPreviewText(entry) {
    if (!entry) {
      return "No watch data captured yet.";
    }

    if (entry.kind === "arena-watch-post" || entry.kind === "versus-watch-post") {
      const bodyText = typeof entry.bodyText === "string" ? entry.bodyText : "";
      try {
        return JSON.stringify(JSON.parse(bodyText), null, 2);
      } catch {
        return bodyText || "{}";
      }
    }

    return JSON.stringify(entry, null, 2);
  }

  function render() {
    statusLine.textContent = `Connected: ${connected ? "yes" : "no"} | Capture events: ${captureCount}`;
    countLine.textContent = `arena p/r: ${arenaPostCount}/${arenaResponseCount} | versus p/r: ${versusPostCount}/${versusResponseCount}`;
    latestLine.textContent = `Latest watch: ${timeText(latestWatchEntry?.capturedAt)} | Frame: ${location.hostname}`;
    preview.textContent = entryPreviewText(latestWatchEntry);
  }

  async function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => resolve(response ?? null));
    });
  }

  async function readArenaWatchLog() {
    const response = await sendMessage({ type: "SAP_GET_ARENA_WATCH_LOG" });
    if (!response?.ok) {
      return [];
    }
    return Array.isArray(response.payload) ? response.payload : [];
  }

  async function refreshFromStorage() {
    const [statusResponse, log] = await Promise.all([
      sendMessage({ type: "SAP_GET_GAME_STATUS" }),
      readArenaWatchLog()
    ]);
    connected = Boolean(statusResponse?.ok);
    arenaPostCount = log.filter((entry) => entry?.kind === "arena-watch-post").length;
    arenaResponseCount = log.filter((entry) => entry?.kind === "arena-watch-response").length;
    versusPostCount = log.filter((entry) => entry?.kind === "versus-watch-post").length;
    versusResponseCount = log.filter((entry) => entry?.kind === "versus-watch-response").length;
    latestWatchEntry = log.length > 0 ? log[log.length - 1] : null;
    render();
  }

  async function copyLatestEntry() {
    if (!latestWatchEntry) {
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(latestWatchEntry, null, 2));
  }

  async function copyFullLog() {
    const log = await readArenaWatchLog();
    await navigator.clipboard.writeText(JSON.stringify(log, null, 2));
  }

  async function clearArenaWatchLog() {
    const response = await sendMessage({ type: "SAP_CLEAR_ARENA_WATCH_LOG" });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed clearing arena/watch log");
    }
  }

  function parseArenaBodyText(value) {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      const pid = typeof parsed.Pid === "string" ? parsed.Pid.trim() : "";
      if (!pid) {
        return null;
      }
      return { Pid: pid, T: 1 };
    } catch {
      return null;
    }
  }

  function findImageUrlInValue(value) {
    if (!value) {
      return null;
    }

    if (typeof value === "string") {
      const text = value.trim();
      if (text.startsWith("data:image/")) {
        return text;
      }

      if (/^https?:\/\//i.test(text)) {
        const lower = text.toLowerCase();
        if (
          lower.includes(".png") ||
          lower.includes(".jpg") ||
          lower.includes(".jpeg") ||
          lower.includes(".webp") ||
          lower.includes(".gif") ||
          lower.includes("image")
        ) {
          return text;
        }
      }
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findImageUrlInValue(item);
        if (found) {
          return found;
        }
      }
      return null;
    }

    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === "string") {
          const keyLower = key.toLowerCase();
          if (keyLower.includes("image") || keyLower.includes("img") || keyLower.includes("screenshot")) {
            const found = findImageUrlInValue(child);
            if (found) {
              return found;
            }
          }
        }
      }

      for (const child of Object.values(value)) {
        const found = findImageUrlInValue(child);
        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  function postReplayWatch(url, body) {
    return sendMessage({
      type: "SAP_POST_ARENA_WATCH",
      url,
      body
    });
  }

  async function runReplayFromLatestPid() {
    replayStatus.textContent = "Running replay request...";
    replayImage.style.display = "none";
    replayImage.removeAttribute("src");

    const log = await readArenaWatchLog();
    const latestPost = [...log]
      .reverse()
      .find((entry) => entry?.kind === "arena-watch-post" || entry?.kind === "versus-watch-post");
    const body = parseArenaBodyText(latestPost?.bodyText ?? "");
    if (!body) {
      replayStatus.textContent = "No valid latest Pid found in watch post log.";
      return;
    }

    const replayUrl = latestPost?.kind === "versus-watch-post" ? VERSUS_WATCH_API_URL : ARENA_WATCH_API_URL;
    const response = await postReplayWatch(replayUrl, body);

    if (!response?.ok) {
      replayStatus.textContent = `Replay request failed: ${response?.error || "unknown error"}`;
      return;
    }

    const payload = response.payload || {};
    const imageUrl = findImageUrlInValue(payload.responseJson) || findImageUrlInValue(payload.responseText);
    if (!imageUrl) {
      replayStatus.textContent = `Replay request succeeded (HTTP ${payload.status ?? "?"}) but no image URL found in response.`;
      return;
    }

    replayImage.src = imageUrl;
    replayImage.style.display = "block";
    replayStatus.textContent = `Replay request succeeded (HTTP ${payload.status ?? "?"}).`;
  }

  window.addEventListener(INJECTED_EVENT, (event) => {
    const payload = event?.detail ?? null;
    if (!payload) {
      return;
    }

    captureCount += 1;
    if (payload.kind === "arena-watch-post") {
      arenaPostCount += 1;
      latestWatchEntry = payload;
    } else if (payload.kind === "arena-watch-response") {
      arenaResponseCount += 1;
      latestWatchEntry = payload;
    } else if (payload.kind === "versus-watch-post") {
      versusPostCount += 1;
      latestWatchEntry = payload;
    } else if (payload.kind === "versus-watch-response") {
      versusResponseCount += 1;
      latestWatchEntry = payload;
    }

    chrome.runtime.sendMessage(
      {
        type: "SAP_GAME_STATE_UPDATE",
        state: payload,
        context: {
          href: location.href,
          referrer: document.referrer,
          isTop: window === window.top
        }
      },
      (response) => {
        connected = Boolean(response?.ok);
        render();
      }
    );

    render();
  });

  copyLatestBtn.addEventListener("click", () => {
    void copyLatestEntry().catch((err) => {
      console.error("Failed copying latest watch entry:", err);
    });
  });

  copyAllBtn.addEventListener("click", () => {
    void copyFullLog().catch((err) => {
      console.error("Failed copying watch log:", err);
    });
  });

  clearBtn.addEventListener("click", () => {
    void clearArenaWatchLog()
      .then(() => refreshFromStorage())
      .catch((err) => {
        console.error("Failed clearing watch log:", err);
      });
  });

  replayBtn.addEventListener("click", () => {
    void runReplayFromLatestPid().catch((err) => {
      replayStatus.textContent = `Replay failed: ${String(err)}`;
    });
  });

  void refreshFromStorage();
  setInterval(() => {
    void refreshFromStorage();
  }, REFRESH_MS);
})();






