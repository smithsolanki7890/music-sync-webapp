const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");
const { Server } = require("socket.io");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const [key, ...valueParts] = trimmed.split("=");
    const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");

    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const PORT = process.env.PORT || 3000;
const HEARTBEAT_MS = 5000;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
const ROOM_CODE_LENGTH = 6;
const PLAY_COUNTDOWN_MS = 3000;
const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const YOUTUBE_SEARCH_UNIT_COST = 100;
const YOUTUBE_DAILY_UNIT_LIMIT = Number(process.env.YOUTUBE_DAILY_UNIT_LIMIT || 10000);
const GOOGLE_CLOUD_QUOTA_URL =
  process.env.GOOGLE_CLOUD_QUOTA_URL || "https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || "*",
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();
const youtubeUsage = {
  dateKey: getPacificDateKey(),
  totalSearches: 0,
  apiSearches: 0
};

function nowMs() {
  return Date.now();
}

function getPacificDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value)
  };
}

function getPacificDateKey(date = new Date()) {
  const { year, month, day } = getPacificDateParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const zonedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour === "24" ? "0" : values.hour),
    Number(values.minute),
    Number(values.second)
  );

  return zonedAsUtc - date.getTime();
}

function zonedTimeToUtcMs(year, month, day, hour, minute, second, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  return utcGuess - offset;
}

function getNextPacificMidnightMs(date = new Date()) {
  const { year, month, day } = getPacificDateParts(date);
  const nextDayUtc = new Date(Date.UTC(year, month - 1, day + 1, 12, 0, 0));
  const nextParts = getPacificDateParts(nextDayUtc);

  return zonedTimeToUtcMs(nextParts.year, nextParts.month, nextParts.day, 0, 0, 0, PACIFIC_TIME_ZONE);
}

function refreshYoutubeUsageDay() {
  const dateKey = getPacificDateKey();

  if (youtubeUsage.dateKey !== dateKey) {
    youtubeUsage.dateKey = dateKey;
    youtubeUsage.totalSearches = 0;
    youtubeUsage.apiSearches = 0;
  }
}

function recordYoutubeSearch(usesApi) {
  refreshYoutubeUsageDay();
  youtubeUsage.totalSearches += 1;

  if (usesApi) {
    youtubeUsage.apiSearches += 1;
  }
}

function getAdminMetrics() {
  refreshYoutubeUsageDay();

  const estimatedUnitsUsed = youtubeUsage.apiSearches * YOUTUBE_SEARCH_UNIT_COST;
  const activeRooms = Array.from(rooms.values()).filter((room) => room.members.size > 0).length;

  return {
    dateKey: youtubeUsage.dateKey,
    totalSearchesToday: youtubeUsage.totalSearches,
    apiSearchesToday: youtubeUsage.apiSearches,
    estimatedUnitsUsed,
    dailyUnitLimit: YOUTUBE_DAILY_UNIT_LIMIT,
    unitsRemaining: Math.max(0, YOUTUBE_DAILY_UNIT_LIMIT - estimatedUnitsUsed),
    resetAt: new Date(getNextPacificMidnightMs()).toISOString(),
    activeRooms,
    totalUsersConnected: io.sockets.sockets.size,
    quotaUrl: GOOGLE_CLOUD_QUOTA_URL
  };
}

function safeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireAdmin(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    res.status(503).send("Admin page is disabled. Set ADMIN_PASSWORD in .env and restart the server.");
    return;
  }

  const authHeader = String(req.headers.authorization || "");
  const [scheme, encoded] = authHeader.split(" ");

  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const password = decoded.slice(decoded.indexOf(":") + 1);

    if (safeEqualString(password, adminPassword)) {
      next();
      return;
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Music App Admin", charset="UTF-8"');
  res.status(401).send("Admin password required.");
}

function generateRoomCode() {
  let code;

  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(code));

  return code;
}

function generateHostToken() {
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join("");
}

function cleanRoomPassword(password) {
  return String(password || "").trim().slice(0, 64);
}

function hashRoomPassword(password) {
  const value = cleanRoomPassword(password);
  return value ? crypto.createHash("sha256").update(value).digest("hex") : "";
}

