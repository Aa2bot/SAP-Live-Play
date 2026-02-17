const LATEST_STATE_KEY = "latestSapBoardState";
const BATTLE_GET_HISTORY_KEY = "sapBattleGetHistory";
const BATTLE_GET_TEXT_LOG_KEY = "sapBattleGetTextLog";
const WS_FRAME_LOG_KEY = "sapWebSocketFrameLog";
const SAP_RUNTIME_STATUS_KEY = "sapRuntimeStatus";
const ARENA_WATCH_LOG_KEY = "sapArenaWatchLog";

const MAX_BATTLE_GET_HISTORY = 100;
const MAX_BATTLE_GET_TEXT_LOG = 12;
const MAX_BATTLE_GET_TEXT_CHARS = 300000;
const MAX_WS_FRAME_LOG = 80;
const MAX_WS_FRAME_CHARS = 12000;
const MAX_ARENA_WATCH_LOG = 200;
const MAX_ARENA_WATCH_TEXT_CHARS = 300000;
const SAP_URL_PREFIX = "https://teamwood.itch.io/super-auto-pets";
const BATTLE_GET_API_PREFIX = "https://api.teamwood.games/0.45/api/battle/get/";
const ARENA_WATCH_API_URL = "https://api.teamwood.games/0.45/api/arena/watch";
const VERSUS_WATCH_API_URL = "https://api.teamwood.games/0.45/api/versus/watch";
const SAP_URL_HINTS = [
  "teamwood.itch.io/super-auto-pets",
  ".itch.zone/",
  ".hwcdn.net/"
];

const debuggerAttachedTabs = new Set();
const pendingBattleGetRequests = new Map();
const wsRequestMeta = new Map();
const HAS_DEBUGGER_API = Boolean(chrome.debugger && chrome.debugger.onEvent && chrome.debugger.sendCommand);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSapTabUrl(url) {
  if (typeof url !== "string" || url.length === 0) {
    return false;
  }

  if (url.startsWith(SAP_URL_PREFIX)) {
    return true;
  }

  return SAP_URL_HINTS.some((hint) => url.includes(hint));
}

function isBattleGetUrl(url) {
  return typeof url === "string" && url.startsWith(BATTLE_GET_API_PREFIX);
}

function isArenaWatchUrl(url) {
  return typeof url === "string" && url.startsWith(ARENA_WATCH_API_URL);
}

function isVersusWatchUrl(url) {
  return typeof url === "string" && url.startsWith(VERSUS_WATCH_API_URL);
}

function makeNow() {
  return Date.now();
}

function looksLikeBattlePayload(payload) {
  return Boolean(payload && typeof payload === "object" && payload.Id && payload.UserBoard && payload.OpponentBoard);
}

function outcomeToText(outcome) {
  if (outcome === 1) return "PlayerWon";
  if (outcome === 0) return "Draw";
  if (outcome === 2) return "PlayerLost";
  return String(outcome ?? "Unknown");
}

function normalizeBattleUnit(item, fallbackSlot) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const permAttack = Number(item.At?.Perm ?? item.attack ?? item.atk ?? 0);
  const tempAttack = Number(item.At?.Temp ?? 0);
  const permHealth = Number(item.Hp?.Perm ?? item.health ?? item.hp ?? 0);
  const tempHealth = Number(item.Hp?.Temp ?? 0);
  const attack = permAttack + tempAttack;
  const health = permHealth + tempHealth;
  const x = Number(item.Poi?.x ?? fallbackSlot - 1);

  return {
    slot: Number.isFinite(x) ? x + 1 : fallbackSlot,
    name: item.Name || item.name || (item.Enu !== undefined ? `enu_${item.Enu}` : `slot_${fallbackSlot}`),
    attack: Number.isFinite(attack) ? attack : 0,
    health: Number.isFinite(health) ? health : 0,
    level: Number.isFinite(Number(item.Lvl ?? item.level ?? 1)) ? Number(item.Lvl ?? item.level ?? 1) : 1,
    experience: Number.isFinite(Number(item.Exp ?? item.experience ?? 0))
      ? Number(item.Exp ?? item.experience ?? 0)
      : 0,
    enu: item.Enu ?? item.enu ?? null
  };
}

function normalizeBattleItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => normalizeBattleUnit(item, index + 1))
    .filter(Boolean)
    .sort((a, b) => a.slot - b.slot)
    .map((pet, index) => ({ ...pet, slot: index + 1 }));
}

function normalizeBattleBoard(board) {
  if (!board || typeof board !== "object") {
    return { team: [], shop: [], meta: {} };
  }

  return {
    team: normalizeBattleItems(board.Mins?.Items ?? []),
    shop: normalizeBattleItems(board.MiSh ?? []),
    meta: {
      turn: board.Tur ?? null,
      gold: board.Go ?? null,
      wins: board.Vic ?? null,
      losses: board.Los ?? null,
      tier: board.Ti ?? null,
      lifeMax: board.LiMa ?? null
    }
  };
}

