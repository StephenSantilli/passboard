const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");

const express = require("express");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");
const { v4: uuidv4, validate: isUuid } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"]
  }
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "passwords.db");
const ROOM_HASH_NAMESPACE = "room-hash-v1";
const ROOM_KEY_SALT = "room-key-derivation-v1";
const ROOM_KEY_INFO = "ctf-password-board";
const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROOM_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

app.disable("x-powered-by");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT 'Untitled Board',
    generator_settings TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sort_order REAL NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    port TEXT NOT NULL,
    username TEXT NOT NULL,
    password_cipher TEXT,
    password_iv TEXT,
    password_tag TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS password_history (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    password_cipher TEXT NOT NULL,
    password_iv TEXT NOT NULL,
    password_tag TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_items_room_id ON items(room_id);
  CREATE INDEX IF NOT EXISTS idx_history_item_id ON password_history(item_id);
`);

function addColumnIfMissing(tableName, columnName, definition) {
  const columns = db.pragma(`table_info(${tableName})`);
  const hasColumn = columns.some((column) => column.name === columnName);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

addColumnIfMissing("rooms", "name", "TEXT NOT NULL DEFAULT 'Untitled Board'");
addColumnIfMissing("rooms", "generator_settings", "TEXT NOT NULL DEFAULT '{}'");
addColumnIfMissing("rooms", "updated_at", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("rooms", "updated_by", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("items", "sort_order", "REAL NOT NULL DEFAULT 0");
addColumnIfMissing("items", "updated_by", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("password_history", "created_by", "TEXT NOT NULL DEFAULT ''");

db.exec(`
  UPDATE items
  SET sort_order = rowid
  WHERE sort_order = 0 OR sort_order IS NULL
`);

const insertRoomStmt = db.prepare(`
  INSERT OR IGNORE INTO rooms (id, name, generator_settings, updated_at, updated_by, created_at)
  VALUES (@id, @name, @generatorSettings, @updatedAt, @updatedBy, @createdAt)
`);

const selectRoomStmt = db.prepare(`
  SELECT id, name, generator_settings, updated_at, updated_by, created_at
  FROM rooms
  WHERE id = ?
`);

const deleteRoomStmt = db.prepare(`
  DELETE FROM rooms
  WHERE id = ?
`);

const deleteExpiredRoomsStmt = db.prepare(`
  DELETE FROM rooms
  WHERE created_at < ?
`);

const updateRoomNameStmt = db.prepare(`
  UPDATE rooms
  SET
    name = @name,
    updated_at = @updatedAt,
    updated_by = @updatedBy
  WHERE id = @id
`);

const updateRoomGeneratorSettingsStmt = db.prepare(`
  UPDATE rooms
  SET
    generator_settings = @generatorSettings,
    updated_at = @updatedAt,
    updated_by = @updatedBy
  WHERE id = @id
`);

const selectItemsStmt = db.prepare(`
  SELECT
    i.id,
    i.sort_order,
    i.name,
    i.port,
    i.username,
    i.password_cipher,
    i.password_iv,
    i.password_tag,
    i.created_at,
    i.updated_at,
    i.updated_by,
    (
      SELECT json_group_array(
        json_object(
          'id', ph.id,
          'password_cipher', ph.password_cipher,
          'password_iv', ph.password_iv,
          'password_tag', ph.password_tag,
          'created_at', ph.created_at,
          'created_by', ph.created_by
        )
      )
      FROM password_history ph
      WHERE ph.item_id = i.id
      ORDER BY ph.created_at DESC
    ) AS history_json
  FROM items i
  WHERE i.room_id = ?
  ORDER BY i.sort_order ASC, i.created_at ASC
`);

const insertItemStmt = db.prepare(`
  INSERT INTO items (
    id,
    room_id,
    sort_order,
    name,
    port,
    username,
    password_cipher,
    password_iv,
    password_tag,
    created_at,
    updated_at,
    updated_by
  ) VALUES (
    @id,
    @roomId,
    @sortOrder,
    @name,
    @port,
    @username,
    @passwordCipher,
    @passwordIv,
    @passwordTag,
    @createdAt,
    @updatedAt,
    @updatedBy
  )
`);

const selectItemStmt = db.prepare(`
  SELECT *
  FROM items
  WHERE id = ? AND room_id = ?
`);

const selectMaxSortOrderStmt = db.prepare(`
  SELECT COALESCE(MAX(sort_order), 0) AS maxSortOrder
  FROM items
  WHERE room_id = ?
`);

const updateItemFieldsStmt = db.prepare(`
  UPDATE items
  SET
    name = @name,
    port = @port,
    username = @username,
    updated_at = @updatedAt,
    updated_by = @updatedBy
  WHERE id = @id AND room_id = @roomId
`);

const updateItemPasswordStmt = db.prepare(`
  UPDATE items
  SET
    password_cipher = @passwordCipher,
    password_iv = @passwordIv,
    password_tag = @passwordTag,
    updated_at = @updatedAt,
    updated_by = @updatedBy
  WHERE id = @id AND room_id = @roomId
`);

const deleteItemStmt = db.prepare(`
  DELETE FROM items
  WHERE id = ? AND room_id = ?
`);

const deleteItemsByRoomStmt = db.prepare(`
  DELETE FROM items
  WHERE room_id = ?
`);

const updateItemSortOrderStmt = db.prepare(`
  UPDATE items
  SET sort_order = @sortOrder
  WHERE id = @id AND room_id = @roomId
`);

const insertHistoryStmt = db.prepare(`
  INSERT INTO password_history (
    id,
    item_id,
    room_id,
    password_cipher,
    password_iv,
    password_tag,
    created_at,
    created_by
  ) VALUES (
    @id,
    @itemId,
    @roomId,
    @passwordCipher,
    @passwordIv,
    @passwordTag,
    @createdAt,
    @createdBy
  )
`);

const importRoomState = db.transaction(({ roomId, roomKey, actorName, boardName, generatorSettings, items }) => {
  const updatedAt = nowIso();
  updateRoomNameStmt.run({
    id: roomId,
    name: String(boardName || "Untitled Board").trim().slice(0, 80) || "Untitled Board",
    updatedAt,
    updatedBy: actorName
  });
  updateRoomGeneratorSettingsStmt.run({
    id: roomId,
    generatorSettings: serializeGeneratorSettings(generatorSettings),
    updatedAt,
    updatedBy: actorName
  });

  deleteItemsByRoomStmt.run(roomId);

  items.forEach((item, index) => {
    const createdAt = String(item.createdAt || nowIso());
    const updatedAt = String(item.updatedAt || createdAt);
    const updatedBy = normalizeActorName(item.updatedBy) || actorName;
    const encrypted = encryptPassword(roomKey, String(item.password || ""));
    const sortOrder = Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : index + 1;

    insertItemStmt.run({
      id: uuidv4(),
      roomId,
      sortOrder,
      name: String(item.name || "").trim(),
      port: String(item.port || "").trim(),
      username: String(item.username || "").trim(),
      passwordCipher: encrypted.cipher,
      passwordIv: encrypted.iv,
      passwordTag: encrypted.tag,
      createdAt,
      updatedAt,
      updatedBy
    });

    const insertedItem = db.prepare(`
      SELECT id
      FROM items
      WHERE room_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(roomId);

    const history = Array.isArray(item.history) ? item.history : [];
    history.forEach((entry) => {
      const encryptedHistory = encryptPassword(roomKey, String(entry.password || ""));
      insertHistoryStmt.run({
        id: uuidv4(),
        itemId: insertedItem.id,
        roomId,
        passwordCipher: encryptedHistory.cipher,
        passwordIv: encryptedHistory.iv,
        passwordTag: encryptedHistory.tag,
        createdAt: String(entry.createdAt || updatedAt),
        createdBy: normalizeActorName(entry.createdBy) || updatedBy
      });
    });
  });
});

