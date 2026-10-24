const DEFAULT_GENERATOR_SETTINGS = {
  mode: "random",
  randomSize: 8,
  wordCount: 3,
  separator: "-",
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbols: true,
  excludeSimilar: true
};

// A mismatched server can reject partial edits or use unsafe whole-row writes.
const EXPECTED_SERVER_PROTOCOL = "field-updates-v1";
const HISTORY_PREVIEW_LIMIT = 25;
const ACTIVE_ROOM_STORAGE_KEY = "passboard-active-room";

const state = {
  roomKey: null,
  actorName: "",
  socket: null,
  boardName: "Untitled Board",
  expiresAt: "",
  generatorSettings: normalizeGeneratorSettings(),
  wordList: [],
  items: [],
  activeUsers: [],
  lastImportedAt: "",
  lastImportedBy: "",
  passwordsHidden: false,
  lastChangedAt: null,
  boardRevision: 0,
  connectionState: "connecting",
  draggedItemId: null,
  historyVisibleCounts: {}
};

const elements = {
  roomNavbar: document.getElementById("room-navbar"),
  leaveRoomButton: document.getElementById("leave-room-button"),
  destroyRoomButton: document.getElementById("destroy-room-button"),
  boardView: document.getElementById("board-view"),
  hero: document.querySelector(".hero"),
  securityNotes: document.getElementById("security-notes"),
  roomKeyInput: document.getElementById("room-key-input"),
  joinRoomForm: document.getElementById("join-room-form"),
  createRoomButton: document.getElementById("create-room-button"),
  copyRoomLink: document.getElementById("copy-room-link"),
  viewRoomLink: document.getElementById("view-room-link"),
  connectionStatus: document.getElementById("board-live-indicator"),
  connectionLabel: document.getElementById("connection-label"),
  connectionDetail: document.getElementById("connection-detail"),
  togglePasswordVisibility: document.getElementById("toggle-password-visibility"),
  exportBoardButton: document.getElementById("export-board-button"),
  importBoardButton: document.getElementById("import-board-button"),
  importBoardInput: document.getElementById("import-board-input"),
  boardNameInput: document.getElementById("board-name-input"),
  roomExpiration: document.getElementById("room-expiration"),
  boardAuditMeta: document.getElementById("board-audit-meta"),
  signedInName: document.getElementById("signed-in-name"),
  activeUsersList: document.getElementById("active-users-list"),
  createItemForm: document.getElementById("create-item-form"),
  newItemUsername: document.getElementById("new-item-username"),
  newItemPassword: document.getElementById("new-item-password"),
  copyNewItemUsername: document.getElementById("copy-new-item-username"),
  copyNewItemPassword: document.getElementById("copy-new-item-password"),
  generateNewItemPassword: document.getElementById("generate-new-item-password"),
  viewNewItemPassword: document.getElementById("view-new-item-password"),
  itemsContainer: document.getElementById("items-container"),
  itemCount: document.getElementById("item-count"),
  itemTemplate: document.getElementById("item-template"),
  generatorDialog: document.getElementById("generator-dialog"),
  generatorForm: document.getElementById("generator-form"),
  generatorSlider: document.getElementById("generator-size"),
  generatorSliderLabel: document.getElementById("generator-slider-label"),
  generatorSliderValue: document.getElementById("generator-slider-value"),
  generatorPreview: document.getElementById("generator-preview"),
  openGeneratorSettings: document.getElementById("open-generator-settings"),
  nameDialog: document.getElementById("name-dialog"),
  nameForm: document.getElementById("name-form"),
  displayNameInput: document.getElementById("display-name-input"),
  passwordViewDialog: document.getElementById("password-view-dialog"),
  passwordViewValue: document.getElementById("password-view-value"),
  copyLargePassword: document.getElementById("copy-large-password"),
  roomLinkDialog: document.getElementById("room-link-dialog"),
  roomLinkViewValue: document.getElementById("room-link-view-value"),
  copyLargeRoomLink: document.getElementById("copy-large-room-link")
};

function getDisplayNameStorageKey(roomKey) {
  return `password-board-display-name:${roomKey}`;
}

function getStoredActiveRoomKey() {
  return localStorage.getItem(ACTIVE_ROOM_STORAGE_KEY) || "";
}

function setStoredActiveRoomKey(roomKey) {
  localStorage.setItem(ACTIVE_ROOM_STORAGE_KEY, roomKey);
}

function clearStoredRoomSession(roomKey = state.roomKey) {
  localStorage.removeItem(ACTIVE_ROOM_STORAGE_KEY);
  if (roomKey) {
    localStorage.removeItem(getDisplayNameStorageKey(roomKey));
  }
}

function handleRoomClosure(message) {
  clearStoredRoomSession();
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
  alert(message);
  window.location.assign("/");
}

function getRoomJoinUrl(roomKey = state.roomKey) {
  return new URL(`/room/${roomKey}`, window.location.origin).toString();
}

function normalizeGeneratorSettings(settings = {}) {
  const mode = settings.mode === "words" ? "words" : "random";
  const randomSize = Math.min(64, Math.max(8, Number(settings.randomSize ?? settings.size ?? 8) || 8));
  const wordCount = Math.min(8, Math.max(2, Number(settings.wordCount ?? settings.size ?? 3) || 3));

  return {
    mode,
    randomSize,
    wordCount,
    separator: String(settings.separator ?? "-").slice(0, 3) || "-",
    uppercase: settings.uppercase !== false,
    lowercase: settings.lowercase !== false,
    numbers: settings.numbers !== false,
    symbols: settings.symbols !== false,
    excludeSimilar: settings.excludeSimilar !== false
  };
}

