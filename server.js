const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
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

function nowMs() {
  return Date.now();
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

function cleanName(name) {
  const value = String(name || "").trim();
  return value.slice(0, 32) || "Guest";
}

function cleanYoutubeId(youtubeId) {
  const value = String(youtubeId || "").trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(value) ? value : "";
}

function extractYoutubeId(input) {
  const value = String(input || "").trim();

  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return value;
  }

  const patterns = [
    /youtube\.com\/watch\?[^#]*v=([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/
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
  const youtubeId = cleanYoutubeId(payload?.youtubeId) || extractYoutubeId(payload?.url);

  if (!youtubeId) {
    return null;
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    youtubeId,
    title: String(payload?.title || `YouTube video ${youtubeId}`).trim().slice(0, 120),
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
    queueItemId: room.playback.queueItemId,
    positionMs: getCurrentPositionMs(room, serverTime),
    serverTime,
    action: room.playback.action
  };
}

function buildRoomState(room, socket) {
  return {
    code: room.code,
    isHost: room.hostSocketId === socket.id,
    role: room.hostSocketId === socket.id ? "host" : "guest",
    hostToken: room.hostSocketId === socket.id ? room.hostToken : undefined,
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

function createRoom(hostSocketId) {
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
    hostSocketId,
    members: new Set([hostSocketId]),
    queue: [],
    heartbeat,
    cleanupTimer: null,
    playback: {
      youtubeId: null,
      title: "",
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

function leaveCurrentRoom(socket) {
  const room = findRoomBySocket(socket.id);

  if (!room) {
    return;
  }

  room.members.delete(socket.id);
  socket.leave(room.code);

  if (room.hostSocketId === socket.id) {
    room.hostSocketId = null;
    io.to(room.code).emit("room:host-disconnected", { code: room.code });
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
    role,
    isHost: room.hostSocketId === socket.id,
    hostToken: room.hostSocketId === socket.id ? room.hostToken : undefined,
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

  room.playback = {
    youtubeId: item?.youtubeId || room.playback.youtubeId,
    title: item?.title || room.playback.title,
    queueItemId: item?.id || room.playback.queueItemId,
    positionMs: Math.max(0, Number.isFinite(positionMs) ? positionMs : 0),
    startedAtServerTime: action === "PLAY" ? serverTime : room.playback.startedAtServerTime,
    action
  };

  const event = {
    youtubeId: room.playback.youtubeId,
    title: room.playback.title,
    queueItemId: room.playback.queueItemId,
    positionMs: room.playback.positionMs,
    serverTime,
    action
  };

  io.to(room.code).emit("playback:command", event);
  broadcastRoomState(room);
  return event;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
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
    res.json({
      ok: true,
      results: [
        {
          youtubeId: directId,
          title: `YouTube video ${directId}`,
          thumbnail: `https://i.ytimg.com/vi/${directId}/mqdefault.jpg`
        }
      ]
    });
    return;
  }

  if (!process.env.YOUTUBE_API_KEY) {
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

  if (requestedRoomCode && rooms.has(requestedRoomCode)) {
    const room = rooms.get(requestedRoomCode);
    const role = requestedHostToken && requestedHostToken === room.hostToken ? "host" : "guest";
    joinRoom(socket, room, role);
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

    const room = createRoom(socket.id);
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
    const room = rooms.get(roomCode);

    if (!new RegExp(`^\\d{${ROOM_CODE_LENGTH}}$`).test(roomCode) || !room) {
      const error = { ok: false, error: "ROOM_NOT_FOUND" };
      if (typeof ack === "function") ack(error);
      else socket.emit("room:error", error);
      return;
    }

    const role = hostToken && hostToken === room.hostToken ? "host" : "guest";
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