function normalizeImportedItems(items) {
  if (!Array.isArray(items)) {
    throw new Error("Import file must contain an items array.");
  }

  return items.map((item) => ({
    sortOrder: item?.sortOrder,
    name: String(item?.name || "").trim(),
    port: String(item?.port || "").trim(),
    username: String(item?.username || "").trim(),
    password: String(item?.password || ""),
    createdAt: item?.createdAt,
    updatedAt: item?.updatedAt,
    updatedBy: item?.updatedBy,
    history: Array.isArray(item?.history)
      ? item.history.map((entry) => ({
          password: String(entry?.password || ""),
          createdAt: entry?.createdAt,
          createdBy: entry?.createdBy
        }))
      : []
  }));
}

const reorderItems = db.transaction(({ roomId, orderedIds }) => {
  orderedIds.forEach((id, index) => {
    updateItemSortOrderStmt.run({
      id,
      roomId,
      sortOrder: index + 1
    });
  });
});

function nowIso() {
  return new Date().toISOString();
}

function roomExpiryCutoffIso(referenceTime = Date.now()) {
  return new Date(referenceTime - ROOM_TTL_MS).toISOString();
}

function normalizeGeneratorSettings(settings = {}) {
  const mode = settings?.mode === "words" ? "words" : "random";
  const randomSize = Math.min(64, Math.max(8, Number(settings?.randomSize ?? settings?.size ?? 20) || 20));
  const wordCount = Math.min(8, Math.max(2, Number(settings?.wordCount ?? settings?.size ?? 3) || 3));

  return {
    mode,
    randomSize,
    wordCount,
    separator: String(settings?.separator ?? "-").slice(0, 3) || "-",
    uppercase: settings?.uppercase !== false,
    lowercase: settings?.lowercase !== false,
    numbers: settings?.numbers !== false,
    symbols: settings?.symbols !== false,
    excludeSimilar: settings?.excludeSimilar !== false
  };
}

