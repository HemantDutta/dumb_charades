const socket = io();

const elements = {
  pageShell: document.getElementById("page-shell"),
  connectionStatus: document.getElementById("connection-status"),
  layout: document.getElementById("layout"),
  joinPanel: document.getElementById("join-panel"),
  statusPanel: document.getElementById("status-panel"),
  secretPanel: document.getElementById("secret-panel"),
  guessPanelShell: document.getElementById("guess-panel-shell"),
  joinPanelTitle: document.getElementById("join-panel-title"),
  createRoomMode: document.getElementById("create-room-mode"),
  joinGameMode: document.getElementById("join-game-mode"),
  joinSettingsButton: document.getElementById("join-settings-button"),
  joinSettingsPreview: document.getElementById("join-settings-preview"),
  createSettings: document.getElementById("create-settings"),
  nameInput: document.getElementById("name-input"),
  roomInput: document.getElementById("room-input"),
  categorySelect: document.getElementById("category-select"),
  gameRoundsSelect: document.getElementById("game-rounds-select"),
  timerSelect: document.getElementById("timer-select"),
  joinCurrentCategory: document.getElementById("join-current-category"),
  joinCurrentGameRounds: document.getElementById("join-current-game-rounds"),
  joinCurrentRound: document.getElementById("join-current-round"),
  joinButton: document.getElementById("join-button"),
  joinError: document.getElementById("join-error"),
  roomCode: document.getElementById("room-code"),
  playerCount: document.getElementById("player-count"),
  statusBanner: document.getElementById("status-banner"),
  statusRoundValue: document.getElementById("status-round-value"),
  statusActorValue: document.getElementById("status-actor-value"),
  currentCategory: document.getElementById("current-category"),
  currentRound: document.getElementById("current-round"),
  currentGameRounds: document.getElementById("current-game-rounds"),
  countdown: document.getElementById("countdown"),
  settingsEditor: document.getElementById("settings-editor"),
  roomSettingsButton: document.getElementById("room-settings-button"),
  roomCategorySelect: document.getElementById("room-category-select"),
  roomGameRoundsSelect: document.getElementById("room-game-rounds-select"),
  roomTimerSelect: document.getElementById("room-timer-select"),
  saveSettingsButton: document.getElementById("save-settings-button"),
  leaderboardList: document.getElementById("leaderboard-list"),
  podium: document.getElementById("podium"),
  movieCard: document.getElementById("movie-card"),
  movieState: document.getElementById("movie-state"),
  movieTitle: document.getElementById("movie-title"),
  movieCopy: document.getElementById("movie-copy"),
  nextTurnButton: document.getElementById("next-turn-button"),
  startGameButton: document.getElementById("start-game-button"),
  playAgainButton: document.getElementById("play-again-button"),
  turnError: document.getElementById("turn-error"),
  guessForm: document.getElementById("guess-form"),
  guessInput: document.getElementById("guess-input"),
  guessButton: document.getElementById("guess-button"),
  guessFeed: document.getElementById("guess-feed"),
  guessError: document.getElementById("guess-error"),
  settingsOverlay: document.getElementById("settings-overlay"),
  settingsModalTitle: document.getElementById("settings-modal-title"),
  settingsModalCopy: document.getElementById("settings-modal-copy"),
  settingsCloseButton: document.getElementById("settings-close-button"),
  roundSummaryOverlay: document.getElementById("round-summary-overlay"),
  roundSummaryPopup: document.getElementById("round-summary-popup"),
  roundSummaryAnswer: document.getElementById("round-summary-answer"),
  roundSummaryPoints: document.getElementById("round-summary-points")
};

let roomState = null;
let countdownIntervalId = null;
let roundSummaryTimeoutId = null;
let joinMode = "create";
let settingsModalMode = null;
let reconnectMessageTimeoutId = null;
let lastJoinPayload = null;
let hadConnectionDrop = false;
let isRecoveringSession = false;