function getGeneratorSize(settings = state.generatorSettings) {
  return settings.mode === "words" ? settings.wordCount : settings.randomSize;
}

async function loadWordList() {
  if (state.wordList.length) {
    return state.wordList;
  }

  const response = await fetch("/wordlist.json");
  if (!response.ok) {
    throw new Error("Unable to load the word list.");
  }

  const words = await response.json();
  if (!Array.isArray(words) || !words.length) {
    throw new Error("The word list is empty.");
  }

  state.wordList = words;
  return words;
}

function cryptoRandomInt(max) {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] % max;
}

function randomChar(source) {
  return source[cryptoRandomInt(source.length)];
}

function generateRandomPassword(settings) {
  let lowercase = "abcdefghijkmnopqrstuvwxyz";
  let uppercase = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let numbers = "23456789";
  let symbols = "!@#$%^&*()-_=+[]{}:,.?";

  if (!settings.excludeSimilar) {
    lowercase = "abcdefghijklmnopqrstuvwxyz";
    uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    numbers = "0123456789";
  }

  const groups = [];
  if (settings.lowercase) groups.push(lowercase);
  if (settings.uppercase) groups.push(uppercase);
  if (settings.numbers) groups.push(numbers);
  if (settings.symbols) groups.push(symbols);

  if (!groups.length) {
    throw new Error("Enable at least one character group.");
  }

  const length = getGeneratorSize(settings);
  const allChars = groups.join("");
  const passwordChars = [];

  groups.forEach((group) => {
    passwordChars.push(randomChar(group));
  });

  while (passwordChars.length < length) {
    passwordChars.push(randomChar(allChars));
  }

  for (let i = passwordChars.length - 1; i > 0; i -= 1) {
    const swapIndex = cryptoRandomInt(i + 1);
    [passwordChars[i], passwordChars[swapIndex]] = [
      passwordChars[swapIndex],
      passwordChars[i]
    ];
  }

  return passwordChars.slice(0, length).join("");
}

function generateWordPassword(settings) {
  const count = getGeneratorSize(settings);
  const separator = String(settings.separator ?? "-").slice(0, 3) || "-";
  const words = [];
  const sourceWords = state.wordList;

  if (!sourceWords.length) {
    throw new Error("Word list is not loaded yet.");
  }

  for (let i = 0; i < count; i += 1) {
    words.push(sourceWords[cryptoRandomInt(sourceWords.length)]);
  }

  return words.join(separator);
}

function generatePassword(settings = state.generatorSettings) {
  if (settings.mode === "words") {
    return generateWordPassword(settings);
  }

  return generateRandomPassword(settings);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function extractRoomKey(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  if (isUuid(trimmed)) {
    return trimmed;
  }

  const directMatch = trimmed.match(/\/room\/([0-9a-f-]{36})(?:[/?#]|$)/i);
  if (directMatch && isUuid(directMatch[1])) {
    return directMatch[1];
  }

  const candidateUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(candidateUrl);
    const roomMatch = parsed.pathname.match(/\/room\/([0-9a-f-]{36})\/?$/i);
    if (roomMatch && isUuid(roomMatch[1])) {
      return roomMatch[1];
    }
  } catch (_error) {
    return "";
  }

  return "";
}

function formatAbsoluteDate(value) {
  return new Date(value).toLocaleString();
}

function formatRelativeDate(value) {
  const diffMs = new Date(value).getTime() - Date.now();
  const diffSeconds = Math.round(diffMs / 1000);
  const absSeconds = Math.abs(diffSeconds);

  if (absSeconds < 10) {
    return "just now";
  }
  if (absSeconds < 60) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(diffSeconds, "second");
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(diffMinutes, "minute");
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(diffHours, "hour");
  }

  const diffDays = Math.round(diffHours / 24);
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(diffDays, "day");
}

function formatFilenameTimestamp(value = new Date()) {
  const date = new Date(value);
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ];
  const time = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ];

  return `${parts.join("")}-${time.join("")}`;
}

function updateRoomCountdown() {
  if (!state.expiresAt) {
    elements.roomExpiration.textContent = "Unavailable";
    return;
  }

  const expiresAt = new Date(state.expiresAt);
  const remaining = expiresAt.getTime() - Date.now();
  if (!Number.isFinite(remaining)) {
    elements.roomExpiration.textContent = "Unavailable";
    return;
  }

  elements.roomExpiration.dataset.tooltip = expiresAt.toLocaleString(undefined, {
    dateStyle: "full",
    timeStyle: "long"
  });
  elements.roomExpiration.setAttribute("aria-label", `Room expires ${elements.roomExpiration.dataset.tooltip}`);

  if (remaining <= 0) {
    elements.roomExpiration.textContent = "Expired";
  } else if (remaining >= 24 * 60 * 60 * 1000) {
    const days = Math.ceil(remaining / (24 * 60 * 60 * 1000));
    elements.roomExpiration.textContent = `${days} day${days === 1 ? "" : "s"}`;
  } else {
    const minutesRemaining = Math.ceil(remaining / (60 * 1000));
    const hours = Math.floor(minutesRemaining / 60);
    const minutes = minutesRemaining % 60;
    elements.roomExpiration.textContent = `${hours}h ${minutes}m`;
  }
}