function serializeGeneratorSettings(settings = {}) {
  return JSON.stringify(normalizeGeneratorSettings(settings));
}

function parseGeneratorSettings(serialized) {
  try {
    return normalizeGeneratorSettings(serialized ? JSON.parse(serialized) : {});
  } catch (_error) {
    return normalizeGeneratorSettings();
  }
}

function isRoomExpired(room, referenceTime = Date.now()) {
  if (!room?.created_at) {
    return false;
  }

  return new Date(room.created_at).getTime() <= referenceTime - ROOM_TTL_MS;
}

function cleanupExpiredRooms(referenceTime = Date.now()) {
  return deleteExpiredRoomsStmt.run(roomExpiryCutoffIso(referenceTime)).changes;
}

function normalizeActorName(name) {
  return String(name || "").trim().slice(0, 40);
}

function ensureRoomKey(roomKey) {
  return typeof roomKey === "string" && isUuid(roomKey);
}

function roomHash(roomKey) {
  return crypto
    .createHash("sha256")
    .update(`${ROOM_HASH_NAMESPACE}:${roomKey}`)
    .digest("hex");
}

function roomLookupId(roomKey) {
  return roomHash(roomKey);
}

function deriveRoomEncryptionKey(roomKey) {
  return crypto.hkdfSync(
    "sha256",
    Buffer.from(roomKey, "utf8"),
    Buffer.from(ROOM_KEY_SALT, "utf8"),
    Buffer.from(ROOM_KEY_INFO, "utf8"),
    32
  );
}

function encryptPassword(roomKey, plaintext) {
  const iv = crypto.randomBytes(12);
  const key = deriveRoomEncryptionKey(roomKey);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return {
    cipher: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64")
  };
}

function decryptPassword(roomKey, payload) {
  if (!payload?.cipher || !payload?.iv || !payload?.tag) {
    return "";
  }

  const key = deriveRoomEncryptionKey(roomKey);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.cipher, "base64")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

function parseHistory(historyJson) {
  if (!historyJson) {
    return [];
  }

  const parsed = JSON.parse(historyJson);
  return Array.isArray(parsed) ? parsed : [];
}

function ensureRoomExists(roomKey) {
  const id = roomLookupId(roomKey);
  const createdAt = nowIso();
  insertRoomStmt.run({
    id,
    name: "Untitled Board",
    generatorSettings: serializeGeneratorSettings(),
    updatedAt: createdAt,
    updatedBy: "",
    createdAt
  });
  return selectRoomStmt.get(id);
}

function getActiveRoom(roomKey) {
  const id = roomLookupId(roomKey);
  const room = selectRoomStmt.get(id);
  if (!room) {
    return null;
  }

  if (isRoomExpired(room)) {
    deleteRoomStmt.run(id);
    return null;
  }

  return room;
}

function requireActiveRoom(roomKey) {
  cleanupExpiredRooms();
  return getActiveRoom(roomKey);
}

