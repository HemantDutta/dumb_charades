const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const movieDatasets = require("./movie-datasets");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 4;
const DEFAULT_CATEGORY = "bollywood";
const DEFAULT_ROUND_SECONDS = 60;
const DEFAULT_GAME_ROUNDS = 1;
const ROUND_DURATION_OPTIONS = [30, 45, 60, 90];
const GAME_ROUND_OPTIONS = [1, 2, 3];
const TURN_REVEAL_MS = 5000;
const MIN_GUESS_POINTS = 2;
const MAX_GUESS_POINTS = 10;
const ACTOR_POINTS_PER_CORRECT_GUESS = 2;
const DATASET_OPTIONS = Object.entries(movieDatasets).map(([key, value]) => ({
  value: key,
  label: value.label,
  source: value.source
}));

const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));

function logServerError(source, error) {
  console.error(`[${new Date().toISOString()}] ${source}`, error);
}

function emitAppError(socket, message = "Something went wrong. Please refresh and try again.") {
  socket.emit("app-error", message);
}

function emitRoomAppError(room, message = "The room hit an unexpected error. Please start a new round or refresh.") {
  room.players.forEach((player) => {
    io.to(player.id).emit("app-error", message);
  });
}

let isShuttingDownForFatalError = false;

function shutdownOnFatalError(source, error) {
  logServerError(source, error);

  if (isShuttingDownForFatalError) {
    return;
  }

  isShuttingDownForFatalError = true;
  server.close(() => {
    process.exit(1);
  });

  const exitTimer = setTimeout(() => {
    process.exit(1);
  }, 5000);

  if (typeof exitTimer.unref === "function") {
    exitTimer.unref();
  }
}

function withSocketGuard(socket, eventName, handler) {
  return (...args) => {
    try {
      handler(...args);
    } catch (error) {
      logServerError(`socket:${eventName}`, error);
      emitAppError(socket);
    }
  };
}

function withRoomGuard(room, taskName, handler) {
  return () => {
    try {
      handler();
    } catch (error) {
      logServerError(`room:${taskName}`, error);
      clearRoomTimer(room);
      clearRevealTimer(room);
      emitRoomAppError(room);
      broadcastRoom(room);
    }
  };
}