function updateRelativeTimestamps() {
  updateRoomCountdown();
  document.querySelectorAll("[data-timestamp-value]").forEach((node) => {
    const timestamp = node.dataset.timestampValue;
    const actor = node.dataset.timestampActor;
    node.textContent = `Changed ${formatRelativeDate(timestamp)}${actor ? ` by ${actor}` : ""}`;
    node.title = formatAbsoluteDate(timestamp);
  });

  if (state.lastImportedAt && !elements.boardAuditMeta.classList.contains("hidden")) {
    elements.boardAuditMeta.textContent = `Last imported ${formatRelativeDate(state.lastImportedAt)}${state.lastImportedBy ? ` by ${state.lastImportedBy}` : ""}`;
    elements.boardAuditMeta.title = formatAbsoluteDate(state.lastImportedAt);
  }

  updateLastChangeDetail();
}

function updateLastChangeDetail() {
  // The detail describes content changes, never incoming sync/presence events.
  elements.connectionDetail.textContent = state.lastChangedAt
    ? `Changed ${formatRelativeDate(state.lastChangedAt)}`
    : "No changes yet";
  if (state.lastChangedAt) {
    elements.connectionDetail.title = formatAbsoluteDate(state.lastChangedAt);
  } else {
    elements.connectionDetail.removeAttribute("title");
  }
}

function setConnectionStatus(variant, reason = "") {
  // Only Socket.IO connection events determine whether the badge says Live.
  state.connectionState = variant;
  elements.connectionStatus.classList.remove("live", "offline", "connecting");
  elements.connectionStatus.classList.add(variant);
  elements.connectionLabel.textContent = variant === "live"
    ? "Live" : variant === "offline" ? "Disconnected" : "Connecting";
  if (reason && variant !== "live") {
    elements.connectionStatus.title = reason;
  } else {
    elements.connectionStatus.removeAttribute("title");
  }
  updateLastChangeDetail();
}

function updatePasswordVisibilityUi() {
  elements.togglePasswordVisibility.textContent = state.passwordsHidden ? "Show Passwords" : "Hide Passwords";
  document.querySelectorAll(".password-input").forEach((input) => {
    input.type = state.passwordsHidden ? "password" : "text";
  });
}

async function copyWithFeedback(button, value) {
  await navigator.clipboard.writeText(value);
  button.classList.remove("copied");
  void button.offsetWidth;
  button.classList.add("copied");
  window.setTimeout(() => {
    button.classList.remove("copied");
  }, 900);
}

function renderActiveUsers() {
  elements.activeUsersList.innerHTML = "";
  state.activeUsers.forEach((user) => {
    const chip = document.createElement("span");
    chip.className = "user-chip";
    chip.textContent = user.name;
    if (user.name === state.actorName) {
      chip.classList.add("self");
    }
    elements.activeUsersList.appendChild(chip);
  });
}

function renderBoardAuditMeta() {
  if (!state.lastImportedAt) {
    elements.boardAuditMeta.textContent = "";
    elements.boardAuditMeta.classList.add("hidden");
    return;
  }

  elements.boardAuditMeta.textContent = `Last imported ${formatRelativeDate(state.lastImportedAt)}${state.lastImportedBy ? ` by ${state.lastImportedBy}` : ""}`;
  elements.boardAuditMeta.title = formatAbsoluteDate(state.lastImportedAt);
  elements.boardAuditMeta.classList.remove("hidden");
}

function openLargePasswordView(password) {
  elements.passwordViewValue.textContent = password || "";
  elements.copyLargePassword.dataset.passwordValue = password || "";
  elements.passwordViewDialog.showModal();
}

function openLargeRoomLinkView(roomKey = state.roomKey) {
  const roomLink = getRoomJoinUrl(roomKey);
  elements.roomLinkViewValue.textContent = roomLink;
  elements.copyLargeRoomLink.dataset.roomLinkValue = roomLink;
  elements.roomLinkDialog.showModal();
}

function buildExportPayload() {
  return {
    format: "password-board-v1",
    exportedAt: new Date().toISOString(),
    exportedBy: state.actorName,
    boardName: state.boardName,
    generatorSettings: state.generatorSettings,
    lastImportedAt: state.lastImportedAt,
    lastImportedBy: state.lastImportedBy,
    items: state.items.map((item) => ({
      sortOrder: item.sortOrder,
      name: item.name,
      ip: item.ip,
      username: item.username,
      password: item.password,
      createdAt: item.createdAt,
      createdBy: item.createdBy,
      updatedAt: item.updatedAt,
      updatedBy: item.updatedBy,
      passwordRotationCount: item.passwordRotationCount,
      passwordCreatedAt: item.passwordCreatedAt,
      passwordCreatedBy: item.passwordCreatedBy,
      history: item.history.map((entry) => ({
        password: entry.password,
        createdAt: entry.createdAt,
        createdBy: entry.createdBy
      }))
    }))
  };
}

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function importBoardFromFile(file, expectedRevision) {
  const text = await file.text();
  const payload = JSON.parse(text);
  if (!payload || !Array.isArray(payload.items)) {
    throw new Error("Import file must contain a board object with an items array.");
  }
  if (payload.items.length === 0) throw new Error("The import file contains no items.");

  const confirmed = window.confirm(
    `Append ${payload.items.length} items to the existing ${state.items.length} entries? ` +
    `Existing passwords and history will NOT be deleted or overwritten. Duplicate entries may be added. Continue?`
  );
  if (!confirmed) return;

  await emit("room:import", {
    items: payload.items,
    expectedRevision
  });
}