function getActiveUsers(roomKey) {
  const room = io.sockets.adapter.rooms.get(roomLookupId(roomKey));
  if (!room) {
    return [];
  }

  const users = new Map();
  room.forEach((socketId) => {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket?.data?.actorName) {
      return;
    }
    users.set(socket.data.actorName, {
      name: socket.data.actorName
    });
  });

  return Array.from(users.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mapRoomState(roomKey) {
  const room = requireActiveRoom(roomKey);
  if (!room) {
    throw new Error("Room not found or has expired.");
  }

  const id = room.id;
  const rows = selectItemsStmt.all(id);

  return {
    roomId: room.id,
    boardName: room.name,
    generatorSettings: parseGeneratorSettings(room.generator_settings),
    boardUpdatedAt: room.updated_at,
    boardUpdatedBy: room.updated_by,
    createdAt: room.created_at,
    activeUsers: getActiveUsers(roomKey),
    items: rows.map((row) => ({
      id: row.id,
      sortOrder: row.sort_order,
      name: row.name,
      port: row.port,
      username: row.username,
      password: decryptPassword(roomKey, {
        cipher: row.password_cipher,
        iv: row.password_iv,
        tag: row.password_tag
      }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      history: parseHistory(row.history_json).map((entry) => ({
        id: entry.id,
        password: decryptPassword(roomKey, {
          cipher: entry.password_cipher,
          iv: entry.password_iv,
          tag: entry.password_tag
        }),
        createdAt: entry.created_at,
        createdBy: entry.created_by
      }))
    }))
  };
}

const setItemPasswordWithHistory = db.transaction(
  ({ itemId, roomId, roomKey, nextPassword, updatedAt, updatedBy }) => {
    const existing = selectItemStmt.get(itemId, roomId);
    if (!existing) {
      throw new Error("Item not found.");
    }

    const currentPassword = decryptPassword(roomKey, {
      cipher: existing.password_cipher,
      iv: existing.password_iv,
      tag: existing.password_tag
    });

    if (currentPassword === nextPassword) {
      updateItemPasswordStmt.run({
        id: itemId,
        roomId,
        passwordCipher: existing.password_cipher,
        passwordIv: existing.password_iv,
        passwordTag: existing.password_tag,
        updatedAt,
        updatedBy
      });
      return;
    }

    if (currentPassword) {
      insertHistoryStmt.run({
        id: uuidv4(),
        itemId,
        roomId,
        passwordCipher: existing.password_cipher,
        passwordIv: existing.password_iv,
        passwordTag: existing.password_tag,
        createdAt: updatedAt,
        createdBy: updatedBy
      });
    }

    const encrypted = encryptPassword(roomKey, nextPassword);
    updateItemPasswordStmt.run({
      id: itemId,
      roomId,
      passwordCipher: encrypted.cipher,
      passwordIv: encrypted.iv,
      passwordTag: encrypted.tag,
      updatedAt,
      updatedBy
    });
  }
);

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "clipboard-read=(), clipboard-write=(self)");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  next();
});
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/rooms/:roomKey/bootstrap", (req, res) => {
  const { roomKey } = req.params;
  if (!ensureRoomKey(roomKey)) {
    return res.status(400).json({ error: "Invalid room key." });
  }

  const room = requireActiveRoom(roomKey);
  if (!room) {
    return res.status(404).json({ error: "Room not found or has expired." });
  }

  return res.json(mapRoomState(roomKey));
});

app.get("/api/rooms/new", (_req, res) => {
  const roomKey = uuidv4();
  ensureRoomExists(roomKey);
  return res.json({ roomKey, url: `/room/${roomKey}` });
});

