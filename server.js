const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");

const express = require("express");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");
const { v4: uuidv4, validate: isUuid } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 576 * 1024,
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
const MAX_BOARD_NAME_LENGTH = 80;
const MAX_ACTOR_NAME_LENGTH = 40;
const MAX_ITEM_NAME_LENGTH = 120;
const MAX_IP_LENGTH = 120;
const MAX_USERNAME_LENGTH = 120;
const MAX_PASSWORD_LENGTH = 512;
const MAX_ITEMS_PER_ROOM = 250;
const MAX_HISTORY_ENTRIES_PER_ITEM = 100;
const MAX_IMPORT_ITEMS = MAX_ITEMS_PER_ROOM;
const MAX_IMPORT_JSON_BYTES = 512 * 1024;
const HTTP_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const HTTP_NEW_ROOM_LIMIT = 20;
const HTTP_BOOTSTRAP_LIMIT = 120;
const SOCKET_CONNECT_WINDOW_MS = 60 * 1000;
const SOCKET_CONNECT_LIMIT = 60;
const SOCKET_IMPORT_WINDOW_MS = 5 * 60 * 1000;
const SOCKET_IMPORT_LIMIT = 5;
const MUTATION_WINDOW_MS = 10 * 1000;
const MUTATION_LIMIT_PER_ACTOR = 40;
const MUTATION_LIMIT_PER_ROOM = 120;