process.on("uncaughtException", (error) => {
  shutdownOnFatalError("uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  shutdownOnFatalError("unhandledRejection", error);
});

server.on("error", (error) => {
  logServerError("server:error", error);
});

function normalizeRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function normalizeName(value) {
  return String(value || "").trim().slice(0, 20);
}

function normalizeCategory(value) {
  return Object.prototype.hasOwnProperty.call(movieDatasets, value) ? value : DEFAULT_CATEGORY;
}

function normalizeRoundSeconds(value) {
  const parsed = Number(value);
  return ROUND_DURATION_OPTIONS.includes(parsed) ? parsed : DEFAULT_ROUND_SECONDS;
}

function normalizeGameRounds(value) {
  const parsed = Number(value);
  return GAME_ROUND_OPTIONS.includes(parsed) ? parsed : DEFAULT_GAME_ROUNDS;
}

function normalizeGuess(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeJoinMode(value) {
  return value === "join" ? "join" : "create";
}

function getDataset(room) {
  return movieDatasets[room.settings.category] || movieDatasets[DEFAULT_CATEGORY];
}

function getGamePlayerCount(room) {
  return room.startedPlayerCount || room.players.length;
}

function isRoomStarted(room) {
  return Number.isInteger(room.startedPlayerCount) && room.startedPlayerCount >= MIN_PLAYERS;
}

function canStartRoom(room) {
  return !isRoomStarted(room) && room.players.length >= MIN_PLAYERS;
}

function getMaxTurns(room) {
  return room.settings.gameRounds * Math.max(MIN_PLAYERS, getGamePlayerCount(room));
}

function getRemainingTurnRatio(room) {
  if (!room.turnEndsAt) {
    return 0;
  }

  const totalMs = room.settings.roundSeconds * 1000;

  if (!totalMs) {
    return 0;
  }

  return Math.max(0, Math.min(1, (room.turnEndsAt - Date.now()) / totalMs));
}

function getGuesserPoints(room) {
  const guesserSlots = Math.max(1, room.players.length - 1);
  const guessOrderIndex = room.correctGuesserIds.length;
  const orderRatio = guesserSlots === 1 ? 1 : 1 - guessOrderIndex / (guesserSlots - 1);
  const timeRatio = getRemainingTurnRatio(room);
  const combinedRatio = (orderRatio + timeRatio) / 2;

  return Math.round(MIN_GUESS_POINTS + combinedRatio * (MAX_GUESS_POINTS - MIN_GUESS_POINTS));
}

function addTurnPoints(room, playerId, points) {
  room.turnPoints[playerId] = (room.turnPoints[playerId] || 0) + points;
}

function createPromptMask(prompt) {
  return String(prompt || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => Array.from(word, () => "_").join(" "))
    .join("   ");
}

function clearRoomTimer(room) {
  if (room.timerHandle) {
    clearTimeout(room.timerHandle);
    room.timerHandle = null;
  }

  room.turnEndsAt = null;
}

function clearRevealTimer(room) {
  if (room.revealHandle) {
    clearTimeout(room.revealHandle);
    room.revealHandle = null;
  }

  room.revealEndsAt = null;
  room.roundSummary = null;
}

function resetTurnState(room) {
  room.correctGuesserIds = [];
  room.guessFeed = [];
  room.turnPoints = {};
}

function resetGameState(room, options = {}) {
  const { preserveStartedPlayerCount = false, resetPromptCycle = false } = options;

  clearRoomTimer(room);
  clearRevealTimer(room);
  room.turnIndex = 0;
  room.currentMovie = null;

  if (resetPromptCycle) {
    room.lastPrompt = null;
    room.promptQueue = [];
  }

  room.completedTurns = 0;
  room.isGameOver = false;
  room.startedPlayerCount = preserveStartedPlayerCount ? room.startedPlayerCount : null;
  resetTurnState(room);
  room.players.forEach((player) => {
    player.score = 0;
  });
}

function shuffleList(items) {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

function refillPromptQueue(room) {
  const previousMovie = room.lastPrompt || room.currentMovie;
  room.promptQueue = shuffleList(getDataset(room).movies);

  if (
    previousMovie &&
    room.promptQueue.length > 1 &&
    room.promptQueue[room.promptQueue.length - 1] === previousMovie
  ) {
    [room.promptQueue[0], room.promptQueue[room.promptQueue.length - 1]] = [
      room.promptQueue[room.promptQueue.length - 1],
      room.promptQueue[0]
    ];
  }
}

function createRoom(code) {
  return {
    code,
    players: [],
    startedPlayerCount: null,
    turnIndex: 0,
    currentMovie: null,
    lastPrompt: null,
    promptQueue: [],
    timerHandle: null,
    turnEndsAt: null,
    revealHandle: null,
    revealEndsAt: null,
    roundSummary: null,
    guessFeed: [],
    correctGuesserIds: [],
    turnPoints: {},
    completedTurns: 0,
    isGameOver: false,
    settings: {
      category: DEFAULT_CATEGORY,
      roundSeconds: DEFAULT_ROUND_SECONDS,
      gameRounds: DEFAULT_GAME_ROUNDS
    }
  };
}

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, createRoom(code));
  }

  return rooms.get(code);
}

function pickMovie(room) {
  if (room.promptQueue.length === 0) {
    refillPromptQueue(room);
  }

  room.currentMovie = room.promptQueue.pop() || null;
}

function scheduleRoundTimer(room) {
  clearRoomTimer(room);

  if (!isRoomStarted(room) || !room.currentMovie) {
    return;
  }

  room.turnEndsAt = Date.now() + room.settings.roundSeconds * 1000;
  room.timerHandle = setTimeout(withRoomGuard(room, "round-timer", () => {
    room.timerHandle = null;
    finishRound(room);
  }), room.settings.roundSeconds * 1000);
}

function startRound(room) {
  resetTurnState(room);
  pickMovie(room);
  scheduleRoundTimer(room);
}

function startGame(room) {
  if (!canStartRoom(room)) {
    return false;
  }

  room.startedPlayerCount = room.players.length;
  room.turnIndex = 0;
  room.currentMovie = null;
  room.completedTurns = 0;
  room.isGameOver = false;
  resetTurnState(room);
  room.players.forEach((player) => {
    player.score = 0;
  });
  startRound(room);
  return true;
}