function setConnectionStatus(message = "", tone = "warning") {
  if (!message) {
    elements.connectionStatus.textContent = "";
    elements.connectionStatus.classList.add("hidden");
    elements.connectionStatus.classList.remove("warning", "success");
    return;
  }

  elements.connectionStatus.textContent = message;
  elements.connectionStatus.classList.remove("hidden", "warning", "success");
  elements.connectionStatus.classList.add(tone);
}

function scheduleConnectionStatusClear() {
  if (reconnectMessageTimeoutId) {
    window.clearTimeout(reconnectMessageTimeoutId);
  }

  reconnectMessageTimeoutId = window.setTimeout(() => {
    if (socket.connected) {
      setConnectionStatus();
    }
  }, 2500);
}

function applyConnectionState() {
  const isConnected = socket.connected && !isRecoveringSession;

  elements.joinButton.disabled = !isConnected;
  elements.joinSettingsButton.disabled = !isConnected;
  elements.roomSettingsButton.disabled = !isConnected || !roomState?.canChangeSettings;
  elements.saveSettingsButton.disabled = !isConnected;
  elements.nextTurnButton.disabled = !isConnected || !roomState?.isYourTurn;
  elements.startGameButton.disabled = !isConnected || !roomState?.canStartGame;
  elements.playAgainButton.disabled = !isConnected || !roomState?.canPlayAgain;

  if (!roomState) {
    return;
  }

  elements.guessInput.disabled = !isConnected || !roomState.canGuess;
  elements.guessButton.disabled = !isConnected || !roomState.canGuess;
}

function resetToLobby(message = "") {
  stopCountdown();
  stopRoundSummaryTimer();
  roomState = null;
  isRecoveringSession = false;
  elements.layout.classList.remove("room-active");
  elements.pageShell.classList.remove("room-live");
  elements.joinPanel.classList.remove("hidden");
  elements.statusPanel.classList.add("hidden");
  elements.secretPanel.classList.add("hidden");
  elements.guessPanelShell.classList.add("hidden");
  elements.joinError.textContent = message;
  elements.turnError.textContent = "";
  elements.guessError.textContent = "";
  elements.playAgainButton.classList.add("hidden");

  if (settingsModalMode) {
    closeSettingsModal();
  }

  applyConnectionState();
}

function attemptSessionRecovery() {
  if (!roomState || !lastJoinPayload) {
    isRecoveringSession = false;
    return;
  }

  isRecoveringSession = true;
  setConnectionStatus("Reconnected. Restoring room...", "success");
  applyConnectionState();
  socket.emit("join-room", {
    ...lastJoinPayload,
    joinMode: "join"
  });
}

function renderJoinSettingsSummary() {
  elements.joinCurrentCategory.textContent =
    elements.categorySelect.options[elements.categorySelect.selectedIndex]?.textContent || "Bollywood all eras";
  elements.joinCurrentGameRounds.textContent = `${elements.gameRoundsSelect.value} round${elements.gameRoundsSelect.value === "1" ? "" : "s"}`;
  elements.joinCurrentRound.textContent = `${elements.timerSelect.value} seconds`;
}

function closeSettingsModal() {
  settingsModalMode = null;
  elements.settingsOverlay.classList.add("hidden");
}

function openSettingsModal(mode) {
  const isRoomMode = mode === "room";

  settingsModalMode = mode;
  elements.settingsModalTitle.textContent = isRoomMode ? "Room settings" : "Create room settings";
  elements.settingsModalCopy.textContent = isRoomMode
    ? "Adjust the pack, game rounds, or timer before the fourth player joins."
    : "Choose the prompt pack, number of rounds, and round timer before you create the room.";
  elements.createSettings.classList.toggle("hidden", isRoomMode);
  elements.settingsEditor.classList.toggle("hidden", !isRoomMode || !roomState?.canChangeSettings);
  elements.settingsOverlay.classList.remove("hidden");
}