function snapshotFromBattlePayload(payload, capturedAt) {
  if (!looksLikeBattlePayload(payload)) {
    return null;
  }

  const userBoard = normalizeBattleBoard(payload.UserBoard);
  const opponentBoard = normalizeBattleBoard(payload.OpponentBoard);
  if (userBoard.team.length === 0 && userBoard.shop.length === 0) {
    return null;
  }

  return {
    capturedAt: capturedAt ?? makeNow(),
    sourcePath: "$.UserBoard",
    sourceType: "battle-get-api",
    battleId: payload.Id ?? null,
    battleSeed: payload.Seed ?? null,
    battleOutcome: outcomeToText(payload.Outcome),
    battleEndResult: payload.EndResult ?? null,
    resolvedOn: payload.ResolvedOn ?? null,
    team: userBoard.team,
    shop: userBoard.shop,
    opponentTeam: opponentBoard.team,
    opponentShop: opponentBoard.shop,
    rawHintKeys: Object.keys(payload || {}),
    scalarFields: {
      ...userBoard.meta,
      opponentTurn: opponentBoard.meta.turn ?? null,
      opponentWins: opponentBoard.meta.wins ?? null,
      opponentLosses: opponentBoard.meta.losses ?? null,
      userName: payload.User?.DisplayName ?? null,
      opponentName: payload.Opponent?.DisplayName ?? null
    },
    teamSize: userBoard.team.length,
    shopSize: userBoard.shop.length
  };
}

function buildMergedState(currentState, incomingState, now) {
  const derivedSnapshot =
    incomingState?.kind === "battle-get-raw"
      ? snapshotFromBattlePayload(incomingState.payload, incomingState.capturedAt ?? now)
      : null;

  return {
    kind: incomingState?.kind ?? currentState?.kind ?? null,
    transport: incomingState?.transport ?? currentState?.transport ?? null,
    snapshot:
      incomingState?.kind === "snapshot"
        ? incomingState.snapshot ?? null
        : derivedSnapshot ?? currentState?.snapshot ?? null,
    seeds:
      incomingState?.kind === "battle-seeds"
        ? incomingState.seeds ?? null
        : currentState?.seeds ?? null,
    lastBattleStart:
      incomingState?.kind === "battle-start"
        ? {
            capturedAt: incomingState.capturedAt ?? now,
            message: incomingState.message ?? null
          }
        : currentState?.lastBattleStart ?? null,
    lastBattleComplete:
      incomingState?.kind === "battle-complete"
        ? {
            capturedAt: incomingState.capturedAt ?? now,
            outcome: incomingState.outcome ?? null,
            masterSeed: incomingState.masterSeed ?? null,
            endResult: incomingState.endResult ?? null,
            message: incomingState.message ?? null
          }
        : currentState?.lastBattleComplete ?? null,
    lastBattleGet:
      incomingState?.kind === "battle-get-raw"
        ? {
            capturedAt: incomingState.capturedAt ?? now,
            url: incomingState.url ?? null,
            battleId: incomingState.battleId ?? incomingState.payload?.Id ?? null,
            seed: incomingState.seed ?? incomingState.payload?.Seed ?? null,
            resolvedOn: incomingState.resolvedOn ?? incomingState.payload?.ResolvedOn ?? null
          }
        : currentState?.lastBattleGet ?? null,
    lastBattleGetText:
      incomingState?.kind === "battle-get-text"
        ? {
            capturedAt: incomingState.capturedAt ?? now,
            url: incomingState.url ?? null,
            textLength: typeof incomingState.text === "string" ? incomingState.text.length : 0
          }
        : currentState?.lastBattleGetText ?? null,
    lastMessage: incomingState?.message ?? currentState?.lastMessage ?? null,
    rawHintKeys:
      incomingState?.snapshot?.rawHintKeys ??
      derivedSnapshot?.rawHintKeys ??
      currentState?.snapshot?.rawHintKeys ??
      [],
    debugSourcePath:
      incomingState?.snapshot?.sourcePath ??
      derivedSnapshot?.sourcePath ??
      currentState?.snapshot?.sourcePath ??
      null
  };
}

function fallbackLatestStateFromHistory(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return null;
  }

  const latest = history[history.length - 1];
  if (!looksLikeBattlePayload(latest?.payload)) {
    return null;
  }

  const incomingRaw = {
    kind: "battle-get-raw",
    transport: latest.transport ?? "history-fallback:battle-get",
    capturedAt: latest.capturedAt ?? makeNow(),
    url: latest.url ?? null,
    battleId: latest.battleId ?? latest.payload?.Id ?? null,
    seed: latest.seed ?? latest.payload?.Seed ?? null,
    resolvedOn: latest.resolvedOn ?? latest.payload?.ResolvedOn ?? null,
    payload: latest.payload
  };

  const state = buildMergedState(null, incomingRaw, incomingRaw.capturedAt);
  return {
    receivedAt: incomingRaw.capturedAt,
    sourceTabId: latest.sourceTabId ?? null,
    context: latest.context ?? null,
    state
  };
}