app.disable("x-powered-by");
// Optional: TRUST_PROXY=loopback or a trusted proxy IP/CIDR (never untrusted clients).
if (process.env.TRUST_PROXY) {
  app.set("trust proxy", process.env.TRUST_PROXY);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT 'Untitled Board',
    generator_settings TEXT NOT NULL DEFAULT '{}',
    last_imported_at TEXT NOT NULL DEFAULT '',
    last_imported_by TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sort_order REAL NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    port TEXT NOT NULL,
    username TEXT NOT NULL,
    password_cipher TEXT,
    password_iv TEXT,
    password_tag TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL DEFAULT '',
    password_rotation_count INTEGER NOT NULL DEFAULT 0,
    password_created_at TEXT NOT NULL DEFAULT '',
    password_created_by TEXT NOT NULL DEFAULT '',
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
addColumnIfMissing("rooms", "last_imported_at", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("rooms", "last_imported_by", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("rooms", "updated_at", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("rooms", "updated_by", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("rooms", "revision", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("items", "sort_order", "REAL NOT NULL DEFAULT 0");
addColumnIfMissing("items", "ip", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("items", "created_by", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("items", "updated_by", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("items", "password_rotation_count", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("items", "password_created_at", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("items", "password_created_by", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("password_history", "created_by", "TEXT NOT NULL DEFAULT ''");

// Existing history rows were timestamped when a password was REPLACED.
// Shift their timestamps back to when each password became current, once.
// Future changes save the creation timestamp directly.
const migrateLegacyPasswordDates = db.transaction(() => {
  const oldItems = db.prepare(`
    SELECT id, created_at, created_by, updated_at, updated_by, password_rotation_count
    FROM items WHERE password_created_at = ''
  `).all();
  const getHistory = db.prepare(`
    SELECT id, created_at, created_by FROM password_history
    WHERE item_id = ? ORDER BY created_at ASC, rowid ASC
  `);
  const updateHistory = db.prepare(`
    UPDATE password_history SET created_at = ?, created_by = ? WHERE id = ?
  `);
  const updateItem = db.prepare(`
    UPDATE items SET password_created_at = ?, password_created_by = ? WHERE id = ?
  `);

  for (const item of oldItems) {
    const entries = getHistory.all(item.id);
    if (entries.length) {
      // If older history was trimmed, the creation time of the oldest
      // remaining password cannot be reconstructed exactly.
      const truncated = item.password_rotation_count > entries.length;
      let addedAt = truncated ? entries[0].created_at : item.created_at;
      let addedBy = truncated ? entries[0].created_by : item.created_by;
      for (const entry of entries) {
        updateHistory.run(addedAt, addedBy, entry.id);
        addedAt = entry.created_at;
        addedBy = entry.created_by;
      }
      updateItem.run(addedAt, addedBy, item.id);
    } else {
      // No retained history: original creation is exact for unrotated items.
      // For previously rotated items, the precise date is no longer stored.
      const rotated = item.password_rotation_count > 0;
      updateItem.run(
        rotated ? item.updated_at : item.created_at,
        rotated ? item.updated_by : item.created_by,
        item.id
      );
    }
  }
});
migrateLegacyPasswordDates();

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
  SELECT id, name, generator_settings, last_imported_at, last_imported_by, updated_at, updated_by, revision, created_at
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

const touchRoomChangeStmt = db.prepare(`
  UPDATE rooms SET updated_at = ?, updated_by = ?, revision = revision + 1 WHERE id = ?
`);

const updateRoomNameStmt = db.prepare(`
  UPDATE rooms
  SET
    name = @name,
    updated_at = @updatedAt,
    updated_by = @updatedBy,
    revision = revision + 1
  WHERE id = @id
`);

const updateRoomGeneratorSettingsStmt = db.prepare(`
  UPDATE rooms
  SET
    generator_settings = @generatorSettings,
    updated_at = @updatedAt,
    updated_by = @updatedBy,
    revision = revision + 1
  WHERE id = @id
`);

const updateRoomImportAuditStmt = db.prepare(`
  UPDATE rooms
  SET
    last_imported_at = @lastImportedAt,
    last_imported_by = @lastImportedBy,
    updated_at = @updatedAt,
    updated_by = @updatedBy,
    revision = revision + 1
  WHERE id = @id
`);

const selectItemsStmt = db.prepare(`
  SELECT
    i.id,
    i.sort_order,
    i.name,
    i.ip,
    i.port,
    i.username,
    i.password_cipher,
    i.password_iv,
    i.password_tag,
    i.created_at,
    i.created_by,
    i.updated_at,
    i.updated_by,
    i.password_rotation_count,
    i.password_created_at,
    i.password_created_by,
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
      FROM (
        SELECT id, password_cipher, password_iv, password_tag, created_at, created_by
        FROM password_history
        WHERE item_id = i.id
        ORDER BY created_at DESC, rowid DESC
      ) ph
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
    ip,
    port,
    username,
    password_cipher,
    password_iv,
    password_tag,
    created_at,
    created_by,
    updated_at,
    updated_by,
    password_rotation_count,
    password_created_at,
    password_created_by
  ) VALUES (
    @id,
    @roomId,
    @sortOrder,
    @name,
    @ip,
    @port,
    @username,
    @passwordCipher,
    @passwordIv,
    @passwordTag,
    @createdAt,
    @createdBy,
    @updatedAt,
    @updatedBy,
    @passwordRotationCount,
    @passwordCreatedAt,
    @passwordCreatedBy
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

const selectItemCountStmt = db.prepare(`
  SELECT COUNT(*) AS itemCount
  FROM items
  WHERE room_id = ?
`);

const updateItemFieldsStmt = db.prepare(`
  UPDATE items
  SET
    name = @name,
    ip = @ip,
    port = @port,
    username = @username,
    updated_at = @updatedAt,
    updated_by = @updatedBy
  WHERE id = @id AND room_id = @roomId
`);

// Update only the edited metadata field; the expected old value prevents stale clients
// from replacing a teammate's more recent edit.
const updateItemFieldStmts = Object.fromEntries(
  ["name", "ip", "username"].map((field) => [field, db.prepare(`
    UPDATE items SET ${field} = @value, updated_at = @updatedAt, updated_by = @updatedBy
    WHERE id = @id AND room_id = @roomId AND ${field} = @expectedValue
  `)])
);

const updateItemPasswordStmt = db.prepare(`
  UPDATE items
  SET
    password_cipher = @passwordCipher,
    password_iv = @passwordIv,
    password_tag = @passwordTag,
    updated_at = @updatedAt,
    updated_by = @updatedBy,
    password_rotation_count = @passwordRotationCount,
    password_created_at = @passwordCreatedAt,
    password_created_by = @passwordCreatedBy
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

const trimHistoryStmt = db.prepare(`
  DELETE FROM password_history
  WHERE item_id = @itemId
    AND id IN (
      SELECT id
      FROM password_history
      WHERE item_id = @itemId
      ORDER BY created_at DESC, rowid DESC
      LIMIT -1 OFFSET @keepCount
    )
`);

const httpRateLimitStore = new Map();
const socketRateLimitStore = new Map();
const mutationRateLimitStore = new Map();

// Append-only import: verify revision and room capacity inside the same transaction.
// Existing items, their history, board name and generator settings are untouched.
const importRoomState = db.transaction(({ roomId, roomKey, actorName, expectedRevision, items }) => {
  const room = selectRoomStmt.get(roomId);
  if (!room) throw createRoomGoneError();
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || room.revision !== expectedRevision) {
    throw new Error("The board changed before the import. Nothing was imported; review the board and try again.");
  }
  if (!items.length) throw new Error("The import contains no items.");
  requireRoomCapacity(roomId, items.length);
  const updatedAt = nowIso();
  const lastSortOrder = selectMaxSortOrderStmt.get(roomId).maxSortOrder;
  items.forEach((item, index) => {
    const createdAt = String(item.createdAt || nowIso());
    const createdBy = normalizeActorName(item.createdBy) || actorName;
    const updatedAt = String(item.updatedAt || createdAt);
    const updatedBy = normalizeActorName(item.updatedBy) || actorName;
    const encrypted = encryptPassword(roomKey, String(item.password || ""));
    const sortOrder = lastSortOrder + index + 1;
    const passwordRotationCount = Number.isFinite(Number(item.passwordRotationCount))
      ? Math.max(0, Number(item.passwordRotationCount))
      : Array.isArray(item.history)
        ? item.history.length
        : 0;
    const passwordCreatedAt = String(
      item.passwordCreatedAt || (passwordRotationCount ? updatedAt : createdAt)
    );
    const passwordCreatedBy = normalizeActorName(item.passwordCreatedBy)
      || (passwordRotationCount ? updatedBy : createdBy);

    insertItemStmt.run({
      id: uuidv4(),
      roomId,
      sortOrder,
      name: item.name,
      ip: item.ip,
      port: "",
      username: item.username,
      passwordCipher: encrypted.cipher,
      passwordIv: encrypted.iv,
      passwordTag: encrypted.tag,
      createdAt,
      createdBy,
      updatedAt,
      updatedBy,
      passwordRotationCount,
      passwordCreatedAt,
      passwordCreatedBy
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
  updateRoomImportAuditStmt.run({
    id: roomId,
    lastImportedAt: updatedAt,
    lastImportedBy: actorName,
    updatedAt,
    updatedBy: actorName
  });
});

function normalizeImportedTimestamp(value, fallback, fieldName) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw new Error(`${fieldName} must be a valid date string.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${fieldName} is not a valid date.`);
  if (parsed > Date.now() + 5 * 60 * 1000) {
    throw new Error(`${fieldName} is in the future. Check the import file's dates.`);
  }
  return new Date(parsed).toISOString();
}

function normalizeImportedItems(items) {
  if (!Array.isArray(items)) {
    throw new Error("Import file must contain an items array.");
  }

  if (items.length > MAX_IMPORT_ITEMS) {
    throw new Error(`Import exceeds the ${MAX_IMPORT_ITEMS}-item room limit.`);
  }

  const importedAt = nowIso();
  return items.map((item, index) => ({
    sortOrder: item?.sortOrder,
    name: normalizeItemName(item?.name),
    ip: normalizeIp(item?.ip),
    username: normalizeUsername(item?.username),
    password: normalizePassword(item?.password),
    createdAt: normalizeImportedTimestamp(item?.createdAt, importedAt, `Item ${index + 1} createdAt`),
    createdBy: item?.createdBy,
    updatedAt: normalizeImportedTimestamp(item?.updatedAt, importedAt, `Item ${index + 1} updatedAt`),
    updatedBy: item?.updatedBy,
    passwordRotationCount: item?.passwordRotationCount,
    // Preserve the original fallback logic for older exports without this field.
    passwordCreatedAt: item?.passwordCreatedAt
      ? normalizeImportedTimestamp(item.passwordCreatedAt, importedAt, `Item ${index + 1} passwordCreatedAt`)
      : undefined,
    passwordCreatedBy: item?.passwordCreatedBy,
    history: Array.isArray(item?.history)
      ? item.history.slice(0, MAX_HISTORY_ENTRIES_PER_ITEM).map((entry, historyIndex) => ({
          password: normalizePassword(entry?.password),
          createdAt: normalizeImportedTimestamp(entry?.createdAt, importedAt,
            `Item ${index + 1} history ${historyIndex + 1} createdAt`),
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
  const randomSize = Math.min(64, Math.max(8, Number(settings?.randomSize ?? settings?.size ?? 8) || 8));
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
  return String(name || "").trim().slice(0, MAX_ACTOR_NAME_LENGTH);
}

function normalizeBoundedString(value, { fieldName, maxLength, allowEmpty = true, trim = true }) {
  const normalized = trim ? String(value ?? "").trim() : String(value ?? "");
  if (!allowEmpty && !normalized) {
    throw new Error(`${fieldName} is required.`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function normalizeBoardName(value) {
  return normalizeBoundedString(value, {
    fieldName: "Board name",
    maxLength: MAX_BOARD_NAME_LENGTH
  }) || "Untitled Board";
}

function normalizeItemName(value) {
  return normalizeBoundedString(value, {
    fieldName: "Item name",
    maxLength: MAX_ITEM_NAME_LENGTH,
    allowEmpty: false
  });
}

function normalizeIp(value) {
  return normalizeBoundedString(value, {
    fieldName: "IP",
    maxLength: MAX_IP_LENGTH
  });
}

function normalizeUsername(value) {
  return normalizeBoundedString(value, {
    fieldName: "Username",
    maxLength: MAX_USERNAME_LENGTH
  });
}

function normalizePassword(value) {
  return normalizeBoundedString(value, {
    fieldName: "Password",
    maxLength: MAX_PASSWORD_LENGTH,
    trim: false
  });
}

function getRoomItemCount(roomId) {
  return selectItemCountStmt.get(roomId).itemCount;
}

function requireRoomCapacity(roomId, additionalItems = 1) {
  if (getRoomItemCount(roomId) + additionalItems > MAX_ITEMS_PER_ROOM) {
    throw new Error(`Rooms are limited to ${MAX_ITEMS_PER_ROOM} items.`);
  }
}

function requireImportCapacity(items) {
  if (items.length > MAX_ITEMS_PER_ROOM) {
    throw new Error(`Rooms are limited to ${MAX_ITEMS_PER_ROOM} items.`);
  }
}

function pruneRateLimitStore(store, now) {
  if (store.size <= 5000) {
    return;
  }

  for (const [key, entry] of store.entries()) {
    if (entry.resetAt <= now) {
      store.delete(key);
    }
  }
}

function consumeRateLimit(store, key, limit, windowMs) {
  const now = Date.now();
  pruneRateLimitStore(store, now);
  const existing = store.get(key);
  if (!existing || existing.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (existing.count >= limit) {
    return false;
  }

  existing.count += 1;
  return true;
}

function getRequestRateLimitKey(req, scope) {
  return `${scope}:${req.ip || req.socket.remoteAddress || "unknown"}`;
}

function requireHttpRateLimit(req, scope, limit, windowMs) {
  if (!consumeRateLimit(httpRateLimitStore, getRequestRateLimitKey(req, scope), limit, windowMs)) {
    const error = new Error("Too many requests. Please slow down.");
    error.statusCode = 429;
    throw error;
  }
}

function getSocketRateLimitKey(socket, scope) {
  let address = socket.handshake.address || socket.conn.remoteAddress || "unknown";
  const forwardedFor = socket.handshake.headers?.["x-forwarded-for"];
  const trustProxy = app.get("trust proxy fn");

  if (typeof forwardedFor === "string" && trustProxy(address, 0)) {
    const forwarded = forwardedFor.split(",");
    for (let i = forwarded.length - 1, hop = 0; i >= 0; i--, hop++) {
      const candidate = forwarded[i].trim();
      if (!trustProxy(address, hop) || !net.isIP(candidate)) break;
      address = candidate;
    }
  }

  return `${scope}:${address}`;
}

function requireSocketRateLimit(socket, scope, limit, windowMs) {
  if (!consumeRateLimit(socketRateLimitStore, getSocketRateLimitKey(socket, scope), limit, windowMs)) {
    throw new Error("Too many requests. Please slow down.");
  }
}

function requireMutationRateLimit(socket, roomId, scope) {
  const actorName = socket.data.actorName || "unknown";
  const actorKey = `actor:${roomId}:${actorName}:${scope}`;
  const roomKey = `room:${roomId}:${scope}`;

  if (!consumeRateLimit(mutationRateLimitStore, actorKey, MUTATION_LIMIT_PER_ACTOR, MUTATION_WINDOW_MS)) {
    throw new Error("You are making changes too quickly. Please slow down.");
  }

  if (!consumeRateLimit(mutationRateLimitStore, roomKey, MUTATION_LIMIT_PER_ROOM, MUTATION_WINDOW_MS)) {
    throw new Error("This board is receiving changes too quickly. Please slow down.");
  }
}

function validateImportPayload(payload) {
  const serialized = JSON.stringify(payload ?? {});
  if (Buffer.byteLength(serialized, "utf8") > MAX_IMPORT_JSON_BYTES) {
    throw new Error("Import file is too large.");
  }
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

function createRoomGoneError() {
  const error = new Error("Room not found or has expired.");
  error.code = "ROOM_GONE";
  error.statusCode = 404;
  return error;
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
    updatedAt: "",
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
  const room = getActiveRoom(roomKey);
  if (!room) {
    throw createRoomGoneError();
  }
  return room;
}

function assertActiveRoomForMutation(roomKey) {
  return requireActiveRoom(roomKey);
}

function assertMutationApplied(result, message) {
  if (!result?.changes) {
    throw new Error(message);
  }
}

function emitRoomClosed(roomKey, reason = "expired") {
  io.to(roomLookupId(roomKey)).emit("room:closed", {
    reason,
    closedAt: nowIso()
  });
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
  const id = room.id;
  const rows = selectItemsStmt.all(id);
  // Include legacy item edits, which previously didn't update rooms.updated_at.
  // Ignore the original creation timestamp; a new empty room has no changes yet.
  const changedAt = room.updated_at || rows.map((item) => item.updated_at)
    .filter((timestamp) => timestamp && timestamp !== room.created_at && Number.isFinite(Date.parse(timestamp)) && Date.parse(timestamp) <= Date.now())
    .reduce((latest, timestamp) => !latest || Date.parse(timestamp) > Date.parse(latest) ? timestamp : latest, "");

  return {
    roomId: room.id,
    // The frontend must use field-specific writes to avoid overwriting teammates' edits.
    clientProtocolVersion: "field-updates-v1",
    boardName: room.name,
    generatorSettings: parseGeneratorSettings(room.generator_settings),
    lastImportedAt: room.last_imported_at,
    lastImportedBy: room.last_imported_by,
    boardUpdatedAt: changedAt,
    boardUpdatedBy: room.updated_by,
    boardRevision: room.revision,
    createdAt: room.created_at,
    expiresAt: Number.isFinite(Date.parse(room.created_at))
      ? new Date(Date.parse(room.created_at) + ROOM_TTL_MS).toISOString()
      : null,
    activeUsers: getActiveUsers(roomKey),
    items: rows.map((row) => ({
      id: row.id,
      sortOrder: row.sort_order,
      name: row.name,
      ip: row.ip,
      username: row.username,
      password: decryptPassword(roomKey, {
        cipher: row.password_cipher,
        iv: row.password_iv,
        tag: row.password_tag
      }),
      createdAt: row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      passwordRotationCount: row.password_rotation_count,
      passwordCreatedAt: row.password_created_at,
      passwordCreatedBy: row.password_created_by,
      history: parseHistory(row.history_json).reverse().map((entry) => ({
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
  ({ itemId, roomId, roomKey, nextPassword, expectedPassword, updatedAt, updatedBy }) => {
    const existing = selectItemStmt.get(itemId, roomId);
    if (!existing) {
      throw new Error("Item not found.");
    }

    const currentPassword = decryptPassword(roomKey, {
      cipher: existing.password_cipher,
      iv: existing.password_iv,
      tag: existing.password_tag
    });

    if (typeof expectedPassword === "string" && currentPassword !== expectedPassword) {
      throw new Error("This password changed on another client. Your edit was not saved.");
    }

    if (currentPassword === nextPassword) {
      return false;
    }

    if (currentPassword) {
      insertHistoryStmt.run({
        id: uuidv4(),
        itemId,
        roomId,
        passwordCipher: existing.password_cipher,
        passwordIv: existing.password_iv,
        passwordTag: existing.password_tag,
        createdAt: existing.password_created_at,
        createdBy: existing.password_created_by
      });
      trimHistoryStmt.run({
        itemId,
        keepCount: MAX_HISTORY_ENTRIES_PER_ITEM
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
      updatedBy,
      passwordRotationCount: (existing.password_rotation_count || 0) + 1,
      passwordCreatedAt: updatedAt,
      passwordCreatedBy: updatedBy
    });
    return true;
  }
);

app.use(express.json({ limit: "256kb" }));
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
  res.setHeader("Cache-Control", "no-store");
  try {
    requireHttpRateLimit(req, "bootstrap", HTTP_BOOTSTRAP_LIMIT, HTTP_RATE_LIMIT_WINDOW_MS);
    const { roomKey } = req.params;
    if (!ensureRoomKey(roomKey)) {
      return res.status(400).json({ error: "Invalid room key." });
    }

    const room = requireActiveRoom(roomKey);
    if (!room) {
      return res.status(404).json({ error: "Room not found or has expired." });
    }

    return res.json(mapRoomState(roomKey));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Request failed." });
  }
});

app.get("/api/rooms/new", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    requireHttpRateLimit(req, "new-room", HTTP_NEW_ROOM_LIMIT, HTTP_RATE_LIMIT_WINDOW_MS);
    const roomKey = uuidv4();
    ensureRoomExists(roomKey);
    return res.json({ roomKey, url: `/room/${roomKey}` });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Request failed." });
  }
});

app.get("/room", (_req, res) => {
  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, _req, res, next) => {
  if (!error) {
    next();
    return;
  }

  if (error.type === "entity.too.large" || error.status === 413) {
    res.status(413).json({ error: "Request body is too large." });
    return;
  }

  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ error: "Request body is not valid JSON." });
    return;
  }

  res.status(error.statusCode || 500).json({ error: error.message || "Request failed." });
});

app.get("/room/:roomKey", (req, res) => {
  try {
    if (!ensureRoomKey(req.params.roomKey)) {
      return res.status(400).send("Invalid room key.");
    }

    requireActiveRoom(req.params.roomKey);
    return res.redirect(302, `/room?roomKey=${encodeURIComponent(req.params.roomKey)}`);
  } catch (error) {
    return res.status(error.statusCode || 500).send(error.message || "Request failed.");
  }
});

io.use((socket, next) => {
  try {
    const roomKey = socket.handshake.auth?.roomKey;
    const actorName = normalizeActorName(socket.handshake.auth?.actorName);
    if (!consumeRateLimit(socketRateLimitStore, getSocketRateLimitKey(socket, "connect"), SOCKET_CONNECT_LIMIT, SOCKET_CONNECT_WINDOW_MS)) {
      return next(new Error("Too many connection attempts. Please slow down."));
    }
    if (!ensureRoomKey(roomKey)) {
      return next(new Error("Invalid room key."));
    }
    if (!actorName) {
      return next(new Error("Display name is required."));
    }
    requireActiveRoom(roomKey);

    socket.data.roomKey = roomKey;
    socket.data.roomId = roomLookupId(roomKey);
    socket.data.actorName = actorName;
    return next();
  } catch (error) {
    return next(error);
  }
});

function emitRoomState(roomKey) {
  try {
    const state = mapRoomState(roomKey);
    io.to(roomLookupId(roomKey)).emit("room:state", state);
  } catch (error) {
    if (error.code === "ROOM_GONE") {
      emitRoomClosed(roomKey, "expired");
      return;
    }
    throw error;
  }
}

io.on("connection", (socket) => {
  const { roomKey, roomId, actorName } = socket.data;
  socket.join(roomId);
  emitRoomState(roomKey);

  socket.on("room:updateName", (payload, callback = () => {}) => {
    try {
      const room = assertActiveRoomForMutation(roomKey);
      requireMutationRateLimit(socket, roomId, "room-update");
      const name = normalizeBoardName(payload?.name);
      if (typeof payload?.expectedName === "string" && room.name !== payload.expectedName) {
        throw new Error("The board name changed on another client. Your edit was not saved.");
      }
      if (name === room.name) {
        if (typeof callback === "function") callback({ ok: true });
        return;
      }
      const result = updateRoomNameStmt.run({
        id: roomId,
        name,
        updatedAt: nowIso(),
        updatedBy: actorName
      });
      assertMutationApplied(result, "Room not found or has expired.");

      emitRoomState(roomKey);
      if (typeof callback === "function") callback({ ok: true });
    } catch (error) {
      if (error.code === "ROOM_GONE") {
        emitRoomClosed(roomKey, "expired");
      }
      if (typeof callback === "function") callback({ ok: false, error: error.message });
    }
  });

  socket.on("room:updateGeneratorSettings", (payload, callback = () => {}) => {
    try {
      const room = assertActiveRoomForMutation(roomKey);
      requireMutationRateLimit(socket, roomId, "room-settings");
      const generatorSettings = serializeGeneratorSettings(payload?.generatorSettings);
      if (payload?.expectedGeneratorSettings &&
          serializeGeneratorSettings(payload.expectedGeneratorSettings) !== serializeGeneratorSettings(parseGeneratorSettings(room.generator_settings))) {
        throw new Error("Generator settings changed on another client. Your edits were not saved.");
      }
      if (generatorSettings === serializeGeneratorSettings(parseGeneratorSettings(room.generator_settings))) {
        if (typeof callback === "function") callback({ ok: true });
        return;
      }
      const result = updateRoomGeneratorSettingsStmt.run({
        id: roomId,
        generatorSettings,
        updatedAt: nowIso(),
        updatedBy: actorName
      });
      assertMutationApplied(result, "Room not found or has expired.");

      emitRoomState(roomKey);
      if (typeof callback === "function") callback({ ok: true });
    } catch (error) {
      if (error.code === "ROOM_GONE") {
        emitRoomClosed(roomKey, "expired");
      }
      if (typeof callback === "function") callback({ ok: false, error: error.message });
    }
  });

  socket.on("room:import", (payload, callback = () => {}) => {
    try {
      assertActiveRoomForMutation(roomKey);
      requireMutationRateLimit(socket, roomId, "room-import");
      requireSocketRateLimit(socket, "room-import", SOCKET_IMPORT_LIMIT, SOCKET_IMPORT_WINDOW_MS);
      validateImportPayload(payload);
      const normalizedItems = normalizeImportedItems(payload?.items);
      requireImportCapacity(normalizedItems);
      importRoomState({
        roomId,
        roomKey,
        actorName,
        expectedRevision: payload?.expectedRevision,
        items: normalizedItems
      });

      emitRoomState(roomKey);
      if (typeof callback === "function") callback({ ok: true });
    } catch (error) {
      if (error.code === "ROOM_GONE") {
        emitRoomClosed(roomKey, "expired");
      }
      if (typeof callback === "function") callback({ ok: false, error: error.message });
    }
  });

  socket.on("items:reorder", (payload, callback = () => {}) => {
    try {
      assertActiveRoomForMutation(roomKey);
      requireMutationRateLimit(socket, roomId, "reorder");
      const orderedIds = Array.isArray(payload?.orderedIds)
        ? payload.orderedIds.map((id) => String(id))
        : [];
      const currentIds = mapRoomState(roomKey).items.map((item) => item.id);

      if (
        orderedIds.length !== currentIds.length ||
        new Set(orderedIds).size !== orderedIds.length ||
        orderedIds.some((id) => !currentIds.includes(id))
      ) {
        throw new Error("Reorder payload does not match current board items.");
      }

      if (orderedIds.every((id, index) => id === currentIds[index])) {
        if (typeof callback === "function") callback({ ok: true });
        return;
      }
      reorderItems({
        roomId,
        orderedIds
      });
      touchRoomChangeStmt.run(nowIso(), actorName, roomId);

      emitRoomState(roomKey);
      if (typeof callback === "function") callback({ ok: true });
    } catch (error) {
      if (error.code === "ROOM_GONE") {
        emitRoomClosed(roomKey, "expired");
      }
      if (typeof callback === "function") callback({ ok: false, error: error.message });
    }
  });

  socket.on("item:create", (payload, callback = () => {}) => {
    try {
      assertActiveRoomForMutation(roomKey);
      requireMutationRateLimit(socket, roomId, "item-create");
      const createdAt = nowIso();
      requireRoomCapacity(roomId);
      const password = normalizePassword(payload?.password);
      const encrypted = encryptPassword(roomKey, password);
      const nextSortOrder = selectMaxSortOrderStmt.get(roomId).maxSortOrder + 1;

      insertItemStmt.run({
        id: uuidv4(),
        roomId,
        sortOrder: nextSortOrder,
        name: normalizeItemName(payload?.name),
        ip: normalizeIp(payload?.ip),
        port: "",
        username: normalizeUsername(payload?.username),
        passwordCipher: encrypted.cipher,
        passwordIv: encrypted.iv,
        passwordTag: encrypted.tag,
        createdAt,
        createdBy: actorName,
        updatedAt: createdAt,
        updatedBy: actorName,
        passwordRotationCount: 0,
        passwordCreatedAt: createdAt,
        passwordCreatedBy: actorName
      });
      touchRoomChangeStmt.run(createdAt, actorName, roomId);

      emitRoomState(roomKey);
      if (typeof callback === "function") callback({ ok: true });
    } catch (error) {
      if (error.code === "ROOM_GONE") {
        emitRoomClosed(roomKey, "expired");
      }
      if (typeof callback === "function") callback({ ok: false, error: error.message });
    }
  });

  socket.on("item:updateMeta", (payload, callback = () => {}) => {
    try {
      assertActiveRoomForMutation(roomKey);
      requireMutationRateLimit(socket, roomId, "item-update");
      const itemId = String(payload?.id || "");
      const field = payload?.field;
      if (field === undefined && payload && typeof payload === "object" && ("name" in payload || "ip" in payload || "username" in payload)) {
        throw new Error("Your browser is using an older PassBoard version. Refresh the page before editing.");
      }
      if (!Object.hasOwn(updateItemFieldStmts, field)) {
        throw new Error("Invalid item field.");
      }
      const normalize = field === "name" ? normalizeItemName
        : field === "ip" ? normalizeIp : normalizeUsername;
      const value = normalize(payload?.value);
      const expectedValue = normalize(payload?.expectedValue);
      const previous = selectItemStmt.get(itemId, roomId);
      if (!previous) throw new Error("Item not found.");
      if (previous[field] !== expectedValue) {
        throw new Error("This field changed on another client. Your edit was not saved.");
      }
      if (previous[field] === value) {
        if (typeof callback === "function") callback({ ok: true });
        return;
      }
      const updatedAt = nowIso();
      const result = updateItemFieldStmts[field].run({
        id: itemId, roomId, value, expectedValue, updatedAt, updatedBy: actorName
      });
      if (!result.changes) {
        throw new Error("This field changed on another client. Your edit was not saved.");
      }
      touchRoomChangeStmt.run(updatedAt, actorName, roomId);
      emitRoomState(roomKey);
      if (typeof callback === "function") callback({ ok: true });
    } catch (error) {
      if (error.code === "ROOM_GONE") emitRoomClosed(roomKey, "expired");
      if (typeof callback === "function") callback({ ok: false, error: error.message });
    }
  });

  socket.on("item:updatePassword", (payload, callback = () => {}) => {
    try {
      assertActiveRoomForMutation(roomKey);
      requireMutationRateLimit(socket, roomId, "password-update");
      const updatedAt = nowIso();
      const changed = setItemPasswordWithHistory({
        itemId: String(payload?.id || ""),
        roomId,
        roomKey,
        nextPassword: normalizePassword(payload?.password),
        expectedPassword: payload?.expectedPassword,
        updatedAt,
        updatedBy: actorName
      });
      if (changed) {
        touchRoomChangeStmt.run(updatedAt, actorName, roomId);
        emitRoomState(roomKey);
      }
      if (typeof callback === "function") callback({ ok: true });
    } catch (error) {
      if (error.code === "ROOM_GONE") {
        emitRoomClosed(roomKey, "expired");
      }
      if (typeof callback === "function") callback({ ok: false, error: error.message });
    }
  });

  socket.on("item:delete", (payload, callback = () => {}) => {
    try {
      assertActiveRoomForMutation(roomKey);
      requireMutationRateLimit(socket, roomId, "item-delete");
      const result = deleteItemStmt.run(String(payload?.id || ""), roomId);
      assertMutationApplied(result, "Item not found.");
      touchRoomChangeStmt.run(nowIso(), actorName, roomId);
      emitRoomState(roomKey);
      if (typeof callback === "function") callback({ ok: true });
    } catch (error) {
      if (error.code === "ROOM_GONE") {
        emitRoomClosed(roomKey, "expired");
      }
      if (typeof callback === "function") callback({ ok: false, error: error.message });
    }
  });

  socket.on("room:destroy", (_payload, callback = () => {}) => {
    try {
      assertActiveRoomForMutation(roomKey);
      requireMutationRateLimit(socket, roomId, "room-destroy");
      const result = deleteRoomStmt.run(roomId);
      assertMutationApplied(result, "Room not found or has expired.");
      io.to(roomId).emit("room:destroyed", {
        destroyedAt: nowIso(),
        destroyedBy: actorName
      });
      if (typeof callback === "function") callback({ ok: true });

      setTimeout(() => {
        const roomSockets = io.sockets.adapter.rooms.get(roomId);
        if (!roomSockets) {
          return;
        }

        roomSockets.forEach((socketId) => {
          io.sockets.sockets.get(socketId)?.disconnect(true);
        });
      }, 25);
    } catch (error) {
      if (error.code === "ROOM_GONE") {
        emitRoomClosed(roomKey, "expired");
      }
      if (typeof callback === "function") callback({ ok: false, error: error.message });
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
    console.log("PassBoard server listening.");
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