function showBoard(roomKey, actorName) {
  state.roomKey = roomKey;
  state.actorName = actorName;
  setStoredActiveRoomKey(roomKey);
  elements.hero.classList.add("hidden");
  elements.securityNotes.classList.add("hidden");
  elements.roomNavbar.classList.remove("hidden");
  elements.boardView.classList.remove("hidden");
  elements.signedInName.textContent = actorName;
  elements.newItemPassword.value = generatePassword();
  window.history.replaceState({}, "", "/room");
}

async function createRoom() {
  const response = await fetch("/api/rooms/new");
  const payload = await response.json();
  window.location.assign(payload.url);
}

function requireCompatibleServer(payload) {
  if (payload?.clientProtocolVersion !== EXPECTED_SERVER_PROTOCOL) {
    throw new Error("PassBoard server/browser version mismatch. Deploy the matching server.js, restart the server, then refresh this page. Your edits have not been sent.");
  }
}

async function bootstrapRoom(roomKey) {
  const response = await fetch(`/api/rooms/${roomKey}/bootstrap`);
  if (!response.ok) {
    let errorMessage = "Unable to open that room.";
    try {
      const payload = await response.json();
      if (payload?.error) {
        errorMessage = payload.error;
      }
    } catch (_error) {
      // Ignore parse failure and keep the generic message.
    }

    const error = new Error(errorMessage);
    error.statusCode = response.status;
    throw error;
  }

  const payload = await response.json();
  requireCompatibleServer(payload);
  state.items = payload.items;
  state.activeUsers = payload.activeUsers || [];
  state.boardName = payload.boardName || "Untitled Board";
  state.expiresAt = payload.expiresAt || "";
  state.generatorSettings = normalizeGeneratorSettings(payload.generatorSettings);
  state.lastImportedAt = payload.lastImportedAt || "";
  state.lastImportedBy = payload.lastImportedBy || "";
  state.lastChangedAt = payload.boardUpdatedAt || null;
  state.boardRevision = payload.boardRevision;
  if (document.activeElement !== elements.boardNameInput && !boardNameSavePending) {
    elements.boardNameInput.value = state.boardName;
  }
  document.title = `${state.boardName} | PassBoard`;
  if (!elements.generatorDialog.open) applyGeneratorSettingsToForm();
  renderActiveUsers();
  renderBoardAuditMeta();
  renderItems();
}

function connectSocket(roomKey, actorName) {
  if (state.socket) {
    state.socket.disconnect();
  }

  const socket = io({
    auth: {
      roomKey,
      actorName
    }
  });

  socket.on("connect", () => {
    setConnectionStatus("live");
  });

  socket.on("disconnect", (reason) => {
    const detail = reason === "io server disconnect" ? "Server disconnected" : "Trying to reconnect";
    setConnectionStatus("offline", detail);
  });

  socket.on("connect_error", (error) => {
    setConnectionStatus("offline", error.message || "Unable to connect");
  });

  socket.on("room:state", (payload) => {
    try {
      requireCompatibleServer(payload);
    } catch (error) {
      socket.disconnect();
      setConnectionStatus("offline", "Server/browser version mismatch");
      alert(error.message);
      return;
    }
    state.items = payload.items;
    state.activeUsers = payload.activeUsers || [];
    state.boardName = payload.boardName || "Untitled Board";
    state.expiresAt = payload.expiresAt || "";
    state.generatorSettings = normalizeGeneratorSettings(payload.generatorSettings);
    state.lastImportedAt = payload.lastImportedAt || "";
    state.lastImportedBy = payload.lastImportedBy || "";
    state.lastChangedAt = payload.boardUpdatedAt || null;
    state.boardRevision = payload.boardRevision;
    if (document.activeElement !== elements.boardNameInput && !boardNameSavePending) {
      elements.boardNameInput.value = state.boardName;
    }
    document.title = `${state.boardName} | PassBoard`;
    if (!elements.generatorDialog.open) applyGeneratorSettingsToForm();
    renderActiveUsers();
    renderBoardAuditMeta();
    renderItems();
    setConnectionStatus("live");
  });

  socket.on("room:destroyed", (payload) => {
    const destroyedBy = payload?.destroyedBy ? ` by ${payload.destroyedBy}` : "";
    handleRoomClosure(`This board was destroyed${destroyedBy}.`);
  });

  socket.on("room:closed", (payload) => {
    if (payload?.reason === "expired") {
      handleRoomClosure("This board has expired and is no longer available.");
      return;
    }

    handleRoomClosure("This board is no longer available.");
  });

  state.socket = socket;
}

function emit(eventName, payload) {
  return new Promise((resolve, reject) => {
    if (!state.socket?.connected) {
      reject(new Error("Disconnected. Nothing was sent or queued; reconnect before trying again."));
      return;
    }

    // A lost acknowledgment must not freeze row repainting indefinitely.
    let finished = false;
    const timeoutId = window.setTimeout(() => {
      if (finished) return;
      finished = true;
      reject(new Error("Save confirmation timed out. Check the board before retrying; the change may have reached the server."));
    }, 20000);
    try {
      state.socket.emit(eventName, payload, (response) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeoutId);
        if (response?.ok) resolve(response);
        else reject(new Error(response?.error || "Request failed."));
      });
    } catch (error) {
      if (!finished) {
        finished = true;
        window.clearTimeout(timeoutId);
        reject(error);
      }
    }
  });
}

function applyGeneratorSettingsToForm() {
  state.generatorSettings = normalizeGeneratorSettings(state.generatorSettings);
  elements.generatorForm.dataset.randomSize = String(state.generatorSettings.randomSize);
  elements.generatorForm.dataset.wordCount = String(state.generatorSettings.wordCount);

  Object.entries(state.generatorSettings).forEach(([key, value]) => {
    const field = elements.generatorForm.elements.namedItem(key);
    if (!field) {
      return;
    }

    if (field instanceof RadioNodeList) {
      Array.from(field).forEach((option) => {
        option.checked = option.value === value;
      });
      return;
    }

    if (field.type === "checkbox") {
      field.checked = Boolean(value);
      return;
    }

    field.value = value;
  });

  syncGeneratorModeUi();
}