function setMovieTitleText(value) {
  elements.movieTitle.classList.remove("masked-title");
  elements.movieTitle.textContent = value;
}

function setMaskedMovieTitle(value) {
  const words = String(value || "")
    .split(/\s{3,}/)
    .map((word) => word.trim())
    .filter(Boolean);

  elements.movieTitle.classList.add("masked-title");
  elements.movieTitle.innerHTML = "";

  if (!words.length) {
    elements.movieTitle.textContent = "_";
    return;
  }

  words.forEach((word) => {
    const part = document.createElement("span");
    part.className = "masked-word";
    part.textContent = word.replace(/ /g, "\u00A0");
    elements.movieTitle.appendChild(part);
  });
}

function renderJoinMode() {
  const isCreateMode = joinMode === "create";

  elements.createRoomMode.classList.toggle("active", isCreateMode);
  elements.joinGameMode.classList.toggle("active", !isCreateMode);
  elements.joinSettingsButton.classList.toggle("hidden", !isCreateMode);
  elements.joinSettingsPreview.classList.toggle("hidden", !isCreateMode);
  elements.joinPanelTitle.textContent = isCreateMode ? "Create a room" : "Join a game";
  elements.joinButton.textContent = isCreateMode ? "Create room" : "Join game";

  if (!isCreateMode && settingsModalMode === "join") {
    closeSettingsModal();
  }

  applyConnectionState();
}

function stopCountdown() {
  if (countdownIntervalId) {
    window.clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }
}

function stopRoundSummaryTimer() {
  if (roundSummaryTimeoutId) {
    window.clearTimeout(roundSummaryTimeoutId);
    roundSummaryTimeoutId = null;
  }
}

function renderCountdown(turnEndsAt) {
  if (!turnEndsAt) {
    elements.countdown.textContent = "--";
    return;
  }

  const secondsLeft = Math.max(0, Math.ceil((turnEndsAt - Date.now()) / 1000));
  elements.countdown.textContent = `${secondsLeft}s`;
}

function syncSelectOptions(selectElement, options, selectedValue, formatLabel) {
  selectElement.innerHTML = "";

  options.forEach((option) => {
    const item = document.createElement("option");
    const value = String(option.value ?? option);
    item.value = value;
    item.textContent = formatLabel ? formatLabel(option) : option.label;

    if (value === String(selectedValue)) {
      item.selected = true;
    }

    selectElement.appendChild(item);
  });
}

function renderGuessFeed(feed) {
  elements.guessFeed.innerHTML = "";

  if (!feed?.length) {
    const empty = document.createElement("div");
    empty.className = "guess-empty";
    empty.textContent = "No correct guesses yet.";
    elements.guessFeed.appendChild(empty);
    return;
  }

  feed.forEach((entry) => {
    const item = document.createElement("div");
    item.className = `guess-message ${entry.type}`;
    item.textContent = entry.text;
    elements.guessFeed.appendChild(item);
  });
}

function renderLeaderboard(state) {
  elements.leaderboardList.innerHTML = "";

  state.leaderboard.forEach((entry) => {
    const isSelf = entry.id === state.selfId;
    const isActive = entry.id === state.activePlayerId;
    const row = document.createElement("div");
    row.className = `leaderboard-row${isSelf ? " self" : ""}${isActive ? " active" : ""}`;

    const rank = document.createElement("span");
    rank.className = "leaderboard-rank";
    rank.textContent = `#${entry.rank}`;

    const name = document.createElement("strong");
    name.className = "leaderboard-name";
    name.textContent = `${isActive ? "Acting now · " : ""}${entry.name}${isSelf ? " (You)" : ""}`;

    const score = document.createElement("span");
    score.className = "leaderboard-score";
    score.textContent = `${entry.score} pt${entry.score === 1 ? "" : "s"}`;

    row.append(rank, name, score);
    elements.leaderboardList.appendChild(row);
  });
}