function roomPasswordMatches(room, password) {
  if (!room.passwordHash) {
    return true;
  }

  const givenHash = hashRoomPassword(password);
  return Boolean(givenHash) && safeEqualString(givenHash, room.passwordHash);
}

function cleanName(name) {
  const value = String(name || "").trim();
  return value.slice(0, 32) || "Guest";
}

const YOUTUBE_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

function cleanYoutubeId(youtubeId) {
  const value = String(youtubeId || "").trim();
  return YOUTUBE_ID_PATTERN.test(value) ? value : "";
}

function extractYoutubeId(input) {
  const value = String(input || "").trim();

  if (YOUTUBE_ID_PATTERN.test(value)) {
    return value;
  }

  const patterns = [
    /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/watch\?[^#\s]*v=([a-zA-Z0-9_-]{11})/,
    /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /(?:https?:\/\/)?(?:www\.|m\.)?youtu\.be\/([a-zA-Z0-9_-]{11})(?:[?&].*)?$/,
    /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})(?:[?&].*)?$/
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return "";
}

function makeQueueItem(payload) {
  const youtubeId = extractYoutubeId(payload?.youtubeId) || extractYoutubeId(payload?.url);

  if (!youtubeId) {
    return null;
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    youtubeId,
    title: String(payload?.title || `YouTube video ${youtubeId}`).trim().slice(0, 120),
    artist: String(payload?.artist || "").trim().slice(0, 80),
    thumbnail: String(payload?.thumbnail || `https://i.ytimg.com/vi/${youtubeId}/mqdefault.jpg`).trim()
  };
}

function getCurrentPositionMs(room, atServerTime = nowMs()) {
  if (!room.playback.youtubeId) {
    return 0;
  }

  if (room.playback.action !== "PLAY") {
    return room.playback.positionMs;
  }

  return Math.max(0, room.playback.positionMs + (atServerTime - room.playback.startedAtServerTime));
}

function membersForRoom(room) {
  return Array.from(room.members).map((socketId) => {
    const memberSocket = io.sockets.sockets.get(socketId);
    return {
      socketId,
      name: memberSocket?.data.name || "Guest",
      role: room.hostSocketId === socketId ? "host" : "guest"
    };
  });
}

function buildPlaybackState(room) {
  const serverTime = nowMs();

  return {
    youtubeId: room.playback.youtubeId,
    title: room.playback.title,
    artist: room.playback.artist,
    thumbnail: room.playback.thumbnail,
    queueItemId: room.playback.queueItemId,
    positionMs: getCurrentPositionMs(room, serverTime),
    startedAtServerTime: room.playback.startedAtServerTime,
    serverTime,
    action: room.playback.action
  };
}

function buildRoomState(room, socket) {
  return {
    code: room.code,
    selfSocketId: socket.id,
    isHost: room.hostSocketId === socket.id,
    role: room.hostSocketId === socket.id ? "host" : "guest",
    hostToken: room.hostSocketId === socket.id ? room.hostToken : undefined,
    hasPassword: Boolean(room.passwordHash),
    memberCount: room.members.size,
    members: membersForRoom(room),
    queue: room.queue,
    playback: buildPlaybackState(room)
  };
}

function emitPlaybackState(socket, room) {
  socket.emit("playback:state", buildPlaybackState(room));
  socket.emit("room:state", buildRoomState(room, socket));
}

function broadcastRoomState(room) {
  for (const socketId of room.members) {
    const memberSocket = io.sockets.sockets.get(socketId);
    if (memberSocket) {
      memberSocket.emit("room:state", buildRoomState(room, memberSocket));
    }
  }
}

function createRoom(hostSocketId, password = "") {
  const code = generateRoomCode();
  const heartbeat = setInterval(() => {
    const room = rooms.get(code);

    if (!room) {
      clearInterval(heartbeat);
      return;
    }

    io.to(code).emit("playback:heartbeat", buildPlaybackState(room));
  }, HEARTBEAT_MS);

  const room = {
    code,
    hostToken: generateHostToken(),
    passwordHash: hashRoomPassword(password),
    hostSocketId,
    members: new Set([hostSocketId]),
    queue: [],
    heartbeat,
    cleanupTimer: null,
    playback: {
      youtubeId: null,
      title: "",
      artist: "",
      thumbnail: "",
      queueItemId: null,
      positionMs: 0,
      startedAtServerTime: null,
      action: "IDLE"
    }
  };

  rooms.set(code, room);
  return room;
}