function syncGeneratorModeUi() {
  const mode = elements.generatorForm.elements.namedItem("mode").value || "random";
  const slider = elements.generatorSlider;
  const isWords = mode === "words";
  const randomSize = Number(elements.generatorForm.dataset.randomSize) || state.generatorSettings.randomSize;
  const wordCount = Number(elements.generatorForm.dataset.wordCount) || state.generatorSettings.wordCount;

  elements.generatorSliderLabel.textContent = isWords ? "Words" : "Length";
  slider.min = isWords ? "2" : "8";
  slider.max = isWords ? "8" : "64";
  slider.value = String(isWords ? wordCount : randomSize);
  elements.generatorSliderValue.textContent = slider.value;

  document.querySelectorAll(".generator-random-option").forEach((node) => {
    node.hidden = isWords;
  });
  document.querySelectorAll(".generator-word-option").forEach((node) => {
    node.hidden = !isWords;
  });

  updateGeneratorPreview();
}

function updateGeneratorPreview(settings = readGeneratorSettingsFromForm()) {
  try {
    elements.generatorPreview.textContent = generatePassword(settings);
  } catch (error) {
    elements.generatorPreview.textContent = error.message || "Unable to generate preview.";
  }
}

function readGeneratorSettingsFromForm() {
  const form = elements.generatorForm;
  const previousSettings = normalizeGeneratorSettings(state.generatorSettings);
  const mode = form.elements.namedItem("mode").value || "random";
  const activeSliderValue = Number(elements.generatorSlider.value) || getGeneratorSize(previousSettings);
  const draftRandomSize = Number(form.dataset.randomSize) || previousSettings.randomSize;
  const draftWordCount = Number(form.dataset.wordCount) || previousSettings.wordCount;

  return normalizeGeneratorSettings({
    mode,
    randomSize: mode === "random" ? activeSliderValue : draftRandomSize,
    wordCount: mode === "words" ? activeSliderValue : draftWordCount,
    separator: form.elements.namedItem("separator").value,
    uppercase: form.elements.namedItem("uppercase").checked,
    lowercase: form.elements.namedItem("lowercase").checked,
    numbers: form.elements.namedItem("numbers").checked,
    symbols: form.elements.namedItem("symbols").checked,
    excludeSimilar: form.elements.namedItem("excludeSimilar").checked
  });
}

function promptForDisplayName(roomKey) {
  return new Promise((resolve) => {
    const savedName = localStorage.getItem(getDisplayNameStorageKey(roomKey)) || "";
    if (savedName) {
      resolve(savedName);
      return;
    }

    elements.displayNameInput.value = savedName;
    const preventClose = (event) => event.preventDefault();
    elements.nameDialog.addEventListener("cancel", preventClose, { once: true });
    elements.nameDialog.showModal();
    elements.displayNameInput.focus();
    elements.displayNameInput.select();

    const handleSubmit = (event) => {
      event.preventDefault();
      const displayName = elements.displayNameInput.value.trim().slice(0, 40);
      if (!displayName) {
        elements.displayNameInput.reportValidity();
        return;
      }

      localStorage.setItem(getDisplayNameStorageKey(roomKey), displayName);
      elements.nameDialog.close();
      elements.nameForm.removeEventListener("submit", handleSubmit);
      resolve(displayName);
    };

    elements.nameForm.addEventListener("submit", handleSubmit);
  });
}

function setFreshGeneratedPassword(targetInput) {
  targetInput.value = generatePassword();
}

// Replace native long-delay button tooltips with consistent 250ms hover hints.
function applyButtonTooltips(root = document) {
  const targets = [
    '[data-action="copy-username"]',
    '[data-action="copy-password"]',
    '[data-action="show-password-large"]',
    '[data-action="generate-password"]',
    '.history-menu summary',
    '.history-entry button',
    '#copy-room-link', '#view-room-link',
    '#copy-new-item-username', '#copy-new-item-password',
    '#view-new-item-password', '#generate-new-item-password',
    '#copy-large-password', '#copy-large-room-link'
  ].join(", ");
  root.querySelectorAll(targets).forEach((element) => {
    const label = element.getAttribute("title");
    if (label) {
      element.dataset.tooltip = label;
      element.removeAttribute("title");
    }
    if (element.dataset.tooltip) element.classList.add("quick-tooltip");
  });
}

// Preserve in-progress edits across socket broadcasts (including presence changes).
// Server state is still updated immediately; only repainting the form is deferred.
let pendingItemSaves = 0;
let deferredItemRender = false;
let boardNameSavePending = false;

function isItemInputFocused() {
  const focused = document.activeElement;
  return Boolean(focused && elements.itemsContainer.contains(focused) && focused.matches("input[data-field]"));
}

function flushDeferredItems() {
  if (deferredItemRender && pendingItemSaves === 0 && !isItemInputFocused()) renderItems();
}

elements.itemsContainer.addEventListener("focusout", () => {
  queueMicrotask(flushDeferredItems);
});

