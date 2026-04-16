const DEFAULT_GENERATOR_SETTINGS = {
  mode: "random",
  randomSize: 20,
  wordCount: 3,
  separator: "-",
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbols: true,
  excludeSimilar: true
};

const state = {
  roomKey: null,
  actorName: "",
  socket: null,
  boardName: "Untitled Board",
  generatorSettings: normalizeGeneratorSettings(),
  wordList: [],
  items: [],
  activeUsers: [],
  passwordsHidden: false,
  lastSyncedAt: null,
  connectionState: "connecting",
  draggedItemId: null
};

const elements = {
  roomNavbar: document.getElementById("room-navbar"),
  homeButton: document.getElementById("home-button"),
  leaveRoomButton: document.getElementById("leave-room-button"),
  boardView: document.getElementById("board-view"),
  hero: document.querySelector(".hero"),
  securityNotes: document.getElementById("security-notes"),
  roomKeyInput: document.getElementById("room-key-input"),
  joinRoomForm: document.getElementById("join-room-form"),
  createRoomButton: document.getElementById("create-room-button"),
  roomLink: document.getElementById("room-link"),
  copyRoomLink: document.getElementById("copy-room-link"),
  connectionStatus: document.getElementById("board-live-indicator"),
  connectionLabel: document.getElementById("connection-label"),
  connectionDetail: document.getElementById("connection-detail"),
  togglePasswordVisibility: document.getElementById("toggle-password-visibility"),
  exportBoardButton: document.getElementById("export-board-button"),
  importBoardButton: document.getElementById("import-board-button"),
  importBoardInput: document.getElementById("import-board-input"),
  boardNameInput: document.getElementById("board-name-input"),
  signedInName: document.getElementById("signed-in-name"),
  activeUsersList: document.getElementById("active-users-list"),
  createItemForm: document.getElementById("create-item-form"),
  newItemUsername: document.getElementById("new-item-username"),
  newItemPassword: document.getElementById("new-item-password"),
  copyNewItemUsername: document.getElementById("copy-new-item-username"),
  copyNewItemPassword: document.getElementById("copy-new-item-password"),
  generateNewItemPassword: document.getElementById("generate-new-item-password"),
  itemsContainer: document.getElementById("items-container"),
  itemCount: document.getElementById("item-count"),
  itemTemplate: document.getElementById("item-template"),
  generatorDialog: document.getElementById("generator-dialog"),
  generatorForm: document.getElementById("generator-form"),
  generatorSlider: document.getElementById("generator-size"),
  generatorSliderLabel: document.getElementById("generator-slider-label"),
  generatorSliderValue: document.getElementById("generator-slider-value"),
  openGeneratorSettings: document.getElementById("open-generator-settings"),
  nameDialog: document.getElementById("name-dialog"),
  nameForm: document.getElementById("name-form"),
  displayNameInput: document.getElementById("display-name-input")
};

function getDisplayNameStorageKey(roomKey) {
  return `password-board-display-name:${roomKey}`;
}