function finalizeGame(room) {
  room.isGameOver = true;
  room.currentMovie = null;
  clearRoomTimer(room);
  broadcastRoom(room);
}

function restartGame(room) {
  resetGameState(room, { preserveStartedPlayerCount: true });
  ensurePlayableTurn(room);
  broadcastRoom(room);
}

function finishRound(room) {
  if (!isRoomStarted(room)) {
    resetGameState(room);
    broadcastRoom(room);
    return;
  }

  if (!room.currentMovie || room.revealHandle) {
    clearRoomTimer(room);
    broadcastRoom(room);
    return;
  }

  clearRoomTimer(room);

  const answer = room.currentMovie;
  room.lastPrompt = answer;
  room.completedTurns += 1;
  room.roundSummary = {
    answer,
    points: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      earned: room.turnPoints[player.id] || 0
    }))
  };
  room.revealEndsAt = Date.now() + TURN_REVEAL_MS;
  room.currentMovie = null;

  broadcastRoom(room);

  room.revealHandle = setTimeout(withRoomGuard(room, "round-reveal", () => {
    room.revealHandle = null;
    room.revealEndsAt = null;
    room.roundSummary = null;

    if (!isRoomStarted(room) || room.players.length < room.startedPlayerCount) {
      resetGameState(room);
      broadcastRoom(room);
      return;
    }

    if (room.completedTurns >= getMaxTurns(room)) {
      finalizeGame(room);
      return;
    }

    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    startRound(room);
    broadcastRoom(room);
  }), TURN_REVEAL_MS);
}

function ensurePlayableTurn(room) {
  if (!isRoomStarted(room)) {
    room.turnIndex = 0;
    room.currentMovie = null;
    clearRoomTimer(room);
    clearRevealTimer(room);
    return;
  }

  if (!room.currentMovie && !room.revealHandle && !room.isGameOver) {
    startRound(room);
  }
}

function getActivePlayer(room) {
  return room.players[room.turnIndex] || null;
}

function getLeaderboard(room) {
  return [...room.players]
    .map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score || 0
    }))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .map((player, index) => ({
      ...player,
      rank: index + 1
    }));
}

function buildRoomPayload(room, socketId) {
  const activePlayer = getActivePlayer(room);
  const isActivePlayer = activePlayer?.id === socketId;
  const dataset = getDataset(room);
  const isReady = isRoomStarted(room);
  const isLiveTurn = isReady && !room.revealHandle && !room.isGameOver && Boolean(room.currentMovie);
  const hasGuessedCurrentTurn = room.correctGuesserIds.includes(socketId);
  const leaderboard = getLeaderboard(room);
  const maxTurns = getMaxTurns(room);
  const gamePlayerCount = getGamePlayerCount(room);

  return {
    selfId: socketId,
    roomCode: room.code,
    playerCount: room.players.length,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    gamePlayerCount,
    isReady,
    isGameOver: room.isGameOver,
    canStartGame: canStartRoom(room),
    players: room.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      isTurn: isLiveTurn && index === room.turnIndex,
      score: player.score || 0
    })),
    activePlayerName: isReady ? activePlayer?.name || null : null,
    activePlayerId: isLiveTurn ? activePlayer?.id || null : null,
    currentMovie: isLiveTurn && isActivePlayer ? room.currentMovie : null,
    maskedPrompt: isLiveTurn && !isActivePlayer ? createPromptMask(room.currentMovie) : null,
    hasSecretMovie: Boolean(isLiveTurn && isActivePlayer && room.currentMovie),
    isYourTurn: isLiveTurn && isActivePlayer,
    canGuess: isLiveTurn && !isActivePlayer && !hasGuessedCurrentTurn,
    hasGuessedCurrentTurn,
    turnEndsAt: room.turnEndsAt,
    revealEndsAt: room.revealEndsAt,
    roundSeconds: room.settings.roundSeconds,
    gameRounds: room.settings.gameRounds,
    category: room.settings.category,
    categoryLabel: dataset.label,
    categorySource: dataset.source,
    canChangeSettings: !isRoomStarted(room),
    canPlayAgain: room.isGameOver && isReady && room.players.length === room.startedPlayerCount,
    guessFeed: room.guessFeed,
    roundSummary: room.roundSummary,
    leaderboard,
    podium: room.isGameOver ? leaderboard.slice(0, 3) : [],
    completedTurns: room.completedTurns,
    maxTurns,
    datasetOptions: DATASET_OPTIONS,
    roundDurationOptions: ROUND_DURATION_OPTIONS,
    gameRoundOptions: GAME_ROUND_OPTIONS
  };
}