function renderItems() {
  elements.itemCount.textContent = `${state.items.length} item${state.items.length === 1 ? "" : "s"}`;
  if (isItemInputFocused() || pendingItemSaves > 0) {
    deferredItemRender = true;
    return;
  }
  deferredItemRender = false;
  elements.itemsContainer.innerHTML = "";

  state.items.forEach((item) => {
    const fragment = elements.itemTemplate.content.cloneNode(true);
    const row = fragment.querySelector(".board-row");
    const dragHandle = fragment.querySelector("[data-drag-handle]");
    const nameInput = fragment.querySelector('[data-field="name"]');
    const ipInput = fragment.querySelector('[data-field="ip"]');
    const usernameInput = fragment.querySelector('[data-field="username"]');
    const passwordInput = fragment.querySelector('[data-field="password"]');
    const historyList = fragment.querySelector("[data-history]");
    const updatedLabel = fragment.querySelector('[data-meta="updated-at"]');
    const auditLabel = fragment.querySelector('[data-meta="audit"]');
    const historyMenu = fragment.querySelector(".history-menu");
    row.dataset.itemId = item.id;

    nameInput.value = item.name;
    ipInput.value = item.ip || "";
    usernameInput.value = item.username;
    passwordInput.value = item.password;
    passwordInput.type = state.passwordsHidden ? "password" : "text";
    updatedLabel.dataset.timestampValue = item.updatedAt;
    updatedLabel.dataset.timestampActor = item.updatedBy || "";

    historyList.innerHTML = "";
    const visibleCount = state.historyVisibleCounts[item.id] || HISTORY_PREVIEW_LIMIT;
    // Sort historical entries newest-first regardless of backend or import order.
    // The current password always appears above prior versions.
    const historyEntries = [
      {
        password: item.password,
        createdAt: item.passwordCreatedAt || item.createdAt,
        createdBy: item.passwordCreatedBy || item.createdBy,
        current: true
      },
      ...[...item.history]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, visibleCount)
    ];
    historyEntries.forEach((entry) => {
      const wrapper = document.createElement("div");
      wrapper.className = entry.current ? "history-entry current" : "history-entry";
      wrapper.title = formatAbsoluteDate(entry.createdAt);

      const date = document.createElement("strong");
      date.textContent = `${entry.current ? "Current · " : ""}${formatRelativeDate(entry.createdAt)}${entry.createdBy ? ` by ${entry.createdBy}` : ""}`;

      const value = document.createElement("span");
      value.textContent = state.passwordsHidden ? "••••••••" : entry.password;

      const copyButton = document.createElement("button");
      copyButton.className = "secondary";
      copyButton.textContent = "Copy";
      copyButton.title = "Copy password";
      copyButton.addEventListener("click", async () => {
        await navigator.clipboard.writeText(entry.password);
      });

      wrapper.append(date, value, copyButton);
      historyList.appendChild(wrapper);
    });

    if (!item.history.length) {
      const emptyHistory = document.createElement("div");
      emptyHistory.className = "history-empty";
      emptyHistory.textContent = "No previous passwords yet.";
      historyList.appendChild(emptyHistory);
    } else if (item.history.length > visibleCount) {
      const showMoreButton = document.createElement("button");
      showMoreButton.className = "secondary history-more-button";
      showMoreButton.title = "Show older password history";
      const remaining = item.history.length - visibleCount;
      const increment = Math.min(HISTORY_PREVIEW_LIMIT, remaining);
      showMoreButton.textContent = `Show ${increment} older`;
      showMoreButton.addEventListener("click", (event) => {
        event.preventDefault();
        state.historyVisibleCounts[item.id] = visibleCount + HISTORY_PREVIEW_LIMIT;
        renderItems();
        const refreshedMenu = elements.itemsContainer.querySelector(`[data-item-id="${item.id}"] .history-menu`);
        if (refreshedMenu) refreshedMenu.open = true;
      });
      historyList.appendChild(showMoreButton);
    }

    historyMenu.querySelector("summary").addEventListener("click", () => {
      // Only one password history popover may be open at a time.
      document.querySelectorAll(".history-menu[open]").forEach((other) => {
        if (other !== historyMenu) other.open = false;
      });
    });

    auditLabel.textContent = `Created by ${item.createdBy || "unknown"} · ${item.passwordRotationCount || 0} rotation${item.passwordRotationCount === 1 ? "" : "s"}`;

    [nameInput, ipInput, usernameInput].forEach((input) => {
      input.addEventListener("change", async () => {
        const field = input.dataset.field;
        const expectedValue = String(item[field] ?? "");
        if (input.value === expectedValue) return;
        pendingItemSaves++;
        let saved = false;
        try {
          await emit("item:updateMeta", {
            id: item.id, field, value: input.value, expectedValue
          });
          saved = true;
        } catch (error) {
          alert(`${error.message} Your typed value is still visible; copy it before refreshing.`);
          input.focus();
        } finally {
          pendingItemSaves--;
          if (saved) renderItems();
          else flushDeferredItems();
        }
      });
    });

    const commitPasswordEdit = async () => {
      const nextPassword = passwordInput.value;
      if (nextPassword === item.password) return;
      pendingItemSaves++;
      let saved = false;
      try {
        await emit("item:updatePassword", {
          id: item.id,
          password: nextPassword,
          expectedPassword: item.password
        });
        saved = true;
      } catch (error) {
        alert(`${error.message} Your typed password is still visible; copy it before refreshing.`);
        passwordInput.focus();
      } finally {
        pendingItemSaves--;
        if (saved) renderItems();
        else flushDeferredItems();
      }
    };

    passwordInput.addEventListener("blur", commitPasswordEdit);

    passwordInput.addEventListener("keydown", async (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        passwordInput.blur();
      }

      if (event.key === "Escape") {
        passwordInput.value = item.password;
        passwordInput.blur();
      }
    });

    fragment
      .querySelector('[data-action="copy-username"]')
      .addEventListener("click", async (event) => {
        await copyWithFeedback(event.currentTarget, usernameInput.value);
      });

    fragment
      .querySelector('[data-action="copy-password"]')
      .addEventListener("click", async (event) => {
        await copyWithFeedback(event.currentTarget, passwordInput.value);
      });

    fragment
      .querySelector('[data-action="generate-password"]')
      .addEventListener("click", async () => {
        try {
          await emit("item:updatePassword", {
            id: item.id,
            password: generatePassword(),
            expectedPassword: item.password
          });
          historyMenu.open = false;
        } catch (error) {
          alert(error.message || "Unable to generate password.");
        }
      });

    fragment
      .querySelector('[data-action="show-password-large"]')
      .addEventListener("click", () => {
        openLargePasswordView(passwordInput.value);
      });

    fragment
      .querySelector('[data-action="delete-item"]')
      .addEventListener("click", async () => {
        if (!window.confirm(`Permanently delete "${item.name}" and ALL its password history?`)) return;
        try {
          await emit("item:delete", { id: item.id });
        } catch (error) {
          alert(error.message || "Unable to delete item.");
        }
      });

    dragHandle.addEventListener("dragstart", (event) => {
      state.draggedItemId = item.id;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.id);
    });

    dragHandle.addEventListener("dragend", () => {
      state.draggedItemId = null;
      row.classList.remove("dragging");
      elements.itemsContainer.querySelectorAll(".drop-target").forEach((node) => {
        node.classList.remove("drop-target");
      });
    });

    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!state.draggedItemId || state.draggedItemId === item.id) {
        return;
      }
      row.classList.add("drop-target");
    });

    row.addEventListener("dragleave", () => {
      row.classList.remove("drop-target");
    });

    row.addEventListener("drop", async (event) => {
      event.preventDefault();
      row.classList.remove("drop-target");
      if (!state.draggedItemId || state.draggedItemId === item.id) {
        return;
      }

      const orderedIds = state.items.map((entry) => entry.id);
      const fromIndex = orderedIds.indexOf(state.draggedItemId);
      const toIndex = orderedIds.indexOf(item.id);
      if (fromIndex === -1 || toIndex === -1) {
        return;
      }

      const [movedId] = orderedIds.splice(fromIndex, 1);
      orderedIds.splice(toIndex, 0, movedId);
      try {
        await emit("items:reorder", { orderedIds });
      } catch (error) {
        alert(error.message || "Unable to reorder items.");
      }
    });

    applyButtonTooltips(fragment);
    elements.itemsContainer.appendChild(fragment);
  });

  updatePasswordVisibilityUi();
  updateRelativeTimestamps();
}