function appendBattleGetHistory(currentHistory, incomingState, sourceTabId, context, now) {
  if (incomingState?.kind !== "battle-get-raw") {
    return currentHistory;
  }

  const payload = incomingState?.payload;
  if (!payload || typeof payload !== "object") {
    return currentHistory;
  }

  const newEntry = {
    capturedAt: incomingState.capturedAt ?? now,
    sourceTabId: sourceTabId ?? null,
    context: context ?? null,
    transport: incomingState.transport ?? null,
    url: incomingState.url ?? null,
    battleId: incomingState.battleId ?? payload.Id ?? null,
    seed: incomingState.seed ?? payload.Seed ?? null,
    resolvedOn: incomingState.resolvedOn ?? payload.ResolvedOn ?? null,
    payload
  };

  const dedupeKey = `${newEntry.battleId ?? "unknown"}:${newEntry.resolvedOn ?? ""}:${newEntry.seed ?? ""}`;
  const filtered = (currentHistory || []).filter((entry) => {
    const key = `${entry.battleId ?? "unknown"}:${entry.resolvedOn ?? ""}:${entry.seed ?? ""}`;
    return key !== dedupeKey;
  });

  const next = [...filtered, newEntry];
  if (next.length > MAX_BATTLE_GET_HISTORY) {
    return next.slice(next.length - MAX_BATTLE_GET_HISTORY);
  }
  return next;
}

function appendBattleGetTextLog(currentLog, incomingState, sourceTabId, context, now) {
  if (incomingState?.kind !== "battle-get-text") {
    return currentLog;
  }

  const text = typeof incomingState?.text === "string" ? incomingState.text : "";
  if (!text) {
    return currentLog;
  }

  const trimmedText = text.length > MAX_BATTLE_GET_TEXT_CHARS ? text.slice(0, MAX_BATTLE_GET_TEXT_CHARS) : text;
  const entry = {
    capturedAt: incomingState.capturedAt ?? now,
    sourceTabId: sourceTabId ?? null,
    context: context ?? null,
    transport: incomingState.transport ?? null,
    url: incomingState.url ?? null,
    text: trimmedText,
    textLength: text.length,
    truncated: text.length > MAX_BATTLE_GET_TEXT_CHARS
  };

  const next = [...(currentLog || []), entry];
  if (next.length > MAX_BATTLE_GET_TEXT_LOG) {
    return next.slice(next.length - MAX_BATTLE_GET_TEXT_LOG);
  }
  return next;
}

function appendArenaWatchLog(currentLog, incomingState, sourceTabId, context, now) {
  const kind = incomingState?.kind;
  if (
    kind !== "arena-watch-post" &&
    kind !== "arena-watch-response" &&
    kind !== "versus-watch-post" &&
    kind !== "versus-watch-response"
  ) {
    return currentLog;
  }

  const bodyText = typeof incomingState?.bodyText === "string" ? incomingState.bodyText : "";
  const responseText = typeof incomingState?.text === "string" ? incomingState.text : "";
  const bodyTrimmed =
    bodyText.length > MAX_ARENA_WATCH_TEXT_CHARS ? bodyText.slice(0, MAX_ARENA_WATCH_TEXT_CHARS) : bodyText;
  const responseTrimmed =
    responseText.length > MAX_ARENA_WATCH_TEXT_CHARS
      ? responseText.slice(0, MAX_ARENA_WATCH_TEXT_CHARS)
      : responseText;

  const entry = {
    kind,
    capturedAt: incomingState.capturedAt ?? now,
    sourceTabId: sourceTabId ?? null,
    context: context ?? null,
    transport: incomingState.transport ?? null,
    url: incomingState.url ?? null,
    method: incomingState.method ?? null,
    status: incomingState.status ?? null,
    headers: incomingState.headers ?? null,
    contentType: incomingState.contentType ?? null,
    bodyText: bodyTrimmed,
    bodyLength: incomingState.bodyLength ?? bodyText.length,
    bodyTruncated: bodyText.length > MAX_ARENA_WATCH_TEXT_CHARS,
    responseText: responseTrimmed,
    responseTextLength: incomingState.textLength ?? responseText.length,
    responseTruncated: responseText.length > MAX_ARENA_WATCH_TEXT_CHARS
  };

  const next = [...(currentLog || []), entry];
  if (next.length > MAX_ARENA_WATCH_LOG) {
    return next.slice(next.length - MAX_ARENA_WATCH_LOG);
  }
  return next;
}