function deleteRoom(code) {
  const room = rooms.get(code);

  if (!room) {
    return;
  }

  clearInterval(room.heartbeat);
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
  }
  rooms.delete(code);
}

function scheduleRoomCleanup(room) {
  if (room.members.size > 0 || room.cleanupTimer) {
    return;
  }

  room.cleanupTimer = setTimeout(() => {
    const latestRoom = rooms.get(room.code);

    if (latestRoom && latestRoom.members.size === 0) {
      deleteRoom(room.code);
    }
  }, EMPTY_ROOM_TTL_MS);
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.members.has(socketId)) {
      return room;
    }
  }

  return null;
}

function requireHost(socket, ack) {
  const room = findRoomBySocket(socket.id);

  if (!room) {
    const error = { ok: false, error: "NOT_IN_ROOM" };
    if (typeof ack === "function") ack(error);
    else socket.emit("room:error", error);
    return null;
  }

  if (room.hostSocketId !== socket.id) {
    const error = { ok: false, error: "HOST_ONLY" };
    if (typeof ack === "function") ack(error);
    else socket.emit("room:error", error);
    return null;
  }

  return room;
}

function assignNextHost(room, previousHostId = "") {
  const nextHostId = Array.from(room.members).find((socketId) => socketId !== previousHostId) || null;
  room.hostSocketId = nextHostId;

  if (!nextHostId) {
    return null;
  }

  const nextSocket = io.sockets.sockets.get(nextHostId);
  if (nextSocket) {
    nextSocket.data.role = "host";
    nextSocket.emit("room:host-assigned", { code: room.code });
  }

  io.to(room.code).emit("room:host-transferred", {
    code: room.code,
    hostSocketId: nextHostId
  });

  return nextHostId;
}

function leaveCurrentRoom(socket) {
  const room = findRoomBySocket(socket.id);

  if (!room) {
    return;
  }

  room.members.delete(socket.id);
  socket.leave(room.code);

  if (room.hostSocketId === socket.id) {
    const nextHostId = assignNextHost(room, socket.id);
    io.to(room.code).emit("room:host-disconnected", {
      code: room.code,
      hostSocketId: nextHostId
    });
  }

  io.to(room.code).emit("room:member-left", {
    code: room.code,
    socketId: socket.id,
    memberCount: room.members.size
  });
  broadcastRoomState(room);
  scheduleRoomCleanup(room);
}

function joinRoom(socket, room, role = "guest") {
  leaveCurrentRoom(socket);

  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }

  socket.join(room.code);
  room.members.add(socket.id);

  if (role === "host") {
    room.hostSocketId = socket.id;
  }

  socket.data.roomCode = room.code;
  socket.data.role = role;

  socket.emit("room:joined", {
    code: room.code,
    selfSocketId: socket.id,
    role,
    isHost: room.hostSocketId === socket.id,
    hostToken: room.hostSocketId === socket.id ? room.hostToken : undefined,
    hasPassword: Boolean(room.passwordHash),
    memberCount: room.members.size,
    members: membersForRoom(room)
  });

  socket.to(room.code).emit("room:member-joined", {
    code: room.code,
    socketId: socket.id,
    name: socket.data.name,
    memberCount: room.members.size
  });

  emitPlaybackState(socket, room);
  broadcastRoomState(room);
}

function setPlayback(room, item, positionMs, action) {
  const serverTime = nowMs();
  const startedAtServerTime = action === "PLAY"
    ? serverTime + PLAY_COUNTDOWN_MS
    : room.playback.startedAtServerTime;

  room.playback = {
    youtubeId: item?.youtubeId || room.playback.youtubeId,
    title: item?.title || room.playback.title,
    artist: item?.artist || room.playback.artist,
    thumbnail: item?.thumbnail || room.playback.thumbnail,
    queueItemId: item?.id || room.playback.queueItemId,
    positionMs: Math.max(0, Number.isFinite(positionMs) ? positionMs : 0),
    startedAtServerTime,
    action
  };

  const event = {
    youtubeId: room.playback.youtubeId,
    title: room.playback.title,
    artist: room.playback.artist,
    thumbnail: room.playback.thumbnail,
    queueItemId: room.playback.queueItemId,
    positionMs: room.playback.positionMs,
    startedAtServerTime: room.playback.startedAtServerTime,
    serverTime,
    action
  };

  io.to(room.code).emit("playback:command", event);
  broadcastRoomState(room);
  return event;
}

function renderAdminPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Music App Admin</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #10131a;
      --panel: #181d27;
      --panel-2: #202735;
      --text: #f6f7fb;
      --muted: #aab3c4;
      --line: #303848;
      --accent: #51d6a6;
      --warn: #ffd166;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }

    main {
      width: min(1100px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 32px 0;
    }

    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 22px;
    }

    h1 {
      margin: 0 0 6px;
      font-size: clamp(1.8rem, 4vw, 3rem);
      line-height: 1;
    }

    p {
      margin: 0;
      color: var(--muted);
    }

    a {
      color: #11151d;
      background: var(--accent);
      border-radius: 8px;
      padding: 11px 14px;
      text-decoration: none;
      font-weight: 800;
      white-space: nowrap;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }

    .metric {
      min-height: 132px;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }

    .label {
      color: var(--muted);
      font-size: 0.82rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .value {
      margin-top: 18px;
      font-size: clamp(2rem, 5vw, 3.4rem);
      font-weight: 900;
      line-height: 0.95;
    }

    .sub {
      margin-top: 12px;
      color: var(--muted);
      font-size: 0.95rem;
    }

    .wide {
      grid-column: span 2;
      background: var(--panel-2);
    }

    .warn {
      color: var(--warn);
    }

    @media (max-width: 820px) {
      header {
        align-items: stretch;
        flex-direction: column;
      }

      a {
        text-align: center;
      }

      .grid {
        grid-template-columns: 1fr;
      }

      .wide {
        grid-column: auto;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Admin</h1>
        <p>Live server usage, reset on the Pacific day.</p>
      </div>
      <a id="quotaLink" href="${GOOGLE_CLOUD_QUOTA_URL}" target="_blank" rel="noopener noreferrer">Open Google Cloud quota</a>
    </header>

    <section class="grid" aria-live="polite">
      <article class="metric">
        <div class="label">Total Searches Today</div>
        <div class="value" id="totalSearches">0</div>
        <div class="sub" id="apiSearches">0 API-backed searches</div>
      </article>

      <article class="metric">
        <div class="label">Estimated Units Used</div>
        <div class="value" id="unitsUsed">0</div>
        <div class="sub">out of <span id="unitLimit">10,000</span></div>
      </article>

      <article class="metric">
        <div class="label">Units Remaining</div>
        <div class="value" id="unitsRemaining">10,000</div>
        <div class="sub">estimated YouTube quota</div>
      </article>

      <article class="metric wide">
        <div class="label">Reset Countdown</div>
        <div class="value" id="resetCountdown">--:--:--</div>
        <div class="sub">to midnight Pacific Time, <span id="resetAt">--</span></div>
      </article>

      <article class="metric">
        <div class="label">Active Rooms</div>
        <div class="value" id="activeRooms">0</div>
        <div class="sub">rooms with connected users</div>
      </article>

      <article class="metric">
        <div class="label">Users Connected</div>
        <div class="value" id="usersConnected">0</div>
        <div class="sub">current Socket.IO connections</div>
      </article>
    </section>
  </main>

  <script>
    const numberFormat = new Intl.NumberFormat();
    let resetAtMs = 0;

    function setText(id, value) {
      document.getElementById(id).textContent = value;
    }

    function formatCountdown(ms) {
      const totalSeconds = Math.max(0, Math.floor(ms / 1000));
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;

      return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
    }

    function updateCountdown() {
      if (!resetAtMs) return;
      setText("resetCountdown", formatCountdown(resetAtMs - Date.now()));
    }

    async function loadMetrics() {
      const response = await fetch("/admin/data", { cache: "no-store" });

      if (!response.ok) {
        throw new Error("Could not load admin metrics");
      }

      const metrics = await response.json();
      resetAtMs = new Date(metrics.resetAt).getTime();

      setText("totalSearches", numberFormat.format(metrics.totalSearchesToday));
      setText("apiSearches", numberFormat.format(metrics.apiSearchesToday) + " API-backed searches");
      setText("unitsUsed", numberFormat.format(metrics.estimatedUnitsUsed));
      setText("unitLimit", numberFormat.format(metrics.dailyUnitLimit));
      setText("unitsRemaining", numberFormat.format(metrics.unitsRemaining));
      setText("activeRooms", numberFormat.format(metrics.activeRooms));
      setText("usersConnected", numberFormat.format(metrics.totalUsersConnected));
      setText("resetAt", new Date(metrics.resetAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));

      const quotaLink = document.getElementById("quotaLink");
      quotaLink.href = metrics.quotaUrl;

      document.getElementById("unitsRemaining").classList.toggle("warn", metrics.unitsRemaining < 1000);
      updateCountdown();
    }

    loadMetrics().catch((error) => {
      setText("resetCountdown", error.message);
    });
    setInterval(loadMetrics, 5000);
    setInterval(updateCountdown, 1000);
  </script>
</body>
</html>`;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/manifest.webmanifest", (req, res) => {
  res.type("application/manifest+json").sendFile(path.join(__dirname, "manifest.webmanifest"));
});

app.get("/sw.js", (req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "sw.js"));
});

app.get("/icon.svg", (req, res) => {
  res.type("image/svg+xml").sendFile(path.join(__dirname, "icon.svg"));
});

app.get("/admin", requireAdmin, (req, res) => {
  res.type("html").send(renderAdminPage());
});

app.get("/admin/data", requireAdmin, (req, res) => {
  res.json(getAdminMetrics());
});

app.get("/health", (req, res) => {
  res.json({ ok: true, serverTime: nowMs(), rooms: rooms.size });
});

app.get("/test", (req, res) => {
  res.json({ serverTime: nowMs() });
});

app.get("/api/youtube/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  const directId = extractYoutubeId(query);

  if (directId) {
    recordYoutubeSearch(false);
    res.json({
      ok: true,
      results: [
        {
          youtubeId: directId,
          title: `YouTube video ${directId}`,
          artist: "",
          thumbnail: `https://i.ytimg.com/vi/${directId}/mqdefault.jpg`
        }
      ]
    });
    return;
  }

  if (!process.env.YOUTUBE_API_KEY) {
    if (query) {
      recordYoutubeSearch(false);
    }

    res.status(501).json({
      ok: false,
      error: "YOUTUBE_API_KEY_REQUIRED",
      message: "Set YOUTUBE_API_KEY to enable keyword search, or paste a YouTube URL/video ID."
    });
    return;
  }

  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    maxResults: "8",
    q: query,
    key: process.env.YOUTUBE_API_KEY
  });

  recordYoutubeSearch(true);

  try {
    const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    const data = await response.json();

    if (!response.ok) {
      res.status(response.status).json({ ok: false, error: "YOUTUBE_SEARCH_FAILED", detail: data });
      return;
    }

    res.json({
      ok: true,
      results: data.items.map((item) => ({
        youtubeId: item.id.videoId,
        title: item.snippet.title,
        artist: item.snippet.channelTitle || "",
        thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || ""
      }))
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: "YOUTUBE_SEARCH_FAILED", message: error.message });
  }
});