function broadcastRoom(room) {
  room.players.forEach((player) => {
    io.to(player.id).emit("room-state", buildRoomPayload(room, player.id));
  });
}

function removePlayer(socket) {
  const currentRoomCode = socket.data.roomCode;

  if (!currentRoomCode) {
    return;
  }

  const room = rooms.get(currentRoomCode);

  if (!room) {
    socket.data.roomCode = null;
    return;
  }

  const removedIndex = room.players.findIndex((player) => player.id === socket.id);

  if (removedIndex === -1) {
    socket.data.roomCode = null;
    return;
  }

  room.players.splice(removedIndex, 1);
  socket.leave(currentRoomCode);
  socket.data.roomCode = null;

  if (room.players.length === 0) {
    clearRoomTimer(room);
    clearRevealTimer(room);
    rooms.delete(currentRoomCode);
    return;
  }

  if (removedIndex < room.turnIndex) {
    room.turnIndex -= 1;
  }

  if (room.turnIndex >= room.players.length) {
    room.turnIndex = 0;
  }

  if (isRoomStarted(room) && room.players.length < room.startedPlayerCount) {
    resetGameState(room);
  } else if (!isRoomStarted(room)) {
    resetGameState(room);
  } else if (removedIndex === room.turnIndex && !room.revealHandle && !room.isGameOver) {
    startRound(room);
  }

  broadcastRoom(room);
}