function renderPodium(state) {
  elements.podium.innerHTML = "";
  elements.podium.classList.toggle("hidden", !state.isGameOver);

  if (!state.isGameOver) {
    return;
  }

  state.podium.forEach((entry, index) => {
    const card = document.createElement("div");
    const placeClass = ["first", "second", "third"][index] || "third";
    card.className = `podium-card ${placeClass}`;

    const place = document.createElement("div");
    place.className = "podium-place";
    place.textContent = `${index + 1}`;

    const name = document.createElement("p");
    name.className = "podium-name";
    name.textContent = entry.name;

    const score = document.createElement("p");
    score.className = "podium-score";
    score.textContent = `${entry.score} pt${entry.score === 1 ? "" : "s"}`;

    card.append(place, name, score);
    elements.podium.appendChild(card);
  });
}

function renderRoundSummary(state) {
  stopRoundSummaryTimer();

  if (!state.roundSummary || !state.revealEndsAt) {
    elements.roundSummaryOverlay.classList.add("hidden");
    return;
  }

  elements.roundSummaryAnswer.textContent = state.roundSummary.answer;
  elements.roundSummaryPoints.innerHTML = "";

  state.roundSummary.points.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "round-summary-row";

    const name = document.createElement("strong");
    name.textContent = entry.name;

    const earned = document.createElement("span");
    earned.className = "round-summary-points-earned";
    earned.textContent = `+${entry.earned}`;

    row.append(document.createElement("span"), name, earned);
    elements.roundSummaryPoints.appendChild(row);
  });

  elements.roundSummaryOverlay.classList.remove("hidden");

  const msLeft = Math.max(0, state.revealEndsAt - Date.now());
  roundSummaryTimeoutId = window.setTimeout(() => {
    elements.roundSummaryOverlay.classList.add("hidden");
  }, msLeft);
}

function renderGuessPanel(state) {
  renderGuessFeed(state.guessFeed);

  const disabled = !state.canGuess || !socket.connected;
  elements.guessInput.disabled = disabled;
  elements.guessButton.disabled = disabled;

  if (state.hasGuessedCurrentTurn || state.roundSummary || state.isGameOver) {
    elements.guessInput.value = "";
  }

  if (!state.isReady) {
    elements.guessInput.placeholder = "Waiting for players";
  } else if (state.isGameOver) {
    elements.guessInput.placeholder = "Game over";
  } else if (state.roundSummary) {
    elements.guessInput.placeholder = "Next turn starts soon";
  } else if (state.isYourTurn) {
    elements.guessInput.placeholder = "Actors cannot guess";
  } else if (state.hasGuessedCurrentTurn) {
    elements.guessInput.placeholder = "You already guessed correctly";
  } else {
    elements.guessInput.placeholder = "Type your guess";
  }
}

function renderStatusSummary(state, currentRoundNumber) {
  const displayRound = state.isGameOver ? state.gameRounds : currentRoundNumber;
  let actorLabel = "Waiting";

  if (state.isGameOver) {
    actorLabel = "Game over";
  } else if (state.activePlayerName) {
    actorLabel = state.activePlayerName;
  }

  elements.statusRoundValue.textContent = `${displayRound} / ${state.gameRounds}`;
  elements.statusActorValue.textContent = actorLabel;
}

