(function installSapHook() {
  const eventName = document.currentScript?.dataset?.eventName || "sap-live-play";
  const commandEventName = `${eventName}:command`;
  const resultEventName = `${eventName}:result`;
  const baseJsonParse = JSON.parse.bind(JSON);

  const SIGNAL_KEYS = [
    "friends",
    "team",
    "board",
    "shop",
    "pet",
    "pets",
    "attack",
    "health",
    "atk",
    "hp",
    "level",
    "tier",
    "experience",
    "exp",
    "round",
    "turn",
    "gold",
    "lives",
    "wins",
    "userboard",
    "opponentboard",
    "mins",
    "mish"
  ];

  const BATTLE_SEED_REGEX =
    /Battle Starting:\s*master seed\s*(-?\d+),\s*player seed:\s*(-?\d+),\s*opponent seed:\s*(-?\d+)/i;
  const BATTLE_COMPLETE_REGEX =
    /Battle completed,\s*outcome:\s*([^,]+),\s*masterSeed:\s*(-?\d+),\s*end result:\s*(-?\d+)/i;
  const BATTLE_GET_URL_PART = "/api/battle/get/";
  const BATTLE_GET_API_PREFIX = "https://api.teamwood.games/0.45/api/battle/get/";
  const ARENA_WATCH_URL_PART = "/api/arena/watch";
  const ARENA_WATCH_API_PREFIX = "https://api.teamwood.games/0.45/api/arena/watch";
  const VERSUS_WATCH_URL_PART = "/api/versus/watch";
  const VERSUS_WATCH_API_PREFIX = "https://api.teamwood.games/0.45/api/versus/watch";

  const SNAPSHOT_DEDUPE_WINDOW_MS = 1200;
  let lastSnapshotFingerprint = "";
  let lastSnapshotAt = 0;
  const seenBattleGetKeys = new Set();
  let lastBattleGetRequestTemplate = null;

  function emit(detail) {
    window.dispatchEvent(new CustomEvent(eventName, { detail }));
  }

  function emitResult(detail) {
    window.dispatchEvent(new CustomEvent(resultEventName, { detail }));
  }

  function safeJsonParse(value) {
    if (typeof value !== "string") {
      return null;
    }

    try {
      return baseJsonParse(value);
    } catch {
      return null;
    }
  }

  function maybeExtractJsonChunk(text) {
    if (typeof text !== "string") {
      return null;
    }

    const parsed = safeJsonParse(text);
    if (parsed) {
      return parsed;
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
      const chunkParsed = safeJsonParse(chunk);
      if (chunkParsed) {
        return chunkParsed;
      }
    }

    return null;
  }

  function isBattleGetPayload(value) {
    return Boolean(value && typeof value === "object" && value.UserBoard && value.OpponentBoard && value.Id);
  }

  function battleGetKey(payload) {
    return `${payload?.Id ?? "unknown"}:${payload?.ResolvedOn ?? ""}:${payload?.EndResult ?? ""}`;
  }

  function emitBattleGetText(text, transport, urlHint) {
    if (typeof text !== "string" || text.length === 0) {
      return;
    }

    const capturedAt = Date.now();
    emit({
      kind: "battle-get-text",
      transport,
      capturedAt,
      url: urlHint || null,
      text
    });

    console.info("[SAP_LIVE_PLAY][battle/get/text]", {
      url: urlHint || null,
      textLength: text.length,
      text
    });
  }

  function captureBattleGetPayload(payload, transport, urlHint) {
    if (!isBattleGetPayload(payload)) {
      return;
    }

    const key = battleGetKey(payload);
    if (seenBattleGetKeys.has(key)) {
      return;
    }

    seenBattleGetKeys.add(key);
    if (seenBattleGetKeys.size > 300) {
      seenBattleGetKeys.clear();
      seenBattleGetKeys.add(key);
    }

    const capturedAt = Date.now();
    emit({
      kind: "battle-get-raw",
      transport,
      capturedAt,
      url: urlHint || null,
      battleId: payload.Id ?? null,
      seed: payload.Seed ?? null,
      resolvedOn: payload.ResolvedOn ?? null,
      payload
    });

    console.info("[SAP_LIVE_PLAY][battle/get]", {
      url: urlHint || null,
      battleId: payload.Id ?? null,
      seed: payload.Seed ?? null,
      resolvedOn: payload.ResolvedOn ?? null,
      payload
    });
  }

  function scoreObject(obj) {
    let score = 0;
    for (const key of Object.keys(obj)) {
      if (SIGNAL_KEYS.includes(key.toLowerCase())) {
        score += 1;
      }
    }
    return score;
  }

  function selectBestCandidate(value, path = "$", best = { score: -1, path: "$", value: null }) {
    if (value === null || value === undefined) {
      return best;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        best = selectBestCandidate(value[i], `${path}[${i}]`, best);
      }
      return best;
    }

    if (typeof value === "object") {
      const score = scoreObject(value);
      if (score > best.score) {
        best = { score, path, value };
      }

      for (const [k, v] of Object.entries(value)) {
        best = selectBestCandidate(v, `${path}.${k}`, best);
      }
    }

    return best;
  }

  function outcomeToText(outcome) {
    if (outcome === 1) return "PlayerWon";
    if (outcome === 0) return "Draw";
    if (outcome === 2) return "PlayerLost";
    return String(outcome ?? "Unknown");
  }

  function normalizeUnit(item, fallbackSlot) {
    if (!item || typeof item !== "object") {
      return null;
    }

    const permanentAttack = Number(item.At?.Perm ?? item.attack ?? item.atk ?? 0);
    const tempAttack = Number(item.At?.Temp ?? 0);
    const permanentHealth = Number(item.Hp?.Perm ?? item.health ?? item.hp ?? 0);
    const tempHealth = Number(item.Hp?.Temp ?? 0);
    const x = Number(item.Poi?.x ?? fallbackSlot - 1);

    const attack = Number.isFinite(permanentAttack + tempAttack) ? permanentAttack + tempAttack : 0;
    const health = Number.isFinite(permanentHealth + tempHealth) ? permanentHealth + tempHealth : 0;
    const level = Number(item.Lvl ?? item.level ?? 1);
    const exp = Number(item.Exp ?? item.experience ?? 0);
    const enu = item.Enu ?? item.enu ?? null;

    return {
      slot: Number.isFinite(x) ? x + 1 : fallbackSlot,
      name: item.Name || item.name || item.pet || (enu !== null ? `enu_${enu}` : `slot_${fallbackSlot}`),
      attack,
      health,
      level: Number.isFinite(level) ? level : 1,
      experience: Number.isFinite(exp) ? exp : 0,
      enu
    };
  }

  function normalizeUnitsFromItems(items) {
    if (!Array.isArray(items)) {
      return [];
    }

    return items
      .map((item, index) => normalizeUnit(item, index + 1))
      .filter(Boolean)
      .sort((a, b) => a.slot - b.slot)
      .map((pet, index) => ({ ...pet, slot: index + 1 }));
  }

  function normalizePets(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item, index) => {
        if (!item || typeof item !== "object") {
          return null;
        }

        const stats = item.stats && typeof item.stats === "object" ? item.stats : {};
        const name = item.name || item.pet || item.id || item.type || `slot_${index + 1}`;
        const attack = Number(item.attack ?? item.atk ?? item.a ?? stats.attack ?? stats.atk ?? 0);
        const health = Number(item.health ?? item.hp ?? item.h ?? stats.health ?? stats.hp ?? 0);
        const level = Number(item.level ?? item.lvl ?? stats.level ?? 1);
        const exp = Number(item.experience ?? item.exp ?? stats.experience ?? stats.exp ?? 0);

        return {
          slot: index + 1,
          name: String(name),
          attack: Number.isFinite(attack) ? attack : 0,
          health: Number.isFinite(health) ? health : 0,
          level: Number.isFinite(level) ? level : 1,
          experience: Number.isFinite(exp) ? exp : 0
        };
      })
      .filter(Boolean);
  }

  function firstNonEmptyPets(...values) {
    for (const value of values) {
      const pets = normalizePets(value);
      if (pets.length > 0) {
        return pets;
      }
    }
    return [];
  }

  function normalizeBattleBoard(board) {
    if (!board || typeof board !== "object") {
      return { team: [], shop: [] };
    }

    const team = normalizeUnitsFromItems(board.Mins?.Items ?? []);
    const shop = normalizeUnitsFromItems(board.MiSh ?? []);

    return {
      team,
      shop,
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

  function normalizeBattleApiSnapshot(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    if (!payload.UserBoard || !payload.OpponentBoard) {
      return null;
    }

    const userBoard = normalizeBattleBoard(payload.UserBoard);
    const opponentBoard = normalizeBattleBoard(payload.OpponentBoard);

    if (userBoard.team.length === 0 && userBoard.shop.length === 0) {
      return null;
    }

    return {
      capturedAt: Date.now(),
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
      rawHintKeys: Object.keys(payload),
      scalarFields: {
        ...userBoard.meta,
        opponentTurn: opponentBoard.meta.turn,
        opponentWins: opponentBoard.meta.wins,
        opponentLosses: opponentBoard.meta.losses,
        userName: payload.User?.DisplayName ?? null,
        opponentName: payload.Opponent?.DisplayName ?? null
      },
      teamSize: userBoard.team.length,
      shopSize: userBoard.shop.length
    };
  }

  function normalizeCompactBoardSnapshot(source, sourcePath, rootPayload = null) {
    if (!source || typeof source !== "object") {
      return null;
    }

    const hasBoardArrays = Array.isArray(source.Mins?.Items) || Array.isArray(source.MiSh);
    if (!hasBoardArrays) {
      return null;
    }

    const userBoard = normalizeBattleBoard(source);
    if (userBoard.team.length === 0 && userBoard.shop.length === 0) {
      return null;
    }

    const opponentSource = rootPayload?.OpponentBoard;
    const opponentBoard = normalizeBattleBoard(opponentSource);

    return {
      capturedAt: Date.now(),
      sourcePath: sourcePath || "$",
      sourceType: "compact-board",
      battleId: rootPayload?.Id ?? null,
      battleSeed: rootPayload?.Seed ?? null,
      battleOutcome: rootPayload ? outcomeToText(rootPayload.Outcome) : null,
      battleEndResult: rootPayload?.EndResult ?? null,
      resolvedOn: rootPayload?.ResolvedOn ?? null,
      team: userBoard.team,
      shop: userBoard.shop,
      opponentTeam: opponentBoard.team,
      opponentShop: opponentBoard.shop,
      rawHintKeys: Object.keys(source),
      scalarFields: {
        ...userBoard.meta,
        opponentTurn: opponentBoard.meta.turn ?? null,
        opponentWins: opponentBoard.meta.wins ?? null,
        opponentLosses: opponentBoard.meta.losses ?? null
      },
      teamSize: userBoard.team.length,
      shopSize: userBoard.shop.length
    };
  }

  function pickScalarDebugFields(source) {
    const fields = ["round", "turn", "gold", "lives", "wins", "stage", "state"];
    const result = {};
    for (const key of fields) {
      const value = source[key];
      const valueType = typeof value;
      if (valueType === "string" || valueType === "number" || valueType === "boolean") {
        result[key] = value;
      }
    }
    return result;
  }

  function normalizeGenericSnapshot(data) {
    const candidate = selectBestCandidate(data);
    const source = candidate.value || {};

    const compact =
      normalizeCompactBoardSnapshot(source, candidate.path, data) ||
      normalizeCompactBoardSnapshot(data?.UserBoard, "$.UserBoard", data) ||
      normalizeCompactBoardSnapshot(data, "$", data);
    if (compact) {
      return compact;
    }

    const team = firstNonEmptyPets(source.team, source.friends, source.board, source.pets);
    const shop = firstNonEmptyPets(source.shop, source.shopPets, source.shop_pets);

    if (team.length === 0 && shop.length === 0) {
      return null;
    }

    return {
      capturedAt: Date.now(),
      sourcePath: candidate.path,
      sourceType: "generic",
      team,
      shop,
      rawHintKeys: Object.keys(source),
      scalarFields: pickScalarDebugFields(source),
      teamSize: team.length,
      shopSize: shop.length
    };
  }

  function normalizeSnapshot(data) {
    return normalizeBattleApiSnapshot(data) || normalizeGenericSnapshot(data);
  }

  function snapshotFingerprint(snapshot) {
    const teamSig = (snapshot.team || [])
      .map((p) => `${p.name}:${p.attack}:${p.health}:${p.level}:${p.experience}`)
      .join("|");
    const oppSig = (snapshot.opponentTeam || [])
      .map((p) => `${p.name}:${p.attack}:${p.health}:${p.level}:${p.experience}`)
      .join("|");
    return `${snapshot.sourceType || "?"}:${snapshot.sourcePath || "?"}:${snapshot.battleId || "?"}:${teamSig}:${oppSig}`;
  }

  function emitSnapshotIfAny(parsed, transport) {
    if (!parsed) {
      return;
    }

    const normalized = normalizeSnapshot(parsed);
    if (!normalized) {
      return;
    }

    const now = Date.now();
    const fingerprint = snapshotFingerprint(normalized);
    if (fingerprint === lastSnapshotFingerprint && now - lastSnapshotAt < SNAPSHOT_DEDUPE_WINDOW_MS) {
      return;
    }

    lastSnapshotFingerprint = fingerprint;
    lastSnapshotAt = now;

    emit({
      kind: "snapshot",
      transport,
      snapshot: normalized
    });

    if (normalized.battleSeed !== null && normalized.battleSeed !== undefined) {
      emit({
        kind: "battle-seeds",
        transport: `${transport}:battle-api`,
        capturedAt: now,
        message: "Battle seeds from /api/battle/get response",
        seeds: {
          master: Number(normalized.battleSeed),
          player: null,
          opponent: null
        }
      });
    }
  }

  function handlePossiblyJsonText(text, transport, urlHint = null, forceBattleGetText = false) {
    if (forceBattleGetText) {
      emitBattleGetText(text, transport, urlHint);
    }

    const parsed = maybeExtractJsonChunk(text);
    if (isBattleGetPayload(parsed)) {
      captureBattleGetPayload(parsed, transport, urlHint);
    }
    emitSnapshotIfAny(parsed, transport);
  }

  function handleArbitraryData(value, transport) {
    if (value === null || value === undefined) {
      return;
    }

    if (typeof value === "string") {
      handlePossiblyJsonText(value, transport);
      return;
    }

    if (typeof value === "object") {
      if (isBattleGetPayload(value)) {
        captureBattleGetPayload(value, transport, null);
      }
      emitSnapshotIfAny(value, transport);
    }
  }

  async function handleBinaryWsData(data) {
    try {
      if (data instanceof Blob) {
        const text = await data.text();
        handlePossiblyJsonText(text, "websocket-blob");
        return;
      }

      if (data instanceof ArrayBuffer) {
        const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
        handlePossiblyJsonText(text, "websocket-arraybuffer");
      }
    } catch {
      // Non-text binary payloads are expected from some game transports.
    }
  }

  function processConsoleText(text) {
    if (typeof text !== "string") {
      return;
    }

    if (text.toLowerCase().includes("abort all requests")) {
      emit({
        kind: "abort-all-requests",
        transport: "console",
        capturedAt: Date.now(),
        message: text
      });
    }

    const seedMatch = text.match(BATTLE_SEED_REGEX);
    if (seedMatch) {
      emit({
        kind: "battle-seeds",
        transport: "console",
        capturedAt: Date.now(),
        message: text,
        seeds: {
          master: Number(seedMatch[1]),
          player: Number(seedMatch[2]),
          opponent: Number(seedMatch[3])
        }
      });
    }

    const completeMatch = text.match(BATTLE_COMPLETE_REGEX);
    if (completeMatch) {
      emit({
        kind: "battle-complete",
        transport: "console",
        capturedAt: Date.now(),
        message: text,
        outcome: completeMatch[1].trim(),
        masterSeed: Number(completeMatch[2]),
        endResult: Number(completeMatch[3])
      });
    }

    if (text.includes("Load battle because new was found")) {
      emit({
        kind: "battle-start",
        transport: "console",
        message: text,
        capturedAt: Date.now()
      });
    }
  }

  function patchConsoleMethod(name) {
    const original = console[name];
    if (typeof original !== "function") {
      return;
    }

    console[name] = function patchedConsoleMethod(...args) {
      try {
        const text = args.map((arg) => String(arg)).join(" ");
        processConsoleText(text);

        for (const arg of args) {
          if (arg && typeof arg === "object") {
            handleArbitraryData(arg, `console-${name}-object`);
          }
        }
      } catch {
        // Ignore console formatting edge cases.
      }

      return original.apply(this, args);
    };
  }

  patchConsoleMethod("log");
  patchConsoleMethod("info");
  patchConsoleMethod("debug");

  const OriginalWS = window.WebSocket;
  window.WebSocket = class extends OriginalWS {
    constructor(url, protocols) {
      super(url, protocols);
      this.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          handlePossiblyJsonText(event.data, "websocket");
          return;
        }

        if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
          void handleBinaryWsData(event.data);
        }
      });
    }
  };

  function isBattleGetUrl(url) {
    const value = String(url || "");
    return value.startsWith(BATTLE_GET_API_PREFIX) || value.includes(BATTLE_GET_URL_PART);
  }

  function isArenaWatchUrl(url) {
    const value = String(url || "");
    return value.startsWith(ARENA_WATCH_API_PREFIX) || value.includes(ARENA_WATCH_URL_PART);
  }

  function isVersusWatchUrl(url) {
    const value = String(url || "");
    return value.startsWith(VERSUS_WATCH_API_PREFIX) || value.includes(VERSUS_WATCH_URL_PART);
  }

  function fetchUrl(args) {
    const req = args[0];
    if (typeof req === "string") return req;
    if (req && typeof req.url === "string") return req.url;
    return "";
  }

  async function bodyToText(body) {
    if (body === undefined || body === null) {
      return "";
    }

    if (typeof body === "string") {
      return body;
    }

    if (body instanceof URLSearchParams) {
      return body.toString();
    }

    if (body instanceof FormData) {
      const out = {};
      for (const [key, value] of body.entries()) {
        out[key] = typeof value === "string" ? value : "[blob]";
      }
      return JSON.stringify(out);
    }

    if (body instanceof Blob) {
      return await body.text();
    }

    if (body instanceof ArrayBuffer) {
      return new TextDecoder("utf-8", { fatal: false }).decode(body);
    }

    if (ArrayBuffer.isView(body)) {
      return new TextDecoder("utf-8", { fatal: false }).decode(body);
    }

    if (typeof body === "object") {
      try {
        return JSON.stringify(body);
      } catch {
        return String(body);
      }
    }

    return String(body);
  }

  async function extractRequestBodyText(args) {
    const req = args[0];
    const init = args[1] && typeof args[1] === "object" ? args[1] : null;

    if (init && Object.prototype.hasOwnProperty.call(init, "body")) {
      return bodyToText(init.body);
    }

    if (req instanceof Request) {
      try {
        const clone = req.clone();
        return await clone.text();
      } catch {
        return "";
      }
    }

    return "";
  }

  function headersToObject(headersLike) {
    const out = {};
    if (!headersLike) {
      return out;
    }

    if (headersLike instanceof Headers) {
      headersLike.forEach((value, key) => {
        out[String(key)] = String(value);
      });
      return out;
    }

    if (Array.isArray(headersLike)) {
      for (const pair of headersLike) {
        if (Array.isArray(pair) && pair.length >= 2) {
          out[String(pair[0])] = String(pair[1]);
        }
      }
      return out;
    }

    if (typeof headersLike === "object") {
      for (const [key, value] of Object.entries(headersLike)) {
        if (value !== undefined && value !== null) {
          out[String(key)] = String(value);
        }
      }
    }

    return out;
  }

  function extractArenaParticipationId(rawBodyText) {
    const text = String(rawBodyText || "").trim();
    if (!text) {
      return "";
    }

    const parsed = safeJsonParse(text);
    if (parsed && typeof parsed === "object") {
      const fromJson =
        parsed.Pid ??
        parsed.pid ??
        parsed.ParticipationId ??
        parsed.participationId ??
        parsed.ParticipationID ??
        parsed.participationID;
      if (typeof fromJson === "string" && fromJson.trim()) {
        return fromJson.trim();
      }
    }

    const decoded = (() => {
      try {
        return decodeURIComponent(text);
      } catch {
        return text;
      }
    })();

    const keyMatch = decoded.match(
      /(?:^|[?&,\s"'])((?:pid)|(?:participationid)|(?:participation_id))[:=]\s*["']?([0-9a-fA-F-]{36})/i
    );
    if (keyMatch?.[2]) {
      return keyMatch[2];
    }

    const uuidMatch = decoded.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (uuidMatch?.[0]) {
      return uuidMatch[0];
    }

    return "";
  }

  function normalizeArenaWatchBodyText(rawBodyText) {
    const payload = {
      Pid: extractArenaParticipationId(rawBodyText),
      T: 1
    };
    return JSON.stringify(payload);
  }

  function captureBattleGetRequestTemplate(args) {
    const req = args[0];
    const init = args[1] && typeof args[1] === "object" ? args[1] : null;

    const requestHeaders = req && typeof req === "object" ? headersToObject(req.headers) : {};
    const initHeaders = headersToObject(init?.headers);
    const headers = { ...requestHeaders, ...initHeaders };

    const method = String(init?.method || req?.method || "GET").toUpperCase();
    const credentials = init?.credentials || req?.credentials || "include";

    lastBattleGetRequestTemplate = {
      method,
      credentials,
      headers
    };
  }

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(...args) {
    const reqUrl = fetchUrl(args);
    if (isBattleGetUrl(reqUrl)) {
      captureBattleGetRequestTemplate(args);
    }
    const arenaWatchRequest = isArenaWatchUrl(reqUrl);
    const versusWatchRequest = isVersusWatchUrl(reqUrl);
    if (arenaWatchRequest || versusWatchRequest) {
      try {
        const bodyText = normalizeArenaWatchBodyText(await extractRequestBodyText(args));
        const watchType = arenaWatchRequest ? "arena" : "versus";
        emit({
          kind: `${watchType}-watch-post`,
          capturedAt: Date.now(),
          bodyText
        });
      } catch {
        // Ignore body extraction failures and keep request flowing.
      }
    }

    const response = await originalFetch.apply(this, args);
    const responseUrl = response.url || "";
    const urlForCapture = reqUrl || responseUrl;
    const isBattleGet = isBattleGetUrl(reqUrl) || isBattleGetUrl(responseUrl);
    const isArenaWatch = arenaWatchRequest || isArenaWatchUrl(responseUrl);
    const isVersusWatch = versusWatchRequest || isVersusWatchUrl(responseUrl);

    try {
      const clone = response.clone();
      const contentType = clone.headers.get("content-type") || "";
      if (isBattleGet || contentType.includes("application/json") || contentType.includes("text/plain")) {
        const text = await clone.text();
        handlePossiblyJsonText(text, isBattleGet ? "fetch:battle-get" : "fetch", urlForCapture, isBattleGet);
        if (isArenaWatch || isVersusWatch) {
          const watchType = isArenaWatch ? "arena" : "versus";
          emit({
            kind: `${watchType}-watch-response`,
            transport: `fetch:${watchType}-watch`,
            capturedAt: Date.now(),
            url: urlForCapture,
            status: response.status,
            contentType,
            text,
            textLength: text.length
          });
        }
      }
    } catch {
      // Ignore parse failures; we only need opportunistic snapshots.
    }
    return response;
  };

  async function runManualBattleGetFetch(url) {
    const trimmedUrl = String(url || "").trim();
    if (!isBattleGetUrl(trimmedUrl)) {
      throw new Error("URL must start with https://api.teamwood.games/0.45/api/battle/get/");
    }

    const init = {
      method: "GET",
      cache: "no-store",
      credentials: lastBattleGetRequestTemplate?.credentials || "include"
    };

    if (lastBattleGetRequestTemplate?.headers && Object.keys(lastBattleGetRequestTemplate.headers).length > 0) {
      init.headers = { ...lastBattleGetRequestTemplate.headers };
    }

    const response = await originalFetch(trimmedUrl, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    handlePossiblyJsonText(text, "fetch:manual-battle-get", trimmedUrl, true);
    const parsed = maybeExtractJsonChunk(text);
    console.info("[SAP_LIVE_PLAY][manual-fetch][battle/get]", {
      url: trimmedUrl,
      status: response.status,
      textLength: text.length,
      usedCapturedHeaders: Boolean(init.headers),
      parsed
    });

    emitResult({
      kind: "manual-battle-get-fetch-result",
      ok: true,
      url: trimmedUrl,
      status: response.status,
      textLength: text.length,
      usedCapturedHeaders: Boolean(init.headers),
      parsed: Boolean(parsed)
    });
  }

  window.addEventListener(commandEventName, (event) => {
    const detail = event?.detail ?? null;
    if (!detail || detail.type !== "manual-battle-get-fetch") {
      return;
    }

    void runManualBattleGetFetch(detail.url).catch((err) => {
      emitResult({
        kind: "manual-battle-get-fetch-result",
        ok: false,
        url: String(detail.url || ""),
        error: String(err)
      });
      console.error("[SAP_LIVE_PLAY][manual-fetch][battle/get][error]", err);
    });
  });

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    try {
      this.__sapUrl = String(url || "");
      this.__sapMethod = String(method || "GET").toUpperCase();
    } catch {
      this.__sapUrl = "";
      this.__sapMethod = "GET";
    }
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    try {
      const url = String(this.__sapUrl || "");
      const isArenaWatch = isArenaWatchUrl(url);
      const isVersusWatch = isVersusWatchUrl(url);
      if (isArenaWatch || isVersusWatch) {
        const maybeBody = args[0];
        void bodyToText(maybeBody)
          .then((rawBodyText) => {
            const bodyText = normalizeArenaWatchBodyText(rawBodyText);
            const watchType = isArenaWatch ? "arena" : "versus";
            emit({
              kind: `${watchType}-watch-post`,
              capturedAt: Date.now(),
              bodyText
            });
          })
          .catch(() => {});
      }
    } catch {
      // Ignore request body inspection failures.
    }

    this.addEventListener("load", function onLoad() {
      try {
        const contentType = this.getResponseHeader("content-type") || "";
        const url = String(this.__sapUrl || "");
        const isBattleGet = isBattleGetUrl(url);
        const isArenaWatch = isArenaWatchUrl(url);
        const isVersusWatch = isVersusWatchUrl(url);

        if (isBattleGet || contentType.includes("application/json") || contentType.includes("text/plain")) {
          let text = "";

          if (typeof this.responseText === "string" && this.responseText.length > 0) {
            text = this.responseText;
          } else if (typeof this.response === "string") {
            text = this.response;
          } else if (this.response && typeof this.response === "object") {
            try {
              text = JSON.stringify(this.response);
            } catch {
              text = "";
            }
          }

          if (text) {
            handlePossiblyJsonText(text, isBattleGet ? "xhr:battle-get" : "xhr", url, isBattleGet);
            if (isArenaWatch || isVersusWatch) {
              const watchType = isArenaWatch ? "arena" : "versus";
              emit({
                kind: `${watchType}-watch-response`,
                transport: `xhr:${watchType}-watch`,
                capturedAt: Date.now(),
                url,
                status: Number(this.status || 0),
                contentType,
                text,
                textLength: text.length
              });
            }
          }
        }
      } catch {
        // Ignore non-readable response types.
      }
    });

    return originalSend.apply(this, args);
  };

  const originalJsonParse = JSON.parse;
  JSON.parse = function patchedJsonParse(...args) {
    const parsed = originalJsonParse.apply(this, args);
    try {
      handleArbitraryData(parsed, "json-parse");
    } catch {
      // Ignore non-board JSON.
    }
    return parsed;
  };

  const originalPostMessage = window.postMessage;
  window.postMessage = function patchedPostMessage(message, targetOrigin, transfer) {
    try {
      handleArbitraryData(message, "postmessage-out");
    } catch {
      // Ignore cross-origin data issues.
    }

    return originalPostMessage.call(this, message, targetOrigin, transfer);
  };

  window.addEventListener("message", (event) => {
    try {
      handleArbitraryData(event.data, "postmessage-in");
    } catch {
      // Ignore cross-origin message parsing failures.
    }
  });

  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function patchedSetItem(key, value) {
    try {
      if (typeof value === "string" && value.length >= 2 && (value.startsWith("{") || value.startsWith("["))) {
        handlePossiblyJsonText(value, `storage:${key}`);
      }
    } catch {
      // Ignore storage parse failures.
    }

    return originalSetItem.call(this, key, value);
  };
})();