function normalizeGeneratorSettings(settings = {}) {
  const mode = settings.mode === "words" ? "words" : "random";
  const randomSize = Math.min(64, Math.max(8, Number(settings.randomSize ?? settings.size ?? 20) || 20));
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

function updateRelativeTimestamps() {
  document.querySelectorAll("[data-timestamp-value]").forEach((node) => {
    const timestamp = node.dataset.timestampValue;
    const actor = node.dataset.timestampActor;
    node.textContent = `Updated ${formatRelativeDate(timestamp)}${actor ? ` by ${actor}` : ""}`;
    node.title = formatAbsoluteDate(timestamp);
  });

  if (state.connectionState === "live" && state.lastSyncedAt) {
    elements.connectionDetail.textContent = `Last updated ${formatRelativeDate(state.lastSyncedAt)}`;
    elements.connectionDetail.title = formatAbsoluteDate(state.lastSyncedAt);
  }
}

function setConnectionStatus(variant, detail) {
  state.connectionState = variant;
  elements.connectionStatus.classList.remove("live", "offline", "connecting");
  elements.connectionStatus.classList.add(variant);

  if (variant === "live") {
    elements.connectionLabel.textContent = "Live";
    elements.connectionDetail.textContent = detail || "Live sync active";
  } else if (variant === "offline") {
    elements.connectionLabel.textContent = "Disconnected";
    elements.connectionDetail.textContent = detail || "Trying to reconnect";
  } else {
    elements.connectionLabel.textContent = "Connecting";
    elements.connectionDetail.textContent = detail || "Waiting for first sync";
  }
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

function buildExportPayload() {
  return {
    format: "password-board-v1",
    exportedAt: new Date().toISOString(),
    exportedBy: state.actorName,
    boardName: state.boardName,
    generatorSettings: state.generatorSettings,
    items: state.items.map((item) => ({
      sortOrder: item.sortOrder,
      name: item.name,
      port: item.port,
      username: item.username,
      password: item.password,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      updatedBy: item.updatedBy,
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

async function importBoardFromFile(file) {
  const text = await file.text();
  const payload = JSON.parse(text);
  if (!payload || !Array.isArray(payload.items)) {
    throw new Error("Import file must contain a board object with an items array.");
  }

  await emit("room:import", {
    boardName: payload.boardName,
    generatorSettings: payload.generatorSettings,
    items: payload.items
  });
}

function showBoard(roomKey, actorName) {
  state.roomKey = roomKey;
  state.actorName = actorName;
  elements.hero.classList.add("hidden");
  elements.securityNotes.classList.add("hidden");
  elements.roomNavbar.classList.remove("hidden");
  elements.boardView.classList.remove("hidden");
  elements.roomLink.value = new URL(`/room/${roomKey}`, window.location.origin).toString();
  elements.signedInName.textContent = actorName;
  elements.newItemPassword.value = generatePassword();
}

async function createRoom() {
  const response = await fetch("/api/rooms/new");
  const payload = await response.json();
  window.location.assign(payload.url);
}

async function bootstrapRoom(roomKey) {
  const response = await fetch(`/api/rooms/${roomKey}/bootstrap`);
  if (!response.ok) {
    throw new Error("Unable to open that room.");
  }

  const payload = await response.json();
  state.items = payload.items;
  state.activeUsers = payload.activeUsers || [];
  state.boardName = payload.boardName || "Untitled Board";
  state.generatorSettings = normalizeGeneratorSettings(payload.generatorSettings);
  state.lastSyncedAt = new Date().toISOString();
  elements.boardNameInput.value = state.boardName;
  document.title = `${state.boardName} | PassBoard`;
  applyGeneratorSettingsToForm();
  renderActiveUsers();
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
    setConnectionStatus("live", state.lastSyncedAt ? `Last updated ${formatRelativeDate(state.lastSyncedAt)}` : "Live sync active");
  });

  socket.on("disconnect", (reason) => {
    const detail = reason === "io server disconnect" ? "Server disconnected" : "Trying to reconnect";
    setConnectionStatus("offline", detail);
  });

  socket.on("connect_error", (error) => {
    setConnectionStatus("offline", error.message || "Unable to connect");
  });

  socket.on("room:state", (payload) => {
    state.items = payload.items;
    state.activeUsers = payload.activeUsers || [];
    state.boardName = payload.boardName || "Untitled Board";
    state.generatorSettings = normalizeGeneratorSettings(payload.generatorSettings);
    state.lastSyncedAt = new Date().toISOString();
    elements.boardNameInput.value = state.boardName;
    document.title = `${state.boardName} | PassBoard`;
    applyGeneratorSettingsToForm();
    renderActiveUsers();
    renderItems();
    setConnectionStatus("live", `Last updated ${formatRelativeDate(state.lastSyncedAt)}`);
  });

  state.socket = socket;
}

function emit(eventName, payload) {
  return new Promise((resolve, reject) => {
    if (!state.socket) {
      reject(new Error("Not connected."));
      return;
    }

    state.socket.emit(eventName, payload, (response) => {
      if (response?.ok) {
        resolve(response);
        return;
      }

      reject(new Error(response?.error || "Request failed."));
    });
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
  const settings = readGeneratorSettingsFromForm();

  elements.generatorSliderLabel.textContent = isWords ? "Words" : "Length";
  slider.min = isWords ? "2" : "8";
  slider.max = isWords ? "8" : "64";
  slider.value = String(isWords ? settings.wordCount : settings.randomSize);
  elements.generatorSliderValue.textContent = slider.value;

  document.querySelectorAll(".generator-random-option").forEach((node) => {
    node.hidden = isWords;
  });
  document.querySelectorAll(".generator-word-option").forEach((node) => {
    node.hidden = !isWords;
  });
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

function renderItems() {
  elements.itemCount.textContent = `${state.items.length} item${state.items.length === 1 ? "" : "s"}`;
  elements.itemsContainer.innerHTML = "";

  state.items.forEach((item) => {
    const fragment = elements.itemTemplate.content.cloneNode(true);
    const row = fragment.querySelector(".board-row");
    const nameInput = fragment.querySelector('[data-field="name"]');
    const portInput = fragment.querySelector('[data-field="port"]');
    const usernameInput = fragment.querySelector('[data-field="username"]');
    const passwordInput = fragment.querySelector('[data-field="password"]');
    const historyList = fragment.querySelector("[data-history]");
    const updatedLabel = fragment.querySelector('[data-meta="updated-at"]');
    const historyMenu = fragment.querySelector(".history-menu");
    row.dataset.itemId = item.id;

    nameInput.value = item.name;
    portInput.value = item.port;
    usernameInput.value = item.username;
    passwordInput.value = item.password;
    passwordInput.type = state.passwordsHidden ? "password" : "text";
    updatedLabel.dataset.timestampValue = item.updatedAt;
    updatedLabel.dataset.timestampActor = item.updatedBy || "";

    if (!item.history.length) {
      historyList.innerHTML = '<div class="history-entry">No previous passwords yet.</div>';
    } else {
      historyList.innerHTML = "";
      item.history.forEach((entry) => {
        const wrapper = document.createElement("div");
        wrapper.className = "history-entry";
        wrapper.title = formatAbsoluteDate(entry.createdAt);

        const date = document.createElement("strong");
        date.textContent = `${formatRelativeDate(entry.createdAt)}${entry.createdBy ? ` by ${entry.createdBy}` : ""}`;

        const value = document.createElement("span");
        value.textContent = state.passwordsHidden ? "••••••••" : entry.password;

        const copyButton = document.createElement("button");
        copyButton.className = "secondary";
        copyButton.textContent = "Copy";
        copyButton.addEventListener("click", async () => {
          await navigator.clipboard.writeText(entry.password);
        });

        wrapper.append(date, value, copyButton);
        historyList.appendChild(wrapper);
      });
    }

    [nameInput, portInput, usernameInput].forEach((input) => {
      input.addEventListener("change", async () => {
        await emit("item:updateMeta", {
          id: item.id,
          name: nameInput.value,
          port: portInput.value,
          username: usernameInput.value
        });
      });
    });

    const commitPasswordEdit = async () => {
      const nextPassword = passwordInput.value;
      if (nextPassword === item.password) {
        return;
      }

      await emit("item:updatePassword", {
        id: item.id,
        password: nextPassword
      });
    };

    passwordInput.addEventListener("blur", async () => {
      await commitPasswordEdit();
    });

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
        await emit("item:updatePassword", {
          id: item.id,
          password: generatePassword()
        });
        historyMenu.open = false;
      });

    fragment
      .querySelector('[data-action="delete-item"]')
      .addEventListener("click", async () => {
        await emit("item:delete", { id: item.id });
      });

    row.addEventListener("dragstart", (event) => {
      state.draggedItemId = item.id;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.id);
    });

    row.addEventListener("dragend", () => {
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
      await emit("items:reorder", { orderedIds });
    });

    elements.itemsContainer.appendChild(fragment);
  });

  updatePasswordVisibilityUi();
  updateRelativeTimestamps();
}

elements.createRoomButton.addEventListener("click", createRoom);

elements.homeButton.addEventListener("click", () => {
  window.location.assign("/");
});

elements.leaveRoomButton.addEventListener("click", () => {
  if (state.socket) {
    state.socket.disconnect();
  }
  window.location.assign("/");
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
  await copyWithFeedback(event.currentTarget, elements.roomLink.value);
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
  const slug = state.boardName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "board";
  downloadJson(`${slug}.json`, buildExportPayload());
});

elements.importBoardButton.addEventListener("click", () => {
  elements.importBoardInput.click();
});

elements.importBoardInput.addEventListener("change", async () => {
  const file = elements.importBoardInput.files?.[0];
  if (!file) {
    return;
  }

  try {
    await importBoardFromFile(file);
  } catch (error) {
    alert(error.message || "Import failed.");
  } finally {
    elements.importBoardInput.value = "";
  }
});

elements.boardNameInput.addEventListener("change", async () => {
  const trimmed = elements.boardNameInput.value.trim();
  elements.boardNameInput.value = trimmed || "Untitled Board";
  await emit("room:updateName", {
    name: elements.boardNameInput.value
  });
});

elements.generateNewItemPassword.addEventListener("click", () => {
  setFreshGeneratedPassword(elements.newItemPassword);
});

elements.createItemForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(elements.createItemForm);
  await emit("item:create", {
    name: formData.get("name"),
    port: formData.get("port"),
    username: formData.get("username"),
    password: formData.get("password")
  });

  elements.createItemForm.reset();
  setFreshGeneratedPassword(elements.newItemPassword);
});

elements.openGeneratorSettings.addEventListener("click", () => {
  applyGeneratorSettingsToForm();
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
});

Array.from(elements.generatorForm.elements.namedItem("mode")).forEach((radio) => {
  radio.addEventListener("change", syncGeneratorModeUi);
});

elements.generatorForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const nextSettings = readGeneratorSettingsFromForm();

  emit("room:updateGeneratorSettings", {
    generatorSettings: nextSettings
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
  applyGeneratorSettingsToForm();
  setInterval(updateRelativeTimestamps, 30000);
  await loadWordList();

  const roomKey = window.location.pathname.startsWith("/room/")
    ? window.location.pathname.split("/room/")[1]
    : null;

  if (!roomKey) {
    return;
  }

  if (!isUuid(roomKey)) {
    alert("That room link is not a valid UUID.");
    return;
  }

  const actorName = await promptForDisplayName(roomKey);
  showBoard(roomKey, actorName);
  setConnectionStatus("connecting", "Waiting for first sync");
  await bootstrapRoom(roomKey);
  connectSocket(roomKey, actorName);
}

initialize().catch((error) => {
  console.error(error);
  alert(error.message || "Something went wrong while opening the room.");
});