document.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".history-menu")) return;
  document.querySelectorAll(".history-menu[open]").forEach((menu) => {
    menu.open = false;
  });
});

elements.createRoomButton.addEventListener("click", createRoom);

elements.leaveRoomButton.addEventListener("click", () => {
  if (state.socket) {
    state.socket.disconnect();
  }
  clearStoredRoomSession();
  window.location.assign("/");
});

elements.destroyRoomButton.addEventListener("click", async () => {
  const confirmed = window.confirm("Destroy this room and permanently delete all stored passwords?");
  if (!confirmed) {
    return;
  }

  try {
    await emit("room:destroy", {});
  } catch (error) {
    alert(error.message || "Unable to destroy the room.");
  }
});

elements.joinRoomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const roomKey = extractRoomKey(elements.roomKeyInput.value);
  if (!isUuid(roomKey)) {
    alert("Enter a valid room UUID or PassBoard room link.");
    return;
  }

  elements.roomKeyInput.value = roomKey;
  window.location.assign(`/room/${roomKey}`);
});

elements.copyRoomLink.addEventListener("click", async (event) => {
  await copyWithFeedback(event.currentTarget, getRoomJoinUrl());
});

elements.viewRoomLink.addEventListener("click", () => {
  openLargeRoomLinkView();
});

elements.copyNewItemUsername.addEventListener("click", async (event) => {
  await copyWithFeedback(event.currentTarget, elements.newItemUsername.value);
});

elements.copyNewItemPassword.addEventListener("click", async (event) => {
  await copyWithFeedback(event.currentTarget, elements.newItemPassword.value);
});

elements.togglePasswordVisibility.addEventListener("click", () => {
  state.passwordsHidden = !state.passwordsHidden;
  renderItems();
});

elements.exportBoardButton.addEventListener("click", () => {
  const confirmed = window.confirm("Exports contain plaintext passwords. Continue?");
  if (!confirmed) {
    return;
  }

  const slug = state.boardName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "board";
  downloadJson(`${slug}-${formatFilenameTimestamp()}.json`, buildExportPayload());
});

let importInProgress = false;
let importExpectedRevision = 0;
elements.importBoardButton.addEventListener("click", () => {
  if (importInProgress) return;
  importExpectedRevision = state.boardRevision;
  elements.importBoardInput.click();
});

elements.importBoardInput.addEventListener("change", async () => {
  const file = elements.importBoardInput.files?.[0];
  if (!file || importInProgress) return;
  importInProgress = true;
  elements.importBoardButton.disabled = true;
  try {
    await importBoardFromFile(file, importExpectedRevision);
  } catch (error) {
    alert(error.message || "Import failed; existing entries were preserved.");
  } finally {
    importInProgress = false;
    elements.importBoardButton.disabled = false;
    elements.importBoardInput.value = "";
  }
});