function renderSecretCard(state) {
  if (!state.isReady) {
    elements.movieCard.classList.add("blank");
    elements.movieState.textContent = state.canStartGame
      ? `${state.playerCount} players ready`
      : `Waiting for ${state.minPlayers} players minimum`;
    setMovieTitleText(state.canStartGame ? "Ready to start" : "---");
    elements.movieCopy.textContent = "";
    elements.nextTurnButton.classList.add("hidden");
    elements.startGameButton.classList.toggle("hidden", !state.canStartGame);
    return;
  }

  elements.movieState.textContent = state.isYourTurn ? "Your turn" : "Guess this";
  elements.startGameButton.classList.add("hidden");

  if (state.isGameOver) {
    elements.movieCard.classList.add("blank");
    elements.movieState.textContent = "Game finished";
    setMovieTitleText("Game over");
    elements.movieCopy.textContent = "";
    elements.nextTurnButton.classList.add("hidden");
    return;
  }

  if (state.roundSummary) {
    elements.movieCard.classList.add("blank");
    elements.movieState.textContent = "Round summary";
    setMovieTitleText("Round complete");
    elements.movieCopy.textContent = "";
    elements.nextTurnButton.classList.add("hidden");
    return;
  }

  if (state.hasSecretMovie) {
    elements.movieCard.classList.remove("blank");
    setMovieTitleText(state.currentMovie);
    elements.movieCopy.textContent = "";
    elements.nextTurnButton.classList.remove("hidden");
    return;
  }

  elements.movieCard.classList.add("blank");
  setMaskedMovieTitle(state.maskedPrompt || "_");
  elements.movieCopy.textContent = "";
  elements.nextTurnButton.classList.add("hidden");
}

function renderRoomSettings(state) {
  elements.currentCategory.textContent = state.categoryLabel;
  elements.currentRound.textContent = `${state.roundSeconds} seconds`;
  elements.currentGameRounds.textContent = `${state.gameRounds} round${state.gameRounds === 1 ? "" : "s"}`;

  syncSelectOptions(
    elements.roomCategorySelect,
    state.datasetOptions,
    state.category,
    (option) => option.label
  );
  syncSelectOptions(
    elements.roomGameRoundsSelect,
    state.gameRoundOptions,
    state.gameRounds,
    (option) => `${option} round${Number(option) === 1 ? "" : "s"}`
  );
  syncSelectOptions(
    elements.roomTimerSelect,
    state.roundDurationOptions,
    state.roundSeconds,
    (option) => `${option} seconds`
  );

  elements.roomSettingsButton.classList.toggle("hidden", !state.canChangeSettings);

  if (!state.canChangeSettings && settingsModalMode === "room") {
    closeSettingsModal();
  }
}

function renderState(state) {
  stopCountdown();
  stopRoundSummaryTimer();
  roomState = state;
  elements.layout.classList.add("room-active");
  elements.pageShell.classList.add("room-live");
  elements.joinPanel.classList.add("hidden");
  elements.statusPanel.classList.remove("hidden");
  elements.secretPanel.classList.remove("hidden");
  elements.guessPanelShell.classList.remove("hidden");
  elements.joinError.textContent = "";
  elements.turnError.textContent = "";
  elements.guessError.textContent = "";
  elements.playAgainButton.classList.toggle("hidden", !state.canPlayAgain);

  if (settingsModalMode === "join") {
    closeSettingsModal();
  }

  elements.roomCode.textContent = state.roomCode;
  elements.playerCount.textContent = `${state.playerCount} / ${state.maxPlayers}`;
  renderRoomSettings(state);
  renderLeaderboard(state);
  renderPodium(state);
  renderGuessPanel(state);
  renderRoundSummary(state);
  renderCountdown(state.turnEndsAt);

  if (state.turnEndsAt) {
    countdownIntervalId = window.setInterval(() => {
      renderCountdown(roomState?.turnEndsAt);
    }, 250);
  }

  const currentRoundNumber = state.isGameOver
    ? state.gameRounds
    : Math.min(Math.floor(state.completedTurns / state.gamePlayerCount) + 1, state.gameRounds);
  renderStatusSummary(state, currentRoundNumber);

  renderSecretCard(state);
  applyConnectionState();
}

elements.joinButton.addEventListener("click", () => {
  const payload = {
    joinMode,
    name: elements.nameInput.value,
    roomCode: elements.roomInput.value,
    category: elements.categorySelect.value,
    gameRounds: Number(elements.gameRoundsSelect.value),
    roundSeconds: Number(elements.timerSelect.value)
  };

  lastJoinPayload = {
    ...payload,
    joinMode: "join"
  };
  elements.joinError.textContent = "";
  socket.emit("join-room", payload);
});