app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

app.get("/.well-known/appspecific/com.chrome.devtools.json", (req, res) => {
  res.status(204).end();
});

io.on("connection", (socket) => {
  socket.data.name = cleanName(socket.handshake.auth?.name);

  const requestedRoomCode = String(socket.handshake.auth?.roomCode || "").trim();
  const requestedHostToken = String(socket.handshake.auth?.hostToken || "").trim();
  const requestedRoomPassword = cleanRoomPassword(socket.handshake.auth?.roomPassword);

  if (requestedRoomCode && rooms.has(requestedRoomCode)) {
    const room = rooms.get(requestedRoomCode);
    const role = requestedHostToken && requestedHostToken === room.hostToken ? "host" : "guest";
    if (role === "host" || roomPasswordMatches(room, requestedRoomPassword)) {
      joinRoom(socket, room, role);
    } else {
      socket.emit("room:error", { ok: false, error: "ROOM_PASSWORD_REQUIRED" });
    }
  }

  socket.on("clock:sync", (clientTime, ack) => {
    const payload = {
      clientTime,
      serverTime: nowMs()
    };

    if (typeof ack === "function") {
      ack(payload);
      return;
    }

    socket.emit("clock:sync", payload);
  });

  socket.on("room:create", (request, ack) => {
    socket.data.name = cleanName(request?.name || socket.data.name);

    const existingRoom = findRoomBySocket(socket.id);
    if (existingRoom?.hostSocketId === socket.id) {
      const payload = buildRoomState(existingRoom, socket);
      if (typeof ack === "function") ack({ ok: true, ...payload });
      socket.emit("room:created", payload);
      return;
    }

    leaveCurrentRoom(socket);

    const roomPassword = cleanRoomPassword(request?.roomPassword);
    const room = createRoom(socket.id, roomPassword);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.role = "host";

    const payload = buildRoomState(room, socket);
    socket.emit("room:created", payload);
    emitPlaybackState(socket, room);
    broadcastRoomState(room);
    if (typeof ack === "function") ack({ ok: true, ...payload });
  });

  socket.on("room:join", (request, ack) => {
    socket.data.name = cleanName(request?.name || socket.data.name);
    const roomCode = String(typeof request === "object" ? request?.code : request || "").trim();
    const hostToken = String(typeof request === "object" ? request?.hostToken || "" : "").trim();
    const roomPassword = cleanRoomPassword(typeof request === "object" ? request?.roomPassword : "");
    const room = rooms.get(roomCode);

    if (!new RegExp(`^\\d{${ROOM_CODE_LENGTH}}$`).test(roomCode) || !room) {
      const error = { ok: false, error: "ROOM_NOT_FOUND" };
      if (typeof ack === "function") ack(error);
      else socket.emit("room:error", error);
      return;
    }

    const role = hostToken && hostToken === room.hostToken ? "host" : "guest";
    if (role !== "host" && !roomPasswordMatches(room, roomPassword)) {
      const error = { ok: false, error: "ROOM_PASSWORD_REQUIRED" };
      if (typeof ack === "function") ack(error);
      else socket.emit("room:error", error);
      return;
    }

    joinRoom(socket, room, role);

    if (typeof ack === "function") {
      ack({ ok: true, ...buildRoomState(room, socket) });
    }
  });

  socket.on("room:get-state", (ack) => {
    const room = findRoomBySocket(socket.id);
    if (!room) {
      const error = { ok: false, error: "NOT_IN_ROOM" };
      if (typeof ack === "function") ack(error);
      else socket.emit("room:error", error);
      return;
    }

    const state = buildRoomState(room, socket);
    if (typeof ack === "function") ack({ ok: true, ...state });
    else socket.emit("room:state", state);
  });

  socket.on("room:transfer-host", (request = {}, ack) => {
    const room = requireHost(socket, ack);
    if (!room) return;

    const targetSocketId = String(request.targetSocketId || "");
    const targetSocket = io.sockets.sockets.get(targetSocketId);

    if (!targetSocketId || !room.members.has(targetSocketId) || !targetSocket) {
      const error = { ok: false, error: "MEMBER_NOT_FOUND" };
      if (typeof ack === "function") ack(error);
      else socket.emit("room:error", error);
      return;
    }

    room.hostSocketId = targetSocketId;
    socket.data.role = "guest";
    targetSocket.data.role = "host";
    targetSocket.emit("room:host-assigned", { code: room.code });
    io.to(room.code).emit("room:host-transferred", {
      code: room.code,
      hostSocketId: targetSocketId
    });
    broadcastRoomState(room);

    if (typeof ack === "function") {
      ack({ ok: true, ...buildRoomState(room, socket) });
    }
  });

  socket.on("queue:add", (payload = {}, ack) => {
    const room = requireHost(socket, ack);
    if (!room) return;

    const item = makeQueueItem(payload);
    if (!item) {
      const error = { ok: false, error: "YOUTUBE_ID_REQUIRED" };
      if (typeof ack === "function") ack(error);
      else socket.emit("queue:error", error);
      return;
    }

    room.queue.push(item);
    broadcastRoomState(room);
    if (typeof ack === "function") ack({ ok: true, item, queue: room.queue });
  });

  socket.on("queue:remove", (payload = {}, ack) => {
    const room = requireHost(socket, ack);
    if (!room) return;

    const itemId = String(payload.itemId || "");
    room.queue = room.queue.filter((item) => item.id !== itemId);
    broadcastRoomState(room);
    if (typeof ack === "function") ack({ ok: true, queue: room.queue });
  });

  socket.on("queue:play", (payload = {}, ack) => {
    const room = requireHost(socket, ack);
    if (!room) return;

    const item = room.queue.find((queueItem) => queueItem.id === payload.itemId) || makeQueueItem(payload);
    if (!item) {
      const error = { ok: false, error: "QUEUE_ITEM_NOT_FOUND" };
      if (typeof ack === "function") ack(error);
      else socket.emit("playback:error", error);
      return;
    }

    if (!room.queue.some((queueItem) => queueItem.id === item.id)) {
      room.queue.push(item);
    }

    const event = setPlayback(room, item, Number(payload.positionMs || 0), "PLAY");
    if (typeof ack === "function") ack({ ok: true, ...event });
  });

  socket.on("playback:play", (payload = {}, ack) => {
    const room = requireHost(socket, ack);
    if (!room) return;

    const item = room.queue.find((queueItem) => queueItem.id === payload.itemId) || makeQueueItem(payload);
    if (!item) {
      const error = { ok: false, error: "YOUTUBE_ID_REQUIRED" };
      if (typeof ack === "function") ack(error);
      else socket.emit("playback:error", error);
      return;
    }

    if (!room.queue.some((queueItem) => queueItem.id === item.id)) {
      room.queue.push(item);
    }

    const event = setPlayback(room, item, Number(payload.positionMs || 0), "PLAY");
    if (typeof ack === "function") ack({ ok: true, ...event });
  });

  socket.on("playback:pause", (payload = {}, ack) => {
    const room = requireHost(socket, ack);
    if (!room) return;

    const currentPosition = Number.isFinite(Number(payload.positionMs))
      ? Number(payload.positionMs)
      : getCurrentPositionMs(room);
    const event = setPlayback(room, null, currentPosition, "PAUSE");
    if (typeof ack === "function") ack({ ok: true, ...event });
  });

  socket.on("playback:skip", (payload = {}, ack) => {
    const room = requireHost(socket, ack);
    if (!room) return;

    const currentIndex = room.queue.findIndex((item) => item.id === room.playback.queueItemId);
    const nextItem = room.queue[currentIndex + 1] || room.queue[0];

    if (!nextItem) {
      const error = { ok: false, error: "QUEUE_EMPTY" };
      if (typeof ack === "function") ack(error);
      else socket.emit("playback:error", error);
      return;
    }

    const event = setPlayback(room, nextItem, Number(payload.positionMs || 0), "PLAY");
    if (typeof ack === "function") ack({ ok: true, ...event });
  });

  socket.on("playback:get-state", (ack) => {
    const room = findRoomBySocket(socket.id);

    if (!room) {
      const error = { ok: false, error: "NOT_IN_ROOM" };
      if (typeof ack === "function") ack(error);
      else socket.emit("playback:error", error);
      return;
    }

    const state = buildPlaybackState(room);
    if (typeof ack === "function") ack({ ok: true, ...state });
    else socket.emit("playback:state", state);
  });

  socket.on("reaction:send", (payload = {}, ack) => {
    const room = findRoomBySocket(socket.id);
    if (!room) {
      const error = { ok: false, error: "NOT_IN_ROOM" };
      if (typeof ack === "function") ack(error);
      else socket.emit("reaction:error", error);
      return;
    }

    const emoji = String(payload.emoji || "").trim().slice(0, 8);
    if (!emoji) {
      const error = { ok: false, error: "EMOJI_REQUIRED" };
      if (typeof ack === "function") ack(error);
      else socket.emit("reaction:error", error);
      return;
    }

    const reaction = {
      emoji,
      name: socket.data.name || "Guest",
      serverTime: nowMs()
    };

    io.to(room.code).emit("reaction", reaction);
    if (typeof ack === "function") ack({ ok: true, ...reaction });
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Sync music server listening on port ${PORT}`);
});