function nextRuntimeStatus(currentRuntime, incomingState, senderTabId, context, now) {
  const base = {
    lastPingAt: currentRuntime?.lastPingAt ?? null,
    lastPingHref: currentRuntime?.lastPingHref ?? null,
    lastPingTabId: currentRuntime?.lastPingTabId ?? null,
    lastEventAt: currentRuntime?.lastEventAt ?? null,
    lastEventKind: currentRuntime?.lastEventKind ?? null,
    lastBattleGetAt: currentRuntime?.lastBattleGetAt ?? null,
    lastBattleGetId: currentRuntime?.lastBattleGetId ?? null,
    lastBattleGetTextAt: currentRuntime?.lastBattleGetTextAt ?? null,
    lastCaptureAt: currentRuntime?.lastCaptureAt ?? null,
    lastCaptureTransport: currentRuntime?.lastCaptureTransport ?? null,
    debuggerAttached: currentRuntime?.debuggerAttached ?? false
  };

  if (!incomingState) {
    return base;
  }

  base.lastEventAt = now;
  base.lastEventKind = incomingState.kind ?? base.lastEventKind;
  base.lastCaptureAt = now;
  base.lastCaptureTransport = incomingState.transport ?? base.lastCaptureTransport;

  if (incomingState.kind === "battle-get-raw") {
    base.lastBattleGetAt = now;
    base.lastBattleGetId = incomingState.battleId ?? incomingState.payload?.Id ?? null;
  }

  if (incomingState.kind === "battle-get-text") {
    base.lastBattleGetTextAt = now;
  }

  if (context?.href) {
    base.lastPingHref = context.href;
  }

  if (senderTabId !== undefined && senderTabId !== null) {
    base.lastPingTabId = senderTabId;
  }

  return base;
}

async function applyIncomingState(incomingState, senderTabId, context) {
  const now = makeNow();
  const result = await chrome.storage.local.get([
    LATEST_STATE_KEY,
    BATTLE_GET_HISTORY_KEY,
    BATTLE_GET_TEXT_LOG_KEY,
    SAP_RUNTIME_STATUS_KEY,
    ARENA_WATCH_LOG_KEY
  ]);

  const current = result[LATEST_STATE_KEY] ?? null;
  const currentHistory = result[BATTLE_GET_HISTORY_KEY] ?? [];
  const currentTextLog = result[BATTLE_GET_TEXT_LOG_KEY] ?? [];
  const currentRuntime = result[SAP_RUNTIME_STATUS_KEY] ?? null;
  const currentArenaWatchLog = result[ARENA_WATCH_LOG_KEY] ?? [];

  const mergedState = buildMergedState(current?.state ?? null, incomingState, now);

  const payload = {
    receivedAt: now,
    sourceTabId: senderTabId ?? current?.sourceTabId ?? null,
    context: context ?? current?.context ?? null,
    state: mergedState
  };

  const history = appendBattleGetHistory(
    currentHistory,
    incomingState,
    senderTabId ?? current?.sourceTabId ?? null,
    context ?? current?.context ?? null,
    now
  );

  const textLog = appendBattleGetTextLog(
    currentTextLog,
    incomingState,
    senderTabId ?? current?.sourceTabId ?? null,
    context ?? current?.context ?? null,
    now
  );

  const runtime = nextRuntimeStatus(currentRuntime, incomingState, senderTabId, context, now);
  const arenaWatchLog = appendArenaWatchLog(
    currentArenaWatchLog,
    incomingState,
    senderTabId ?? current?.sourceTabId ?? null,
    context ?? current?.context ?? null,
    now
  );

  await chrome.storage.local.set({
    [LATEST_STATE_KEY]: payload,
    [BATTLE_GET_HISTORY_KEY]: history,
    [BATTLE_GET_TEXT_LOG_KEY]: textLog,
    [SAP_RUNTIME_STATUS_KEY]: runtime,
    [ARENA_WATCH_LOG_KEY]: arenaWatchLog
  });
}

async function setDebuggerAttachedStatus(attached, tabId) {
  const result = await chrome.storage.local.get([SAP_RUNTIME_STATUS_KEY]);
  const runtime = result[SAP_RUNTIME_STATUS_KEY] ?? {};
  runtime.debuggerAttached = Boolean(attached);
  if (tabId !== undefined && tabId !== null) {
    runtime.lastPingTabId = tabId;
  }
  await chrome.storage.local.set({ [SAP_RUNTIME_STATUS_KEY]: runtime });
}

async function ensureDebuggerAttached(tabId) {
  if (!HAS_DEBUGGER_API) {
    return;
  }

  if (tabId === undefined || tabId === null) {
    return;
  }

  if (debuggerAttachedTabs.has(tabId)) {
    return;
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (!msg.includes("Another debugger is already attached")) {
      console.warn("Failed to attach debugger:", err);
      return;
    }
  }

  try {
    await chrome.debugger.sendCommand(target, "Network.enable");
    debuggerAttachedTabs.add(tabId);
    await setDebuggerAttachedStatus(true, tabId);
  } catch (err) {
    console.warn("Failed to enable Network domain:", err);
  }
}