io.on("connection", (socket) => {
  socket.on("join-room", withSocketGuard(socket, "join-room", ({ roomCode, name, category, roundSeconds, gameRounds, joinMode }) => {
    const cleanRoomCode = normalizeRoomCode(roomCode);
    const cleanName = normalizeName(name);
    const cleanJoinMode = normalizeJoinMode(joinMode);

    if (!cleanRoomCode || cleanRoomCode.length < 3) {
      socket.emit("join-error", "Enter a room code with at least 3 letters or numbers.");
      return;
    }

    if (!cleanName) {
      socket.emit("join-error", "Enter your name before joining.");
      return;
    }

    removePlayer(socket);

    const existingRoom = rooms.get(cleanRoomCode);

    if (cleanJoinMode === "join" && !existingRoom) {
      socket.emit("join-error", "That room does not exist yet. Ask someone to create it first.");
      return;
    }

    if (cleanJoinMode === "create" && existingRoom) {
      socket.emit("join-error", "That room already exists. Use Join Game instead.");
      return;
    }

    const room = existingRoom || getOrCreateRoom(cleanRoomCode);

    if (existingRoom && isRoomStarted(room)) {
      socket.emit("join-error", "That game has already started. Wait for the next round or create a new room.");
      return;
    }

    if (room.players.length === 0) {
      room.settings.category = normalizeCategory(category);
      room.settings.roundSeconds = normalizeRoundSeconds(roundSeconds);
      room.settings.gameRounds = normalizeGameRounds(gameRounds);
      room.promptQueue = [];
    }

    if (room.players.length >= MAX_PLAYERS) {
      socket.emit("join-error", "That room already has four players.");
      return;
    }

    room.players.push({
      id: socket.id,
      name: cleanName,
      score: 0
    });

    socket.data.roomCode = cleanRoomCode;
    socket.join(cleanRoomCode);

    if (!isRoomStarted(room) && room.players.length === MAX_PLAYERS) {
      startGame(room);
    } else {
      ensurePlayableTurn(room);
    }

    broadcastRoom(room);
  }));

  socket.on("update-settings", withSocketGuard(socket, "update-settings", ({ category, roundSeconds, gameRounds }) => {
    const currentRoomCode = socket.data.roomCode;
    const room = currentRoomCode ? rooms.get(currentRoomCode) : null;

    if (!room) {
      return;
    }

    if (isRoomStarted(room)) {
      socket.emit("turn-error", "Room settings are locked after the game starts.");
      return;
    }

    const nextCategory = normalizeCategory(category);
    const shouldResetPromptCycle = nextCategory !== room.settings.category;

    room.settings.category = nextCategory;
    room.settings.roundSeconds = normalizeRoundSeconds(roundSeconds);
    room.settings.gameRounds = normalizeGameRounds(gameRounds);
    resetGameState(room, { resetPromptCycle: shouldResetPromptCycle });
    broadcastRoom(room);
  }));

  socket.on("play-again", withSocketGuard(socket, "play-again", () => {
    const currentRoomCode = socket.data.roomCode;
    const room = currentRoomCode ? rooms.get(currentRoomCode) : null;

    if (!room || room.players.length !== room.startedPlayerCount || !room.isGameOver) {
      return;
    }

    restartGame(room);
  }));

  socket.on("start-game", withSocketGuard(socket, "start-game", () => {
    const currentRoomCode = socket.data.roomCode;
    const room = currentRoomCode ? rooms.get(currentRoomCode) : null;

    if (!room) {
      return;
    }

    if (!canStartRoom(room)) {
      socket.emit("turn-error", "You need at least 3 players to start the game.");
      return;
    }

    startGame(room);
    broadcastRoom(room);
  }));

  socket.on("submit-guess", withSocketGuard(socket, "submit-guess", ({ guess }) => {
    const currentRoomCode = socket.data.roomCode;
    const room = currentRoomCode ? rooms.get(currentRoomCode) : null;

    if (!room || !isRoomStarted(room) || room.isGameOver || room.revealHandle) {
      return;
    }

    const activePlayer = getActivePlayer(room);

    if (!activePlayer || !room.currentMovie) {
      return;
    }

    if (activePlayer.id === socket.id) {
      socket.emit("guess-error", "The actor cannot guess this turn.");
      return;
    }

    if (room.correctGuesserIds.includes(socket.id)) {
      socket.emit("guess-error", "You already guessed correctly this turn.");
      return;
    }

    const normalizedGuess = normalizeGuess(guess);

    if (!normalizedGuess) {
      socket.emit("guess-error", "Enter a guess before sending.");
      return;
    }

    if (normalizedGuess !== normalizeGuess(room.currentMovie)) {
      socket.emit("guess-error", "Not quite. Try again.");
      return;
    }

    const guesser = room.players.find((player) => player.id === socket.id);

    if (!guesser) {
      return;
    }

    const guesserPoints = getGuesserPoints(room);

    room.correctGuesserIds.push(socket.id);
    addTurnPoints(room, socket.id, guesserPoints);
    guesser.score += guesserPoints;
    addTurnPoints(room, activePlayer.id, ACTOR_POINTS_PER_CORRECT_GUESS);
    activePlayer.score += ACTOR_POINTS_PER_CORRECT_GUESS;
    room.guessFeed.push({
      id: `${socket.id}-${room.completedTurns}-${room.correctGuesserIds.length}`,
      text: `${guesser.name} guessed correctly`,
      type: "correct"
    });

    if (room.correctGuesserIds.length >= room.players.length - 1) {
      finishRound(room);
      return;
    }

    broadcastRoom(room);
  }));

  socket.on("next-turn", withSocketGuard(socket, "next-turn", () => {
    const currentRoomCode = socket.data.roomCode;
    const room = currentRoomCode ? rooms.get(currentRoomCode) : null;

    if (!room || !isRoomStarted(room) || room.isGameOver || room.revealHandle) {
      return;
    }

    const activePlayer = getActivePlayer(room);

    if (!activePlayer || activePlayer.id !== socket.id) {
      socket.emit("turn-error", "Only the active player can end the turn.");
      return;
    }

    finishRound(room);
  }));

  socket.on("disconnect", withSocketGuard(socket, "disconnect", () => {
    removePlayer(socket);
  }));
});

server.listen(PORT, () => {
  console.log(`Dumb Charades server running on http://localhost:${PORT}`);
});