elements.createRoomMode.addEventListener("click", () => {
  joinMode = "create";
  elements.joinError.textContent = "";
  renderJoinMode();
});

elements.joinGameMode.addEventListener("click", () => {
  joinMode = "join";
  elements.joinError.textContent = "";
  renderJoinMode();
});

elements.joinSettingsButton.addEventListener("click", () => {
  if (joinMode !== "create") {
    return;
  }

  openSettingsModal("join");
});

elements.roomSettingsButton.addEventListener("click", () => {
  if (!roomState?.canChangeSettings) {
    return;
  }

  openSettingsModal("room");
});

elements.settingsCloseButton.addEventListener("click", () => {
  closeSettingsModal();
});

elements.settingsOverlay.addEventListener("click", (event) => {
  if (event.target === elements.settingsOverlay) {
    closeSettingsModal();
  }
});

elements.saveSettingsButton.addEventListener("click", () => {
  socket.emit("update-settings", {
    category: elements.roomCategorySelect.value,
    gameRounds: Number(elements.roomGameRoundsSelect.value),
    roundSeconds: Number(elements.roomTimerSelect.value)
  });
  closeSettingsModal();
});

elements.playAgainButton.addEventListener("click", () => {
  if (!roomState?.canPlayAgain) {
    return;
  }

  socket.emit("play-again");
});

elements.startGameButton.addEventListener("click", () => {
  if (!roomState?.canStartGame) {
    return;
  }

  socket.emit("start-game");
});

elements.guessForm.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!roomState?.canGuess) {
    return;
  }

  elements.guessError.textContent = "";
  socket.emit("submit-guess", {
    guess: elements.guessInput.value
  });
});

elements.nextTurnButton.addEventListener("click", () => {
  if (!roomState?.isYourTurn) {
    return;
  }

  socket.emit("next-turn");
});

elements.roomInput.addEventListener("input", () => {
  elements.roomInput.value = elements.roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

[elements.categorySelect, elements.gameRoundsSelect, elements.timerSelect].forEach((element) => {
  element.addEventListener("change", renderJoinSettingsSummary);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && settingsModalMode) {
    closeSettingsModal();
  }
});

socket.on("join-error", (message) => {
  if (isRecoveringSession) {
    resetToLobby("Connection restored, but your previous room is no longer available. Create or join a room again.");
    setConnectionStatus("Session could not be restored.", "warning");
    return;
  }

  elements.joinError.textContent = message;
});

socket.on("turn-error", (message) => {
  elements.turnError.textContent = message;
});

socket.on("guess-error", (message) => {
  elements.guessError.textContent = message;
});

socket.on("app-error", (message) => {
  if (roomState) {
    elements.turnError.textContent = message;
  } else {
    elements.joinError.textContent = message;
  }
});

socket.on("room-state", (state) => {
  const wasRecoveringSession = isRecoveringSession;
  hadConnectionDrop = false;
  isRecoveringSession = false;
  renderState(state);

  if (wasRecoveringSession) {
    setConnectionStatus("Reconnected to the room.", "success");
    scheduleConnectionStatusClear();
    return;
  }

  if (socket.connected) {
    setConnectionStatus();
  }
});

socket.on("connect", () => {
  if (hadConnectionDrop && roomState) {
    attemptSessionRecovery();
    return;
  }

  hadConnectionDrop = false;
  setConnectionStatus();
  applyConnectionState();
});

socket.on("disconnect", () => {
  hadConnectionDrop = true;
  setConnectionStatus("Connection lost. Trying to reconnect...", "warning");
  applyConnectionState();
});

socket.on("connect_error", () => {
  hadConnectionDrop = true;
  setConnectionStatus("Server unavailable. Retrying connection...", "warning");
  applyConnectionState();
});

renderJoinSettingsSummary();
renderJoinMode();
applyConnectionState();