function decodeBody(body, base64Encoded) {
  if (!base64Encoded) {
    return body;
  }

  try {
    return decodeURIComponent(
      Array.prototype.map
        .call(atob(body), (c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
        .join("")
    );
  } catch {
    try {
      return atob(body);
    } catch {
      return "";
    }
  }
}

function safeJsonParse(value) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function maybeExtractJsonChunk(text) {
  if (typeof text !== "string") {
    return null;
  }

  const direct = safeJsonParse(text);
  if (direct) {
    return direct;
  }

  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  const starts = [firstBrace, firstBracket].filter((i) => i >= 0);
  if (starts.length === 0) {
    return null;
  }

  const start = Math.min(...starts);
  for (let end = text.length; end > start + 1; end -= 1) {
    const chunk = text.slice(start, end);
    const parsed = safeJsonParse(chunk);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function tryDecodeBase64ToText(value) {
  if (typeof value !== "string" || value.length < 8 || value.length % 4 !== 0) {
    return null;
  }

  if (!/^[A-Za-z0-9+/=]+$/.test(value)) {
    return null;
  }

  try {
    const raw = atob(value);
    const printableCount = raw
      .split("")
      .reduce((acc, ch) => {
        const code = ch.charCodeAt(0);
        const printable = code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);
        return acc + (printable ? 1 : 0);
      }, 0);

    if (printableCount / raw.length < 0.7) {
      return null;
    }

    return raw;
  } catch {
    return null;
  }
}

function findCompactBoardCandidate(value, path = "$", depth = 0) {
  if (depth > 8 || value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findCompactBoardCandidate(value[i], `${path}[${i}]`, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  const hasBoardArrays = Array.isArray(value.Mins?.Items) || Array.isArray(value.MiSh);
  if (hasBoardArrays) {
    return { board: value, path };
  }

  for (const [key, nested] of Object.entries(value)) {
    const found = findCompactBoardCandidate(nested, `${path}.${key}`, depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

function snapshotFromCompactBoardPayload(payload, capturedAt) {
  const candidate = findCompactBoardCandidate(payload);
  if (!candidate) {
    return null;
  }

  const board = normalizeBattleBoard(candidate.board);
  if (board.team.length === 0 && board.shop.length === 0) {
    return null;
  }

  return {
    capturedAt: capturedAt ?? makeNow(),
    sourcePath: candidate.path,
    sourceType: "ws-compact-board",
    battleId: payload?.Id ?? null,
    battleSeed: payload?.Seed ?? null,
    battleOutcome: payload?.Outcome ?? null,
    battleEndResult: payload?.EndResult ?? null,
    resolvedOn: payload?.ResolvedOn ?? null,
    team: board.team,
    shop: board.shop,
    opponentTeam: [],
    opponentShop: [],
    rawHintKeys: Object.keys(candidate.board || {}),
    scalarFields: {
      turn: candidate.board?.Tur ?? null,
      gold: candidate.board?.Go ?? null,
      wins: candidate.board?.Vic ?? null,
      losses: candidate.board?.Los ?? null,
      tier: candidate.board?.Ti ?? null
    },
    teamSize: board.team.length,
    shopSize: board.shop.length
  };
}

async function appendWebSocketFrameLog(entry) {
  const result = await chrome.storage.local.get([WS_FRAME_LOG_KEY]);
  const current = result[WS_FRAME_LOG_KEY] ?? [];
  const next = [...current, entry];
  const bounded = next.length > MAX_WS_FRAME_LOG ? next.slice(next.length - MAX_WS_FRAME_LOG) : next;
  await chrome.storage.local.set({ [WS_FRAME_LOG_KEY]: bounded });
}

async function ingestWebSocketFrame(tabId, url, direction, opcode, payloadData) {
  const capturedAt = makeNow();
  const directText = typeof payloadData === "string" ? payloadData : "";
  const decodedText = tryDecodeBase64ToText(directText);
  const text = decodedText || directText;
  const truncatedText = text.length > MAX_WS_FRAME_CHARS ? text.slice(0, MAX_WS_FRAME_CHARS) : text;

  const parsed = maybeExtractJsonChunk(text);
  const snapshot =
    (parsed && snapshotFromBattlePayload(parsed, capturedAt)) ||
    (parsed && snapshotFromCompactBoardPayload(parsed, capturedAt)) ||
    null;

  await appendWebSocketFrameLog({
    capturedAt,
    sourceTabId: tabId ?? null,
    transport: "chrome-debugger:websocket",
    direction,
    opcode,
    url: url ?? null,
    payloadLength: typeof payloadData === "string" ? payloadData.length : 0,
    textLength: text.length,
    textPreview: truncatedText,
    parsed: Boolean(parsed),
    parsedKeys: parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 25) : [],
    snapshotDetected: Boolean(snapshot),
    snapshotSourceType: snapshot?.sourceType ?? null
  });

  if (!snapshot) {
    return;
  }

  await applyIncomingState(
    {
      kind: "snapshot",
      transport: "chrome-debugger:websocket",
      capturedAt,
      snapshot
    },
    tabId,
    { href: `debugger-ws:${url || "unknown"}`, isTop: false }
  );
}

async function ingestBattleGetBodyFromDebugger(tabId, url, text) {
  const context = { href: `debugger:${url || "unknown"}`, isTop: false };
  const incomingText = {
    kind: "battle-get-text",
    transport: "chrome-debugger:battle-get",
    capturedAt: makeNow(),
    url,
    text
  };

  await applyIncomingState(incomingText, tabId, context);

  try {
    const parsed = JSON.parse(text);
    if (looksLikeBattlePayload(parsed)) {
      const incomingRaw = {
        kind: "battle-get-raw",
        transport: "chrome-debugger:battle-get",
        capturedAt: makeNow(),
        url,
        battleId: parsed.Id ?? null,
        seed: parsed.Seed ?? null,
        resolvedOn: parsed.ResolvedOn ?? null,
        payload: parsed
      };
      await applyIncomingState(incomingRaw, tabId, context);
    }
  } catch {
    // Keep raw text even if JSON parse fails.
  }
}

async function refetchBattleGetUrl(url, senderTabId, reason) {
  if (!isBattleGetUrl(url)) {
    return false;
  }

  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache: "no-store"
  });

  if (!response.ok) {
    return false;
  }

  const text = await response.text();
  const context = { href: `${reason}:${url}`, isTop: false };

  await applyIncomingState(
    {
      kind: "battle-get-text",
      transport: `${reason}:battle-get`,
      capturedAt: makeNow(),
      url,
      text
    },
    senderTabId,
    context
  );

  const parsed = safeJsonParse(text);
  if (looksLikeBattlePayload(parsed)) {
    await applyIncomingState(
      {
        kind: "battle-get-raw",
        transport: `${reason}:battle-get`,
        capturedAt: makeNow(),
        url,
        battleId: parsed.Id ?? null,
        seed: parsed.Seed ?? null,
        resolvedOn: parsed.ResolvedOn ?? null,
        payload: parsed
      },
      senderTabId,
      context
    );
  }

  return true;
}

async function refetchLatestBattleGetFromHistory(senderTabId) {
  const result = await chrome.storage.local.get([BATTLE_GET_HISTORY_KEY]);
  const history = result[BATTLE_GET_HISTORY_KEY] ?? [];
  const latest = history.length > 0 ? history[history.length - 1] : null;
  const latestUrl = latest?.url || null;
  if (!latestUrl || !isBattleGetUrl(latestUrl)) {
    return false;
  }

  // Two attempts, because "Abort all requests" often appears right before replay/battle state settles.
  const first = await refetchBattleGetUrl(latestUrl, senderTabId, "abort-refetch");
  await sleep(700);
  const second = await refetchBattleGetUrl(latestUrl, senderTabId, "abort-refetch");
  return first || second;
}

if (HAS_DEBUGGER_API) {
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
  try {
    if (!source || source.tabId === undefined || source.tabId === null) {
      return;
    }

    const tabId = source.tabId;

    if (method === "Network.webSocketCreated") {
      const requestId = params?.requestId;
      const url = params?.url || "";
      if (requestId) {
        wsRequestMeta.set(`${tabId}:${requestId}`, { url });
      }
      return;
    }

    if (method === "Network.webSocketClosed") {
      const requestId = params?.requestId;
      if (requestId) {
        wsRequestMeta.delete(`${tabId}:${requestId}`);
      }
      return;
    }

    if (method === "Network.webSocketFrameReceived" || method === "Network.webSocketFrameSent") {
      const requestId = params?.requestId;
      const response = params?.response || {};
      const payloadData = response.payloadData ?? "";
      const opcode = response.opcode ?? null;
      const direction = method === "Network.webSocketFrameReceived" ? "received" : "sent";
      const url = requestId ? wsRequestMeta.get(`${tabId}:${requestId}`)?.url ?? null : null;

      if (typeof payloadData === "string" && payloadData.length > 0) {
        await ingestWebSocketFrame(tabId, url, direction, opcode, payloadData);
      }
      return;
    }

    if (method === "Network.responseReceived") {
      const requestId = params?.requestId;
      const url = params?.response?.url || "";
      if (!requestId || !isBattleGetUrl(url)) {
        return;
      }

      pendingBattleGetRequests.set(`${tabId}:${requestId}`, { url });
      return;
    }

    if (method === "Network.loadingFinished") {
      const requestId = params?.requestId;
      if (!requestId) {
        return;
      }

      const key = `${tabId}:${requestId}`;
      const pending = pendingBattleGetRequests.get(key);
      if (!pending) {
        return;
      }

      pendingBattleGetRequests.delete(key);

      try {
        const bodyResult = await chrome.debugger.sendCommand(
          { tabId },
          "Network.getResponseBody",
          { requestId }
        );

        const text = decodeBody(bodyResult?.body || "", Boolean(bodyResult?.base64Encoded));
        if (typeof text === "string" && text.length > 0) {
          await ingestBattleGetBodyFromDebugger(tabId, pending.url, text);
        }
      } catch (err) {
        console.warn("Network.getResponseBody failed:", err);
      }
    }
  } catch (err) {
    console.warn("debugger event processing failed:", err);
  }
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerAttachedTabs.delete(tabId);
  for (const key of Array.from(pendingBattleGetRequests.keys())) {
    if (key.startsWith(`${tabId}:`)) {
      pendingBattleGetRequests.delete(key);
    }
  }
  for (const key of Array.from(wsRequestMeta.keys())) {
    if (key.startsWith(`${tabId}:`)) {
      wsRequestMeta.delete(key);
    }
  }
});

async function getSapGameStatus() {
  const [tabs, state] = await Promise.all([
    chrome.tabs.query({
      url: [
        `${SAP_URL_PREFIX}*`,
        "https://*.itch.zone/*",
        "https://*.hwcdn.net/*"
      ]
    }),
    chrome.storage.local.get([
      LATEST_STATE_KEY,
      SAP_RUNTIME_STATUS_KEY,
      BATTLE_GET_HISTORY_KEY,
      BATTLE_GET_TEXT_LOG_KEY,
      WS_FRAME_LOG_KEY,
      ARENA_WATCH_LOG_KEY
    ])
  ]);

  const latest = state[LATEST_STATE_KEY] ?? null;
  const runtime = state[SAP_RUNTIME_STATUS_KEY] ?? null;
  const battleHistory = state[BATTLE_GET_HISTORY_KEY] ?? [];
  const textLog = state[BATTLE_GET_TEXT_LOG_KEY] ?? [];
  const wsFrameLog = state[WS_FRAME_LOG_KEY] ?? [];
  const arenaWatchLog = state[ARENA_WATCH_LOG_KEY] ?? [];

  return {
    isOpen: tabs.length > 0,
    tabs: tabs.map((t) => ({ id: t.id, active: t.active, url: t.url, title: t.title })),
    tabCount: tabs.length,
    runtime,
    latestState: latest,
    battleHistoryCount: battleHistory.length,
    battleTextLogCount: textLog.length,
    wsFrameLogCount: wsFrameLog.length,
    arenaWatchLogCount: arenaWatchLog.length,
    lastBattleGet: battleHistory.length > 0 ? battleHistory[battleHistory.length - 1] : null,
    lastBattleText: textLog.length > 0 ? textLog[textLog.length - 1] : null,
    lastWsFrame: wsFrameLog.length > 0 ? wsFrameLog[wsFrameLog.length - 1] : null,
    lastArenaWatch: arenaWatchLog.length > 0 ? arenaWatchLog[arenaWatchLog.length - 1] : null
  };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    [LATEST_STATE_KEY]: null,
    [BATTLE_GET_HISTORY_KEY]: [],
    [BATTLE_GET_TEXT_LOG_KEY]: [],
    [WS_FRAME_LOG_KEY]: [],
    [SAP_RUNTIME_STATUS_KEY]: null,
    [ARENA_WATCH_LOG_KEY]: []
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "SAP_GAME_PING") {
    if (!isSapTabUrl(sender.tab?.url)) {
      sendResponse?.({ ok: false, ignored: true, reason: "not-sap-tab" });
      return true;
    }

    const now = makeNow();
    chrome.storage.local
      .get([SAP_RUNTIME_STATUS_KEY])
      .then(async (result) => {
        const currentRuntime = result[SAP_RUNTIME_STATUS_KEY] ?? null;
        const nextRuntime = {
          ...(currentRuntime || {}),
          lastPingAt: now,
          lastPingHref: message.context?.href ?? currentRuntime?.lastPingHref ?? null,
          lastPingTabId: sender.tab?.id ?? currentRuntime?.lastPingTabId ?? null
        };
        await chrome.storage.local.set({ [SAP_RUNTIME_STATUS_KEY]: nextRuntime });
        await ensureDebuggerAttached(sender.tab?.id ?? null);
      })
      .then(() => sendResponse?.({ ok: true }))
      .catch((err) => {
        console.error("Failed to record SAP ping:", err);
        sendResponse?.({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "SAP_GAME_STATE_UPDATE") {
    if (!isSapTabUrl(sender.tab?.url)) {
      sendResponse?.({ ok: false, ignored: true, reason: "not-sap-tab" });
      return true;
    }

    const incomingState = message.state ?? null;
    const senderTabId = sender.tab?.id ?? null;
    const context = message.context ?? null;

    applyIncomingState(incomingState, senderTabId, context)
      .then(async () => {
        if (incomingState?.kind === "abort-all-requests") {
          try {
            await refetchLatestBattleGetFromHistory(senderTabId);
          } catch (err) {
            console.warn("Abort-triggered battle/get refetch failed:", err);
          }
        }
      })
      .then(() => ensureDebuggerAttached(senderTabId))
      .then(() => {
        sendResponse?.({ ok: true });
      })
      .catch((err) => {
        console.error("Failed to store SAP state:", err);
        sendResponse?.({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "SAP_GET_GAME_STATUS") {
    getSapGameStatus()
      .then((status) => sendResponse?.({ ok: true, payload: status }))
      .catch((err) => {
        console.error("Failed to read SAP game status:", err);
        sendResponse?.({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "SAP_GET_LATEST_STATE") {
    chrome.storage.local
      .get([LATEST_STATE_KEY, BATTLE_GET_HISTORY_KEY])
      .then((result) => {
        const latest = result[LATEST_STATE_KEY] ?? null;
        if (latest) {
          sendResponse?.({ ok: true, payload: latest });
          return;
        }

        const history = result[BATTLE_GET_HISTORY_KEY] ?? [];
        const fallback = fallbackLatestStateFromHistory(history);
        sendResponse?.({ ok: true, payload: fallback });
      })
      .catch((err) => {
        console.error("Failed to read SAP state:", err);
        sendResponse?.({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "SAP_GET_BATTLE_GET_HISTORY") {
    chrome.storage.local
      .get([BATTLE_GET_HISTORY_KEY])
      .then((result) => {
        sendResponse?.({ ok: true, payload: result[BATTLE_GET_HISTORY_KEY] ?? [] });
      })
      .catch((err) => {
        console.error("Failed to read battle history:", err);
        sendResponse?.({ ok: false, error: String(err) });
      });
    return true;
  }


  if (message.type === "SAP_FETCH_BATTLE_GET_URL") {
    (async () => {
      const url = String(message.url || "").trim();
      if (!isBattleGetUrl(url)) {
        sendResponse?.({ ok: false, error: "URL must start with https://api.teamwood.games/0.45/api/battle/get/" });
        return;
      }

      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        cache: "no-store"
      });

      if (!response.ok) {
        sendResponse?.({ ok: false, error: `HTTP ${response.status}` });
        return;
      }

      const text = await response.text();
      const senderTabId = sender.tab?.id ?? null;
      const context = { href: `manual-fetch:${url}`, isTop: false };

      await applyIncomingState(
        {
          kind: "battle-get-text",
          transport: "manual-fetch:battle-get",
          capturedAt: makeNow(),
          url,
          text
        },
        senderTabId,
        context
      );

      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }

      if (looksLikeBattlePayload(parsed)) {
        await applyIncomingState(
          {
            kind: "battle-get-raw",
            transport: "manual-fetch:battle-get",
            capturedAt: makeNow(),
            url,
            battleId: parsed.Id ?? null,
            seed: parsed.Seed ?? null,
            resolvedOn: parsed.ResolvedOn ?? null,
            payload: parsed
          },
          senderTabId,
          context
        );
      }

      sendResponse?.({
        ok: true,
        payload: {
          url,
          textLength: text.length,
          parsed: Boolean(parsed && typeof parsed === "object")
        }
      });
    })().catch((err) => {
      console.error("Manual battle/get fetch failed:", err);
      sendResponse?.({ ok: false, error: String(err) });
    });

    return true;
  }

  if (message.type === "SAP_POST_ARENA_WATCH") {
    (async () => {
      const url = String(message.url || "").trim();
      if (!isArenaWatchUrl(url) && !isVersusWatchUrl(url)) {
        sendResponse?.({
          ok: false,
          error:
            "URL must start with https://api.teamwood.games/0.45/api/arena/watch or https://api.teamwood.games/0.45/api/versus/watch"
        });
        return;
      }

      const bodyValue = message.body && typeof message.body === "object" ? message.body : {};
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(bodyValue)
      });

      const text = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }

      sendResponse?.({
        ok: response.ok,
        payload: {
          url,
          status: response.status,
          textLength: text.length,
          parsed: Boolean(parsed && typeof parsed === "object"),
          body: bodyValue,
          responseText: text,
          responseJson: parsed
        },
        error: response.ok ? null : `HTTP ${response.status}`
      });
    })().catch((err) => {
      console.error("Manual arena/watch POST failed:", err);
      sendResponse?.({ ok: false, error: String(err) });
    });

    return true;
  }

  if (message.type === "SAP_GET_BATTLE_GET_TEXT_LOG") {
    chrome.storage.local
      .get([BATTLE_GET_TEXT_LOG_KEY])
      .then((result) => {
        sendResponse?.({ ok: true, payload: result[BATTLE_GET_TEXT_LOG_KEY] ?? [] });
      })
      .catch((err) => {
        console.error("Failed to read battle text log:", err);
        sendResponse?.({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "SAP_CLEAR_BATTLE_GET_HISTORY") {
    chrome.storage.local
      .set({ [BATTLE_GET_HISTORY_KEY]: [], [BATTLE_GET_TEXT_LOG_KEY]: [], [WS_FRAME_LOG_KEY]: [] })
      .then(() => sendResponse?.({ ok: true }))
      .catch((err) => {
        console.error("Failed to clear battle history:", err);
        sendResponse?.({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "SAP_GET_WS_FRAME_LOG") {
    chrome.storage.local
      .get([WS_FRAME_LOG_KEY])
      .then((result) => {
        sendResponse?.({ ok: true, payload: result[WS_FRAME_LOG_KEY] ?? [] });
      })
      .catch((err) => {
        console.error("Failed to read websocket frame log:", err);
        sendResponse?.({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "SAP_GET_ARENA_WATCH_LOG") {
    chrome.storage.local
      .get([ARENA_WATCH_LOG_KEY])
      .then((result) => {
        sendResponse?.({ ok: true, payload: result[ARENA_WATCH_LOG_KEY] ?? [] });
      })
      .catch((err) => {
        console.error("Failed to read arena/watch log:", err);
        sendResponse?.({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "SAP_CLEAR_ARENA_WATCH_LOG") {
    chrome.storage.local
      .set({ [ARENA_WATCH_LOG_KEY]: [] })
      .then(() => sendResponse?.({ ok: true }))
      .catch((err) => {
        console.error("Failed to clear arena/watch log:", err);
        sendResponse?.({ ok: false, error: String(err) });
      });
    return true;
  }

});