app.get("/room/:roomKey", (req, res) => {
  if (!ensureRoomKey(req.params.roomKey)) {
    return res.status(400).send("Invalid room key.");
  }

  const room = requireActiveRoom(req.params.roomKey);
  if (!room) {
    return res.status(404).send("Room not found or has expired.");
  }

  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

io.use((socket, next) => {
  const roomKey = socket.handshake.auth?.roomKey;
  const actorName = normalizeActorName(socket.handshake.auth?.actorName);
  if (!ensureRoomKey(roomKey)) {
    return next(new Error("Invalid room key."));
  }
  if (!actorName) {
    return next(new Error("Display name is required."));
  }
  if (!requireActiveRoom(roomKey)) {
    return next(new Error("Room not found or has expired."));
  }

  socket.data.roomKey = roomKey;
  socket.data.roomId = roomLookupId(roomKey);
  socket.data.actorName = actorName;
  return next();
});

function emitRoomState(roomKey) {
  const room = requireActiveRoom(roomKey);
  if (!room) {
    return;
  }

  const state = mapRoomState(roomKey);
  io.to(roomLookupId(roomKey)).emit("room:state", state);
}

io.on("connection", (socket) => {
  const { roomKey, roomId, actorName } = socket.data;
  socket.join(roomId);
  emitRoomState(roomKey);

  socket.on("room:updateName", (payload, callback = () => {}) => {
    try {
      const name = String(payload?.name || "").trim().slice(0, 80) || "Untitled Board";
      updateRoomNameStmt.run({
        id: roomId,
        name,
        updatedAt: nowIso(),
        updatedBy: actorName
      });

      emitRoomState(roomKey);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("room:updateGeneratorSettings", (payload, callback = () => {}) => {
    try {
      updateRoomGeneratorSettingsStmt.run({
        id: roomId,
        generatorSettings: serializeGeneratorSettings(payload?.generatorSettings),
        updatedAt: nowIso(),
        updatedBy: actorName
      });

      emitRoomState(roomKey);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("room:import", (payload, callback = () => {}) => {
    try {
      const normalizedItems = normalizeImportedItems(payload?.items);
      importRoomState({
        roomId,
        roomKey,
        actorName,
        boardName: payload?.boardName,
        generatorSettings: payload?.generatorSettings,
        items: normalizedItems
      });

      emitRoomState(roomKey);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("items:reorder", (payload, callback = () => {}) => {
    try {
      const orderedIds = Array.isArray(payload?.orderedIds)
        ? payload.orderedIds.map((id) => String(id))
        : [];
      const currentIds = mapRoomState(roomKey).items.map((item) => item.id);

      if (
        orderedIds.length !== currentIds.length ||
        orderedIds.some((id) => !currentIds.includes(id))
      ) {
        throw new Error("Reorder payload does not match current board items.");
      }

      reorderItems({
        roomId,
        orderedIds
      });

      emitRoomState(roomKey);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("item:create", (payload, callback = () => {}) => {
    try {
      const createdAt = nowIso();
      const password = String(payload?.password || "");
      const encrypted = encryptPassword(roomKey, password);
      const nextSortOrder = selectMaxSortOrderStmt.get(roomId).maxSortOrder + 1;

      insertItemStmt.run({
        id: uuidv4(),
        roomId,
        sortOrder: nextSortOrder,
        name: String(payload?.name || "").trim(),
        port: String(payload?.port || "").trim(),
        username: String(payload?.username || "").trim(),
        passwordCipher: encrypted.cipher,
        passwordIv: encrypted.iv,
        passwordTag: encrypted.tag,
        createdAt,
        updatedAt: createdAt,
        updatedBy: actorName
      });

      emitRoomState(roomKey);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("item:updateMeta", (payload, callback = () => {}) => {
    try {
      const itemId = String(payload?.id || "");
      updateItemFieldsStmt.run({
        id: itemId,
        roomId,
        name: String(payload?.name || "").trim(),
        port: String(payload?.port || "").trim(),
        username: String(payload?.username || "").trim(),
        updatedAt: nowIso(),
        updatedBy: actorName
      });

      emitRoomState(roomKey);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("item:updatePassword", (payload, callback = () => {}) => {
    try {
      setItemPasswordWithHistory({
        itemId: String(payload?.id || ""),
        roomId,
        roomKey,
        nextPassword: String(payload?.password || ""),
        updatedAt: nowIso(),
        updatedBy: actorName
      });

      emitRoomState(roomKey);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("item:delete", (payload, callback = () => {}) => {
    try {
      deleteItemStmt.run(String(payload?.id || ""), roomId);
      emitRoomState(roomKey);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("disconnect", () => {
    emitRoomState(roomKey);
  });
});

if (require.main === module) {
  cleanupExpiredRooms();
  const cleanupTimer = setInterval(() => {
    cleanupExpiredRooms();
  }, ROOM_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  server.listen(PORT, HOST, () => {
    console.log(`Password board listening on http://${HOST}:${PORT}`);
  });
}

module.exports = {
  app,
  server,
  db,
  ensureRoomExists,
  mapRoomState,
  encryptPassword,
  decryptPassword,
  roomLookupId
};