elements.boardNameInput.addEventListener("focus", () => {
  elements.boardNameInput.dataset.originalName = state.boardName;
});
elements.boardNameInput.addEventListener("change", async () => {
  const trimmed = elements.boardNameInput.value.trim();
  elements.boardNameInput.value = trimmed || "Untitled Board";
  if (elements.boardNameInput.value === elements.boardNameInput.dataset.originalName) return;
  boardNameSavePending = true;
  try {
    await emit("room:updateName", {
      name: elements.boardNameInput.value,
      expectedName: elements.boardNameInput.dataset.originalName
    });
  } catch (error) {
    alert(`${error.message} Your draft board name was not saved.`);
    elements.boardNameInput.focus();
  } finally {
    boardNameSavePending = false;
  }
});

elements.generateNewItemPassword.addEventListener("click", () => {
  setFreshGeneratedPassword(elements.newItemPassword);
});

elements.viewNewItemPassword.addEventListener("click", () => {
  openLargePasswordView(elements.newItemPassword.value);
});

elements.copyLargePassword.addEventListener("click", async (event) => {
  await copyWithFeedback(event.currentTarget, event.currentTarget.dataset.passwordValue || "");
});

elements.copyLargeRoomLink.addEventListener("click", async (event) => {
  await copyWithFeedback(event.currentTarget, event.currentTarget.dataset.roomLinkValue || "");
});

let itemCreateInProgress = false;
elements.createItemForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (itemCreateInProgress) return;
  itemCreateInProgress = true;
  const submitButton = elements.createItemForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  const formData = new FormData(elements.createItemForm);
  try {
    await emit("item:create", {
      name: formData.get("name"),
      ip: formData.get("ip"),
      username: formData.get("username"),
      password: formData.get("password")
    });
    elements.createItemForm.reset();
    setFreshGeneratedPassword(elements.newItemPassword);
  } catch (error) {
    alert(error.message || "Unable to add item. Your entries are still in the form.");
  } finally {
    itemCreateInProgress = false;
    submitButton.disabled = false;
  }
});

let generatorSettingsAtOpen = null;
elements.openGeneratorSettings.addEventListener("click", () => {
  applyGeneratorSettingsToForm();
  generatorSettingsAtOpen = { ...state.generatorSettings };
  elements.generatorDialog.showModal();
});

elements.generatorSlider.addEventListener("input", () => {
  const mode = elements.generatorForm.elements.namedItem("mode").value || "random";
  if (mode === "words") {
    elements.generatorForm.dataset.wordCount = elements.generatorSlider.value;
  } else {
    elements.generatorForm.dataset.randomSize = elements.generatorSlider.value;
  }
  elements.generatorSliderValue.textContent = elements.generatorSlider.value;
  updateGeneratorPreview();
});

Array.from(elements.generatorForm.elements.namedItem("mode")).forEach((radio) => {
  radio.addEventListener("change", syncGeneratorModeUi);
});

["separator", "uppercase", "lowercase", "numbers", "symbols", "excludeSimilar"].forEach((fieldName) => {
  const field = elements.generatorForm.elements.namedItem(fieldName);
  if (!field) {
    return;
  }
  field.addEventListener("input", () => {
    updateGeneratorPreview();
  });
  field.addEventListener("change", () => {
    updateGeneratorPreview();
  });
});

elements.generatorForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const nextSettings = readGeneratorSettingsFromForm();

  emit("room:updateGeneratorSettings", {
    generatorSettings: nextSettings,
    expectedGeneratorSettings: generatorSettingsAtOpen
  })
    .then(() => {
      state.generatorSettings = nextSettings;
      elements.generatorDialog.close();
      setFreshGeneratedPassword(elements.newItemPassword);
    })
    .catch((error) => {
      alert(error.message || "Unable to save generator settings.");
    });
});

async function initialize() {
  await loadWordList();
  applyGeneratorSettingsToForm();
  applyButtonTooltips();
  setInterval(updateRelativeTimestamps, 30000);

  const url = new URL(window.location.href);
  const queryRoomKey = extractRoomKey(url.searchParams.get("roomKey") || "");
  if (queryRoomKey) {
    const previousRoomKey = getStoredActiveRoomKey();
    if (previousRoomKey && previousRoomKey !== queryRoomKey && isUuid(previousRoomKey)) {
      const switchRooms = window.confirm(
        "You already have a PassBoard room open. Leave that room and switch to this one? " +
        "Leaving will NOT delete its passwords or destroy the board."
      );
      if (!switchRooms) {
        window.location.replace(`/room?roomKey=${encodeURIComponent(previousRoomKey)}`);
        return;
      }
    }
    setStoredActiveRoomKey(queryRoomKey);
    window.history.replaceState({}, "", "/room");
  }

  const roomKey = window.location.pathname === "/room" ? getStoredActiveRoomKey() : null;

  if (!roomKey) {
    return;
  }

  if (!isUuid(roomKey)) {
    clearStoredRoomSession(roomKey);
    alert("That room link is not a valid UUID.");
    return;
  }

  const actorName = await promptForDisplayName(roomKey);
  showBoard(roomKey, actorName);
  setConnectionStatus("connecting");

  try {
    await bootstrapRoom(roomKey);
    connectSocket(roomKey, actorName);
  } catch (error) {
    if (error.statusCode === 404 || /expired|not found/i.test(error.message || "")) {
      clearStoredRoomSession(roomKey);
    }
    throw error;
  }
}

initialize().catch((error) => {
  alert(error.message || "Something went wrong while opening the room.");
});
