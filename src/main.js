import Peer from "peerjs";
import { GAME_CONFIG } from "./config.js";
import "./style.css";

const app = document.querySelector("#app");
const DEBUG_ENABLED =
  new URLSearchParams(window.location.search).get("debug") === "1";
const CAT_CLASSES = [
  ["Scaredy Cat", "A little quicker when things get scary.", "😿"],
  ["Cool Cat", "Hits harder while feeling fresh.", "😎"],
  ["Chonk", "Extra sturdy. Extra round.", "🐈"],
  ["Sneaky Cat", "Harder for dogs to spot at a distance.", "🥷"],
];
const DOG_CLASSES = [
  ["Terrier", "Fast feet. Very little chill.", "🐕"],
  ["Bulldog", "A sturdy wall with a running start.", "🐶"],
  ["Hound", "A team player with a nose for trouble.", "🐩"],
  ["Great Dane", "Big reach. Bigger entrance.", "🦮"],
];
const state = {
  view: "landing",
  peer: null,
  hostConnection: null,
  isHost: false,
  code: "",
  playerId: crypto.randomUUID(),
  room: null,
  error: "",
  notice: "",
  gameController: null,
  joinTimeout: null,
  pingTimer: null,
  reconnectTimer: null,
  joined: false,
  isJoining: false,
  connectionBanner: "",
  hostWasHidden: false,
  hostVisibilityTimer: null,
  debugLogs: [],
  debugStats: { fps: 0, ping: 0, predictionError: 0 },
};

function defaultPlayer(name) {
  return {
    id: state.playerId,
    name: (name || "Mittens").trim().slice(0, 16) || "Mittens",
    sidePreference: "random",
    team: null,
    className: "Scaredy Cat",
    ready: false,
    isHost: false,
    connected: true,
  };
}

function escapeHTML(value = "") {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function makeCode() {
  const letters = GAME_CONFIG.room.codeAlphabet;
  return Array.from(
    { length: GAME_CONFIG.room.codeLength },
    () => letters[Math.floor(Math.random() * letters.length)],
  ).join("");
}

function countsFor(players) {
  const requested = GAME_CONFIG.teams[
    Math.max(
      GAME_CONFIG.room.minPlayers,
      Math.min(GAME_CONFIG.room.maxPlayers, players),
    )
  ] || {
    cats: 1,
    dogs: 1,
  };
  return { ...requested };
}

function resolveTeams(players) {
  const caps = countsFor(players.length);
  const shuffled = [...players];
  const assigned = new Map();
  const reserved = new Map();

  // Lock valid preferences first, then retain existing random assignments where possible.
  for (const player of shuffled.filter(
    (entry) => entry.sidePreference !== "random",
  )) {
    const wanted = player.sidePreference;
    if ((assigned.get(wanted) || 0) < caps[wanted]) {
      assigned.set(wanted, (assigned.get(wanted) || 0) + 1);
      reserved.set(player.id, wanted);
    }
  }

  for (const player of shuffled.filter(
    (entry) => entry.sidePreference === "random",
  )) {
    const previous = player.team;
    if (previous && (assigned.get(previous) || 0) < caps[previous]) {
      assigned.set(previous, (assigned.get(previous) || 0) + 1);
      reserved.set(player.id, previous);
    }
  }

  const unassigned = shuffled
    .filter((player) => !reserved.has(player.id))
    .sort(() => Math.random() - 0.5);
  for (const player of unassigned) {
    const openTeams = ["cats", "dogs"].filter(
      (team) => (assigned.get(team) || 0) < caps[team],
    );
    const team = openTeams[Math.floor(Math.random() * openTeams.length)];
    assigned.set(team, (assigned.get(team) || 0) + 1);
    reserved.set(player.id, team);
  }
  for (const player of players) {
    player.team = reserved.get(player.id);
    const validClasses = player.team === "dogs" ? DOG_CLASSES : CAT_CLASSES;
    if (!validClasses.some(([name]) => name === player.className)) {
      player.className = validClasses[0][0];
    }
  }
  return players;
}

function createRoomState(host) {
  return {
    phase: "lobby",
    hostId: host.id,
    players: resolveTeams([host]),
    settings: { difficulty: "normal", rounds: 2 },
  };
}

function send(connection, type, payload = {}) {
  if (connection?.open) connection.send({ type, ...payload });
}

function traceConnection(message) {
  const entry = `${new Date().toLocaleTimeString()} ${message}`;
  console.info(`[CAT-ASTROPHE] ${message}`);
  state.debugLogs.unshift(entry);
  state.debugLogs.length = Math.min(
    state.debugLogs.length,
    GAME_CONFIG.network.debugLogLines,
  );
  renderDebugOverlay();
}

function renderDebugOverlay() {
  if (!DEBUG_ENABLED) return;
  let panel = document.querySelector("#connection-debug");
  if (!panel) {
    panel = document.createElement("pre");
    panel.id = "connection-debug";
    document.body.appendChild(panel);
  }
  panel.textContent = [
    `FPS ${state.debugStats.fps || "—"} · PING ${state.debugStats.ping || "—"} ms · PREDICTION ERROR ${Number(state.debugStats.predictionError || 0).toFixed(2)} u`,
    ...state.debugLogs,
  ].join("\n");
}

function updateConnectionBanner() {
  let banner = document.querySelector("#connection-banner");
  if (!state.connectionBanner) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "connection-banner";
    document.body.appendChild(banner);
  }
  banner.textContent = state.connectionBanner;
}

function broadcast(type, payload = {}) {
  if (!state.isHost || !state.room) return;
  const connections = Object.values(state.peer?.connections || {}).flat();
  for (const connection of connections) send(connection, type, payload);
}

function clearArena() {
  clearInterval(state.pingTimer);
  state.pingTimer = null;
  state.gameController?.dispose();
  state.gameController = null;
}

function viewForPhase(phase) {
  if (phase === "arena") return "arena";
  if (phase === "ready-to-launch") return "launch";
  return "lobby";
}

function startArena() {
  if (!state.room) return;
  state.room.phase = "arena";
  state.view = "arena";
  broadcast("arena-start", { room: state.room });
  render();
}

function returnToLobby() {
  if (state.isHost) {
    state.room.phase = "lobby";
    state.view = "lobby";
    clearArena();
    broadcast("room-state", { room: state.room });
    render();
  } else {
    send(state.hostConnection, "back-to-lobby");
    state.room.phase = "lobby";
    state.view = "lobby";
    clearArena();
    render();
  }
}

function emitRoom() {
  if (!state.room) return;
  state.room.players = resolveTeams(state.room.players);
  broadcast("room-state", { room: state.room });
  render();
}

function setError(message) {
  state.error = message;
  render();
}

function wireIceLogging(connection) {
  connection.on("iceStateChanged", (iceState) => {
    traceConnection(`ICE ${connection.peer}: ${iceState}`);
  });
  const peerConnection = connection.peerConnection;
  if (peerConnection) {
    traceConnection(
      `WebRTC ${connection.peer} initial: connection=${peerConnection.connectionState}, ICE=${peerConnection.iceConnectionState}, signaling=${peerConnection.signalingState}`,
    );
    peerConnection.addEventListener("connectionstatechange", () => {
      traceConnection(
        `WebRTC ${connection.peer}: ${peerConnection.connectionState}`,
      );
    });
    peerConnection.addEventListener("icecandidateerror", (event) => {
      traceConnection(
        `ICE candidate error ${connection.peer}: ${event.errorCode} ${event.errorText || ""}`,
      );
    });
    peerConnection.addEventListener("icegatheringstatechange", () => {
      traceConnection(
        `ICE gathering ${connection.peer}: ${peerConnection.iceGatheringState}`,
      );
    });
  }
  connection.on("error", (error) => {
    traceConnection(
      `connection ${connection.peer} error: ${error.message || error}`,
    );
  });
}

function handleHostMessage(connection, message) {
  if (!message || !state.room) return;
  if (message.type === "join") {
    if (
      state.room.players.length >= GAME_CONFIG.room.maxPlayers ||
      state.room.phase !== "lobby"
    ) {
      send(connection, "join-error", {
        error:
          state.room.phase !== "lobby"
            ? "This room's round has already started."
            : "This room is full.",
      });
      connection.close();
      return;
    }
    const cleanName = String(message.player?.name || "Mittens").slice(0, 16);
    const player = {
      id: String(message.player?.id || connection.peer),
      name: cleanName,
      sidePreference: "random",
      team: null,
      className: "Scaredy Cat",
      ready: false,
      isHost: false,
      connected: true,
      connectionId: connection.peer,
    };
    const previous = state.room.players.find((entry) => entry.id === player.id);
    if (!previous) state.room.players.push(player);
    send(connection, "room-state", { room: state.room });
    emitRoom();
    return;
  }

  const player = state.room.players.find(
    (entry) => entry.connectionId === connection?.peer,
  );
  if (!player) return;
  if (message.type === "arena-input" && state.gameController && state.isHost) {
    state.gameController.setPlayerInput(player.id, message.input);
  } else if (
    message.type === "arena-action" &&
    state.gameController &&
    state.isHost
  ) {
    state.gameController.performAction(player.id, message.action);
  } else if (message.type === "arena-ping") {
    send(connection, "arena-pong", { sentAt: message.sentAt });
  } else if (message.type === "update-player") {
    if (["cats", "dogs", "random"].includes(message.sidePreference)) {
      player.sidePreference = message.sidePreference;
    }
    const classes =
      player.sidePreference === "dogs" || player.team === "dogs"
        ? DOG_CLASSES
        : CAT_CLASSES;
    if (classes.some(([name]) => name === message.className))
      player.className = message.className;
    if (typeof message.ready === "boolean") player.ready = message.ready;
    emitRoom();
  } else if (message.type === "host-settings" && player.isHost) {
    if (["easy", "normal", "hard"].includes(message.difficulty)) {
      state.room.settings.difficulty = message.difficulty;
    }
    if ([1, 2].includes(Number(message.rounds)))
      state.room.settings.rounds = Number(message.rounds);
    emitRoom();
  } else if (
    message.type === "start-round" &&
    (player?.isHost || (!connection && state.isHost))
  ) {
    const ready =
      state.room.players.length >= 2 &&
      state.room.players.every((entry) => entry.ready);
    if (ready) {
      startArena();
    }
  } else if (message.type === "back-to-lobby" && player) {
    state.room.phase = "lobby";
    state.view = "lobby";
    clearArena();
    broadcast("room-state", { room: state.room });
    render();
  }
}

function minPlayersNeeded() {
  return DEBUG_ENABLED
    ? GAME_CONFIG.debug.soloMinPlayers
    : GAME_CONFIG.room.minPlayers;
}

// Debug-only: a local room with no PeerJS connection, so the game can be tested alone.
function beginSolo(name) {
  const player = defaultPlayer(name);
  player.isHost = true;
  state.room = createRoomState(player);
  state.isHost = true;
  state.code = "SOLO";
  state.peer = null;
  state.view = "lobby";
  state.error = "";
  render();
}

function beginHost(name) {
  const player = defaultPlayer(name);
  player.isHost = true;
  state.room = createRoomState(player);
  state.isHost = true;
  let attempts = 0;
  const openHostPeer = () => {
    attempts += 1;
    state.code = makeCode();
    const peer = new Peer(`catastrophe-${state.code.toLowerCase()}`, {
      config: {
        iceServers: GAME_CONFIG.network.iceServers,
        sdpSemantics: GAME_CONFIG.network.sdpSemantics,
      },
    });
    state.peer = peer;
    let firstOpen = true;
    peer.on("open", () => {
      traceConnection(`host peer open as ${peer.id}`);
      state.connectionBanner = "";
      clearTimeout(state.reconnectTimer);
      updateConnectionBanner();
      if (firstOpen) {
        firstOpen = false;
        state.view = "lobby";
        state.error = "";
        render();
      }
    });
    peer.on("connection", (connection) => {
      traceConnection(`incoming data connection from ${connection.peer}`);
      wireIceLogging(connection);
      connection.on("open", () =>
        send(connection, "room-state", { room: state.room }),
      );
      connection.on("data", (message) =>
        handleHostMessage(connection, message),
      );
      connection.on("close", () => {
        traceConnection(`connection closed: ${connection.peer}`);
        const leaving = state.room?.players.find(
          (entry) => entry.connectionId === connection.peer,
        );
        if (!leaving) return;
        state.room.players = state.room.players.filter(
          (entry) => entry.id !== leaving.id,
        );
        emitRoom();
      });
      connection.on("error", (error) =>
        traceConnection(
          `connection error ${connection.peer}: ${error.message || error}`,
        ),
      );
    });
    peer.on("disconnected", () => {
      if (peer !== state.peer) return;
      traceConnection(
        "host peer disconnected from signaling service; reconnecting",
      );
      try {
        peer.reconnect();
      } catch (error) {
        traceConnection(`host reconnect failed: ${error.message || error}`);
      }
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(() => {
        if (peer === state.peer && !peer.open) {
          state.connectionBanner =
            "Room service connection is unstable. Keep this host tab open while it reconnects.";
          updateConnectionBanner();
          traceConnection("signaling reconnect is still pending");
        }
      }, GAME_CONFIG.network.reconnectWarningMs);
    });
    peer.on("error", (error) => {
      traceConnection(
        `host peer error (${error.type}): ${error.message || error}`,
      );
      if (peer !== state.peer) return;
      if (
        error.type === "unavailable-id" &&
        attempts <= GAME_CONFIG.network.roomCodeRetries
      ) {
        peer.destroy();
        traceConnection(
          `room code collision; retry ${attempts}/${GAME_CONFIG.network.roomCodeRetries}`,
        );
        openHostPeer();
        return;
      }
      if (error.type === "unavailable-id") peer.destroy();
      state.room = null;
      state.isHost = false;
      state.peer = null;
      setError(
        error.type === "unavailable-id"
          ? "Couldn't reserve a room code after several tries. Please create the room again."
          : "Could not connect to the room service. Check your internet connection and try again.",
      );
    });
  };
  openHostPeer();
}

function joinRoom(name, code) {
  state.code = code.toUpperCase();
  state.isHost = false;
  state.isJoining = true;
  state.joined = false;
  updateJoinStatus("Contacting room service...", true);
  clearTimeout(state.joinTimeout);
  state.joinTimeout = setTimeout(() => {
    if (state.joined || !state.isJoining) return;
    const peerConnection = state.hostConnection?.peerConnection;
    traceConnection(
      `join timeout diagnostics: peer=${state.peer?.open ? "open" : "not open"}, connection=${peerConnection?.connectionState || "not created"}, ICE=${peerConnection?.iceConnectionState || "not created"}, gathering=${peerConnection?.iceGatheringState || "not created"}, signaling=${peerConnection?.signalingState || "not created"}`,
    );
    failJoin(
      "Couldn't connect to that room. Check the code, make sure the host's tab is open, and try again.",
    );
  }, GAME_CONFIG.network.joinTimeoutMs);
  const peer = new Peer(undefined, {
    config: {
      iceServers: GAME_CONFIG.network.iceServers,
      sdpSemantics: GAME_CONFIG.network.sdpSemantics,
    },
  });
  state.peer = peer;
  peer.on("open", () => {
    traceConnection(`guest peer open as ${peer.id}`);
    updateJoinStatus("Room service connected, checking the code...", true);
    const connection = peer.connect(`catastrophe-${state.code.toLowerCase()}`, {
      reliable: true,
      serialization: "json",
    });
    state.hostConnection = connection;
    wireIceLogging(connection);
    connection.on("open", () => {
      traceConnection(`data channel open to ${connection.peer}`);
      updateJoinStatus("Room found, joining...", true);
      send(connection, "join", { player: defaultPlayer(name) });
    });
    connection.on("data", (message) => {
      if (message?.type === "room-state") {
        const hostConfirmedPlayer = message.room?.players?.some(
          (player) => player.id === state.playerId,
        );
        if (!hostConfirmedPlayer) {
          traceConnection("room responded; waiting for join confirmation");
          return;
        }
        state.joined = true;
        state.isJoining = false;
        clearTimeout(state.joinTimeout);
        updateJoinStatus("", false);
        traceConnection("room state received; guest joined");
        state.room = message.room;
        const nextView = viewForPhase(message.room.phase);
        if (state.view === "arena" && nextView !== "arena") clearArena();
        state.view = nextView;
        render();
      } else if (message?.type === "arena-start") {
        state.joined = true;
        state.isJoining = false;
        clearTimeout(state.joinTimeout);
        state.room = message.room;
        state.view = "arena";
        render();
      } else if (message?.type === "arena-snapshot") {
        const predictionError = state.gameController?.applySnapshot(
          message.snapshot,
        );
        if (Number.isFinite(predictionError)) {
          state.debugStats.predictionError = predictionError;
          renderDebugOverlay();
        }
      } else if (message?.type === "arena-pong") {
        state.debugStats.ping = Math.round(performance.now() - message.sentAt);
        renderDebugOverlay();
      } else if (message?.type === "join-error") {
        traceConnection(`join rejected: ${message.error || "unknown reason"}`);
        clearTimeout(state.joinTimeout);
        state.isJoining = false;
        state.joined = false;
        state.peer?.destroy();
        state.peer = null;
        state.hostConnection = null;
        state.room = null;
        updateJoinStatus(
          message.error || "Could not join that room.",
          false,
          true,
        );
      }
    });
    connection.on("close", () => {
      traceConnection("guest data connection closed");
      if (state.joined) handleHostLeft();
      else if (state.isJoining)
        failJoin(
          "The connection closed before you joined. Check the code and try again.",
        );
    });
    connection.on("error", (error) => {
      traceConnection(`guest connection error: ${error.message || error}`);
      if (state.joined) handleHostLeft();
      else if (state.isJoining)
        failJoin(
          "Couldn't connect to that room. Check the code and try again.",
        );
    });
  });
  peer.on("disconnected", () =>
    traceConnection("guest peer disconnected from signaling service"),
  );
  peer.on("error", (error) => {
    traceConnection(
      `guest peer error (${error.type}): ${error.message || error}`,
    );
    if (peer !== state.peer) return;
    if (state.joined) {
      handleHostLeft();
      return;
    }
    failJoin(
      error.type === "peer-unavailable"
        ? "We could not find that room. Check the four-letter code."
        : "Could not connect to the room service. Check your internet connection and try again.",
    );
  });
}

function updateJoinStatus(message, joining, isError = false) {
  const form = document.querySelector("#entry-form");
  if (!form) return;
  const slot = form.querySelector(".message-slot");
  const submit = form.querySelector(".form-submit");
  const cancel = form.querySelector("[data-cancel-join]");
  if (slot) {
    slot.textContent = message;
    slot.classList.toggle("message-error", isError);
  }
  if (submit) submit.disabled = joining;
  if (cancel) cancel.hidden = !joining;
  form.querySelectorAll("input").forEach((input) => {
    input.disabled = joining;
  });
}

function failJoin(message) {
  clearTimeout(state.joinTimeout);
  state.joinTimeout = null;
  state.isJoining = false;
  state.joined = false;
  state.peer?.destroy();
  state.peer = null;
  state.hostConnection = null;
  state.room = null;
  state.isHost = false;
  traceConnection(`join failed: ${message}`);
  updateJoinStatus(message, false, true);
}

function cancelJoin() {
  clearTimeout(state.joinTimeout);
  state.joinTimeout = null;
  state.isJoining = false;
  state.joined = false;
  state.peer?.destroy();
  state.peer = null;
  state.hostConnection = null;
  state.room = null;
  traceConnection("join canceled by player");
  updateJoinStatus("", false);
}

function handleHostLeft() {
  if (state.isHost) return;
  const hadJoined = state.joined;
  state.joined = false;
  state.isJoining = false;
  clearTimeout(state.joinTimeout);
  clearArena();
  state.peer?.destroy();
  state.peer = null;
  state.room = null;
  state.hostConnection = null;
  state.view = "landing";
  state.notice = hadJoined
    ? "Host left. You have been returned to the start screen."
    : "Connection ended before joining the room.";
  render();
}

function currentPlayer() {
  return state.room?.players.find((player) => player.id === state.playerId);
}

function updateLocalPlayer(patch) {
  if (!state.room) return;
  if (state.isHost) {
    const player = currentPlayer();
    if (!player) return;
    Object.assign(player, patch);
    emitRoom();
  } else {
    send(state.hostConnection, "update-player", patch);
  }
}

function updateHostSettings(patch) {
  if (!state.room) return;
  if (state.isHost) {
    Object.assign(state.room.settings, patch);
    emitRoom();
  } else {
    send(state.hostConnection, "host-settings", patch);
  }
}

function startRound() {
  if (state.isHost) {
    const ready =
      state.room.players.length >= minPlayersNeeded() &&
      state.room.players.every((entry) => entry.ready);
    if (ready) {
      state.room.roundNumber = 1;
      state.room.matchScores = {};
      state.room.catSidePoints = {};
      startArena();
    }
  } else send(state.hostConnection, "start-round");
}

function handleRoundAction(playerId, action) {
  if (!state.isHost || !state.room || playerId !== state.room.hostId) return;

  if (action === "next-round" && state.room.roundNumber === 1) {
    const flow = state.gameController?.getRoundFlow();
    if (!flow || Number(state.room.settings.rounds) < 2) return;
    state.room.matchScores = { ...flow.matchScores };
    state.room.catSidePoints = { ...flow.catSidePoints };
    const previousDogs = state.room.players.filter(
      (player) => player.team === "dogs",
    );
    const previousCats = state.room.players
      .filter((player) => player.team === "cats")
      .sort(
        (a, b) =>
          (flow.catSidePoints[a.id] || 0) - (flow.catSidePoints[b.id] || 0),
      );
    const catSlots = countsFor(state.room.players.length).cats;
    const nextCats = [...previousDogs, ...previousCats].slice(0, catSlots);
    const nextCatIds = new Set(nextCats.map((player) => player.id));
    for (const player of state.room.players) {
      player.team = nextCatIds.has(player.id) ? "cats" : "dogs";
      const validClasses = player.team === "dogs" ? DOG_CLASSES : CAT_CLASSES;
      if (!validClasses.some(([name]) => name === player.className)) {
        player.className = validClasses[0][0];
      }
      player.ready = true;
    }
    state.room.roundNumber = 2;
    startArena();
    return;
  }

  if (action === "return-lobby") {
    state.room.players.forEach((player) => (player.ready = false));
    state.room.phase = "lobby";
    state.room.roundNumber = 1;
    state.room.matchScores = {};
    state.room.catSidePoints = {};
    state.view = "lobby";
    clearArena();
    broadcast("room-state", { room: state.room });
    render();
  }
}

function leaveRoom() {
  clearArena();
  clearTimeout(state.joinTimeout);
  clearTimeout(state.reconnectTimer);
  state.joinTimeout = null;
  state.reconnectTimer = null;
  state.joined = false;
  state.isJoining = false;
  state.peer?.destroy();
  state.peer = null;
  state.hostConnection = null;
  state.room = null;
  state.isHost = false;
  state.view = "landing";
  state.error = "";
  state.notice = "";
  render();
}

function classOptions(player) {
  const classes =
    player.team === "dogs" || player.sidePreference === "dogs"
      ? DOG_CLASSES
      : CAT_CLASSES;
  if (player.sidePreference === "random" && !player.team) return CAT_CLASSES;
  return classes;
}

function initials(name) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function renderLanding() {
  app.innerHTML = `
    <main class="landing">
      <nav class="topbar">
        <a class="brand" href="#" aria-label="Cat-astrophe home"><span class="brand-mark">C!</span><span>BACKYARD<br />ESCAPE CLUB</span></a>
        <div class="topbar-right"><span class="online-dot"></span> PRIVATE ROOMS · 2—8 PLAYERS</div>
      </nav>
      <section class="hero">
        <div class="hero-copy">
          <div class="eyebrow"><span></span> THE NEIGHBORHOOD IS GETTING ROWDY</div>
          <h1>CAT-<br /><em>ASTROPHE</em></h1>
          <p class="lede">The fence is coming down. The dogs are coming in. Gather your gear, grab your friends, and make a run for the van.</p>
          <div class="hero-actions"><button class="button button-primary" data-action="open-create">Create a room <span>↗</span></button><button class="button button-quiet" data-action="open-join">Join with code <span>⌁</span></button>${DEBUG_ENABLED ? '<button class="button button-quiet" data-action="open-solo">Solo practice (debug) <span>⚙</span></button>' : ""}</div>
          <div class="input-panel hidden" id="entry-panel"></div>
          <p class="microcopy">ONE ROOM CODE. YOUR OWN DEVICE. NO INSTALLS.</p>
        </div>
        <div class="hero-art" aria-label="Illustration of a cat ready to escape a backyard">
          <div class="sun"></div><div class="cloud cloud-one"></div><div class="cloud cloud-two"></div>
          <div class="art-label label-yard">THE YARD <b>NO EXIT</b></div>
          <div class="fence fence-back"></div><div class="bush bush-a"></div><div class="bush bush-b"></div>
          <div class="garden-patch"></div><div class="toy toy-ball">✳</div><div class="treat">♥</div>
          <div class="cat-illustration"><div class="tail"></div><div class="cat-body"><div class="cat-ear left"></div><div class="cat-ear right"></div><div class="cat-face"><i class="eye eye-left"></i><i class="eye eye-right"></i><i class="nose"></i><i class="whisker w-left"></i><i class="whisker w-right"></i></div><div class="bib"></div></div><div class="cat-shadow"></div></div>
          <div class="comic-pop">LET'S<br />BOUNCE!</div><div class="art-label label-dog">DOGS OUTSIDE <b>FOR NOW</b></div>
          <div class="fence fence-front"></div><div class="art-sticker">YARD<br />RUMBLE <span>✦</span></div>
        </div>
      </section>
      <section class="howto"><div><span class="step-no">01</span><b>Pick your side</b><small>Cat crew or dog squad</small></div><span class="step-arrow">→</span><div><span class="step-no">02</span><b>Cause a scene</b><small>Scavenge, scramble, survive</small></div><span class="step-arrow">→</span><div><span class="step-no">03</span><b>Make the van</b><small>At least one cat. That's the rule.</small></div></section>
      <footer><span>CAT-ASTROPHE · A BACKYARD ESCAPE GAME</span><span>BUILT FOR FRIENDS & FRIENDLY RIVALRIES</span></footer>
    </main>`;
  if (state.error || state.notice) showLandingMessage();
  app
    .querySelector('[data-action="open-create"]')
    .addEventListener("click", () => showEntry("create"));
  app
    .querySelector('[data-action="open-join"]')
    .addEventListener("click", () => showEntry("join"));
  app
    .querySelector('[data-action="open-solo"]')
    ?.addEventListener("click", () => showEntry("solo"));
}

function showLandingMessage() {
  const actions = app.querySelector(".hero-actions");
  const note = document.createElement("div");
  note.className = `message ${state.error ? "message-error" : "message-notice"}`;
  note.textContent = state.error || state.notice;
  actions.after(note);
}

function showEntry(mode) {
  const panel = document.querySelector("#entry-panel");
  panel.classList.remove("hidden");
  panel.innerHTML = `
    <form id="entry-form" class="entry-form">
      <div class="form-top"><strong>${mode === "create" ? "Host a backyard rumble" : mode === "solo" ? "Solo practice (debug)" : "Sneak into a room"}</strong><button class="icon-button" type="button" data-close aria-label="Close">×</button></div>
      <label>Your player name<input name="name" maxlength="16" placeholder="Mittens" autocomplete="nickname" required /></label>
      ${mode === "join" ? '<label>Four-letter room code<input name="code" maxlength="4" minlength="4" placeholder="MEOW" autocomplete="off" required /></label>' : ""}
      <button class="button button-primary form-submit" type="submit">${mode === "create" ? "Create room" : mode === "solo" ? "Start solo room" : "Join room"} <span>↗</span></button>
      ${mode === "join" ? '<button class="button button-quiet cancel-join" type="button" data-cancel-join hidden>Cancel</button>' : ""}
      <p class="message-slot"></p>
    </form>`;
  panel.querySelector("[data-close]").addEventListener("click", () => {
    if (state.isJoining) cancelJoin();
    panel.classList.add("hidden");
  });
  panel.querySelector('input[name="name"]').focus();
  panel
    .querySelector("[data-cancel-join]")
    ?.addEventListener("click", cancelJoin);
  panel.querySelector("#entry-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") || "Mittens")
      .trim()
      .slice(0, 16);
    if (mode === "solo") {
      beginSolo(name);
      return;
    }
    if (mode === "create") {
      beginHost(name);
      panel.querySelector(".form-submit").disabled = true;
      panel.querySelector(".message-slot").textContent =
        "Calling the room together…";
      return;
    } else {
      const code = String(data.get("code") || "").toUpperCase();
      if (!/^[A-HJ-NP-Z]{4}$/.test(code)) {
        panel.querySelector(".message-slot").textContent =
          "Use four letters (skip I and O to avoid mix-ups).";
        return;
      }
      joinRoom(name, code);
      return;
    }
  });
}

function renderLobby() {
  const room = state.room;
  if (!room) return renderLanding();
  const me = currentPlayer() || room.players[0];
  const split = countsFor(room.players.length);
  const cats = room.players.filter((player) => player.team === "cats");
  const dogs = room.players.filter((player) => player.team === "dogs");
  const canStart =
    state.isHost &&
    room.players.length >= minPlayersNeeded() &&
    room.players.every((player) => player.ready);
  app.innerHTML = `
    <main class="lobby-page">
      <header class="lobby-header"><a class="brand" href="#"><span class="brand-mark">C!</span><span>BACKYARD<br />ESCAPE CLUB</span></a><div class="lobby-title"><span class="eyebrow">PRE-GAME SHENANIGANS</span><h1>Gather your troublemakers.</h1></div><button class="button button-quiet leave-button" data-action="leave">Leave room <span>↗</span></button></header>
      <div class="room-strip"><div class="room-code"><small>ROOM CODE</small><strong>${escapeHTML(state.code)}</strong><button class="copy-button" data-action="copy">COPY</button></div><div class="room-count"><span class="online-dot"></span><b>${room.players.length} / 8</b> players in the yard</div><div class="room-hint">${state.isHost ? "You are the host · share the code with your friends" : `Hosted by ${escapeHTML(room.players.find((p) => p.id === room.hostId)?.name || "a friend")}`}</div></div>
      <div class="lobby-grid"><section class="players-card"><div class="card-heading"><div><span class="eyebrow">THE ROSTER</span><h2>Pick your chaos.</h2></div><span class="split-chip">${split.cats} CATS <i>·</i> ${split.dogs} DOGS</span></div>
        <div class="team-columns"><div class="team-column cats-column"><div class="team-heading"><span class="team-icon">🐈</span><div><b>CAT CREW</b><small>${cats.length} / ${split.cats} slots</small></div><span class="team-mood">THE ESCAPEES</span></div>${renderPlayerList(cats, me)}</div><div class="team-column dogs-column"><div class="team-heading"><span class="team-icon">🐕</span><div><b>DOG SQUAD</b><small>${dogs.length} / ${split.dogs} slots</small></div><span class="team-mood">THE MENACE</span></div>${renderPlayerList(dogs, me)}</div></div>
        <div class="my-pick"><div class="my-pick-head"><div><span class="eyebrow">YOUR LOADOUT</span><h3>${me.team === "dogs" ? "Choose your dog class" : "Choose your cat class"}</h3></div><div class="side-picker"><label for="side-select">PREFERRED SIDE</label><select id="side-select" ${!state.isHost && me.isHost ? "disabled" : ""}><option value="random" ${me.sidePreference === "random" ? "selected" : ""}>Random</option><option value="cats" ${me.sidePreference === "cats" ? "selected" : ""}>Cat crew</option><option value="dogs" ${me.sidePreference === "dogs" ? "selected" : ""}>Dog squad</option></select></div></div><div class="class-grid">${classOptions(
          me,
        )
          .map(
            ([name, description, emoji]) =>
              `<button class="class-option ${me.className === name ? "selected" : ""}" data-class="${escapeHTML(name)}"><span class="class-emoji">${emoji}</span><span><b>${escapeHTML(name)}</b><small>${escapeHTML(description)}</small></span><i>${me.className === name ? "✓" : ""}</i></button>`,
          )
          .join("")}</div></div>
      </section><aside class="settings-card"><div class="card-heading"><div><span class="eyebrow">ROOM SETTINGS</span><h2>Set the stakes.</h2></div><span class="host-tag">${state.isHost ? "HOST" : "GUEST"}</span></div><div class="setting-block"><label>DIFFICULTY</label><div class="segmented" id="difficulty">${["easy", "normal", "hard"].map((level) => `<button data-value="${level}" class="${room.settings.difficulty === level ? "active" : ""}" ${!state.isHost ? "disabled" : ""}>${level}</button>`).join("")}</div><p>${difficultyBlurb(room.settings.difficulty)}</p></div><div class="setting-block"><label>NUMBER OF ROUNDS</label><div class="segmented round-segment">${[1, 2].map((rounds) => `<button data-rounds="${rounds}" class="${room.settings.rounds === rounds ? "active" : ""}" ${!state.isHost ? "disabled" : ""}>${rounds} ${rounds === 1 ? "round" : "rounds"}</button>`).join("")}</div></div><div class="rules-note"><span>✦</span><p>In round two, teams swap. Same friends, different furry problems.</p></div><div class="ready-status"><div class="ready-avatars">${room.players.map((player) => `<span class="mini-avatar ${player.ready ? "is-ready" : ""}" title="${escapeHTML(player.name)}">${escapeHTML(initials(player.name))}</span>`).join("")}</div><span><b>${room.players.filter((player) => player.ready).length} / ${room.players.length}</b> ready to rumble</span></div><button class="button ${me.ready ? "button-ready" : "button-primary"} ready-button" data-action="ready">${me.ready ? "Ready! Change mind?" : "I’m ready"} <span>${me.ready ? "✓" : "→"}</span></button>${state.isHost ? `<button class="button start-button" data-action="start" ${canStart ? "" : "disabled"}>${room.players.length < minPlayersNeeded() ? "Need another player" : canStart ? "Start the rumble" : "Waiting for everyone…"} <span>↗</span></button>` : '<p class="waiting-copy">The host will start when everyone is ready.</p>'}</aside></div>
      <footer class="lobby-footer"><span>CAT-ASTROPHE · A BACKYARD ESCAPE GAME</span><span>ROOMS ARE HOSTED BY THE PLAYER WHO CREATED THEM</span></footer>
      <div class="toast ${state.notice ? "show" : ""}" role="status">${escapeHTML(state.notice)}</div>
    </main>`;
  app
    .querySelector('[data-action="leave"]')
    .addEventListener("click", leaveRoom);
  app
    .querySelector('[data-action="copy"]')
    .addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(state.code);
        state.notice = "Room code copied!";
      } catch {
        state.notice = `Room code: ${state.code}`;
      }
      render();
      setTimeout(() => {
        state.notice = "";
        render();
      }, 2200);
    });
  app.querySelector("#side-select").addEventListener("change", (event) => {
    const sidePreference = event.target.value;
    const classes = sidePreference === "dogs" ? DOG_CLASSES : CAT_CLASSES;
    updateLocalPlayer({
      sidePreference,
      className: classes[0][0],
      ready: false,
    });
  });
  app.querySelectorAll("[data-class]").forEach((button) =>
    button.addEventListener("click", () => {
      updateLocalPlayer({ className: button.dataset.class, ready: false });
    }),
  );
  app.querySelectorAll("[data-value]").forEach((button) =>
    button.addEventListener("click", () => {
      if (state.isHost)
        updateHostSettings({ difficulty: button.dataset.value });
    }),
  );
  app.querySelectorAll("[data-rounds]").forEach((button) =>
    button.addEventListener("click", () => {
      if (state.isHost)
        updateHostSettings({ rounds: Number(button.dataset.rounds) });
    }),
  );
  app
    .querySelector('[data-action="ready"]')
    .addEventListener("click", () => updateLocalPlayer({ ready: !me.ready }));
  app
    .querySelector('[data-action="start"]')
    ?.addEventListener("click", startRound);
}

function renderPlayerList(players, me) {
  if (!players.length)
    return '<div class="empty-team">The yard is suspiciously quiet…</div>';
  return players
    .map(
      (player) =>
        `<div class="player-row ${player.id === me.id ? "you" : ""}"><span class="player-avatar ${player.team === "dogs" ? "dog-avatar" : ""}">${escapeHTML(initials(player.name))}</span><span class="player-detail"><b>${escapeHTML(player.name)}${player.id === me.id ? " <i>YOU</i>" : ""}</b><small>${escapeHTML(player.className || "Choosing class")}</small></span>${player.isHost ? '<span class="host-star">✦ HOST</span>' : ""}<span class="ready-pill ${player.ready ? "ready" : ""}">${player.ready ? "READY" : "PICKING"}</span></div>`,
    )
    .join("");
}

function difficultyBlurb(level) {
  return {
    easy: "More snacks, fewer surprises. A friendly first escape.",
    normal: "A proper backyard scramble for seasoned troublemakers.",
    hard: "Fast dogs, scarce snacks, and very little room for naps.",
  }[level];
}

async function renderArena() {
  if (!state.room) return renderLanding();
  clearArena();
  const me = currentPlayer() || state.room.players[0];
  app.innerHTML = `
    <main class="arena-shell">
      <div class="arena-stage" id="arena-stage"></div>
      <header class="arena-topbar">
        <div class="arena-brand"><span class="brand-mark">C!</span><span>CAT-ASTROPHE <small>ROOM ${escapeHTML(state.code)}</small></span></div>
        <div class="arena-phase"><i></i><span><b id="phase-name">SCAVENGE</b><small id="phase-timer">--:--</small></span></div>
        <button class="arena-menu-button" data-action="arena-lobby">BACK TO LOBBY <b>ESC</b></button>
      </header>
      <section class="arena-objective">
        <div class="arena-team-tag ${me.team === "dogs" ? "dog-tag" : "cat-tag"}">${me.team === "dogs" ? "DOG SQUAD" : "CAT CREW"}</div>
        <b>${me.team === "dogs" ? "Stock up, then hunt the cats." : "Grab gear and watch your whiskers."}</b>
        <span>E at glowing pickups · click or Space to use your item · Q for your class ability</span>
      </section>
      <aside class="arena-roster"><small>IN THE YARD</small>${state.room.players.map((player) => `<div class="arena-roster-row ${player.id === me.id ? "is-you" : ""}"><i class="roster-dot ${player.team === "dogs" ? "dog-dot" : "cat-dot"}"></i><span>${escapeHTML(player.name)}${player.id === me.id ? " · YOU" : ""}</span><b>${player.team === "dogs" ? "DOG" : "CAT"}</b></div>`).join("")}</aside>
      <div class="arena-notice" id="arena-notice" role="status"></div>
      <div class="phase-objective" id="phase-objective"></div>
      <div class="van-arrow" id="van-arrow" hidden><i>↑</i><span>VAN</span></div>
      <div class="phase-results" id="phase-results" hidden></div>
      <div class="phase-banner" id="phase-banner" aria-live="polite"></div>
      <div class="host-visibility-warning" id="host-visibility-warning" hidden>Host tab must stay visible. Background tabs may slow the match simulation.</div>
      <div class="desktop-warning"><span>⌨️</span><b>Cat-Astrophe is a desktop game.</b><small>Open this room on a computer with a keyboard and mouse to play.</small></div>
      <div class="arena-controls"><span><b>W A S D</b> MOVE</span><span><b>MOUSE</b> AIM</span><span><b>SHIFT</b> DODGE</span><span><b>CLICK / SPACE</b> USE ITEM</span><span><b>Q</b> ABILITY</span><span><b>E</b> PICKUP / REVIVE</span><span><b>1 / 2</b> ITEMS</span></div>
      <div class="arena-bottom-left"><div class="practice-label">CLASS <b>${escapeHTML(me.className)}</b></div><div class="arena-health"><i class="arena-health-fill"></i></div><small class="arena-health-label">100 / 100 HP</small><small id="arena-passive">ATTACKS HAVE A VISIBLE WIND-UP</small></div>
      <div class="arena-channel" id="arena-channel" hidden><span>SNACKING… HOLD STILL</span><div class="channel-bar"><i></i></div></div>
      <button class="arena-ability" id="arena-ability" type="button" data-ability><kbd>Q</kbd><span class="ability-name">Ability</span><small class="ability-cooldown">READY</small></button>
      <div class="event-banner" id="event-banner" aria-live="polite"></div>
      <div class="edge-markers" id="edge-markers"></div>
      ${DEBUG_ENABLED ? '<div class="debug-tools" id="debug-tools"><b>DEBUG</b><button data-debug="skip">Skip phase</button><button data-debug="bot">+ Dog bot</button><button data-debug="hurt">Hurt me 40</button><button data-debug="event">Random event</button><button data-debug="dash">Measure dash</button><button data-debug="cooldowns">Reset cooldowns</button></div>' : ""}
      <div class="arena-bottom-right"><button class="arena-slot active" data-slot="1"><kbd>1</kbd><span class="slot-name">Squeaky mallet</span><small class="slot-charge">∞</small></button><button class="arena-slot" data-slot="2"><kbd>2</kbd><span class="slot-name">Spray bottle</span><small class="slot-charge">6 uses</small></button></div>
      <div class="arena-crosshair" id="arena-crosshair"></div>
    </main>`;

  app
    .querySelector('[data-action="arena-lobby"]')
    .addEventListener("click", returnToLobby);
  app.querySelectorAll("[data-slot]").forEach((slot) =>
    slot.addEventListener("click", () => {
      state.gameController?.setActiveSlot(Number(slot.dataset.slot));
    }),
  );

  app.querySelector("[data-ability]")?.addEventListener("click", () => {
    state.gameController?.requestAbility();
  });
  const stage = app.querySelector("#arena-stage");
  let createArena;
  try {
    ({ createArena } = await import("./game.js"));
  } catch (error) {
    console.error("Could not load the 3D arena.", error);
    showArenaNotice(
      "The 3D arena failed to load. Return to the lobby and retry.",
    );
    return;
  }
  if (state.view !== "arena" || !stage.isConnected) return;

  try {
    state.gameController = createArena({
      container: stage,
      room: state.room,
      localPlayerId: state.playerId,
      isHost: state.isHost,
      onInput(input) {
        if (state.isHost) {
          state.gameController?.setPlayerInput(state.playerId, input);
        } else {
          send(state.hostConnection, "arena-input", { input });
        }
      },
      onAction(action) {
        if (state.isHost) {
          state.gameController?.performAction(state.playerId, action);
        } else {
          send(state.hostConnection, "arena-action", { action });
        }
      },
      onRoundAction(playerId, action) {
        handleRoundAction(playerId, action);
      },
      onHostSnapshot(snapshot) {
        broadcast("arena-snapshot", { snapshot });
      },
      onDebug(stats) {
        state.debugStats = { ...state.debugStats, ...stats };
        renderDebugOverlay();
      },
      onNotice: showArenaNotice,
      onLeave: returnToLobby,
      debug: DEBUG_ENABLED,
    });
  } catch (error) {
    console.error("Could not start the 3D arena.", error);
    showArenaNotice("The 3D canvas could not start in this browser.");
    return;
  }

  if (DEBUG_ENABLED) wireDebugTools();
  if (!state.isHost) {
    state.pingTimer = setInterval(() => {
      send(state.hostConnection, "arena-ping", { sentAt: performance.now() });
    }, GAME_CONFIG.network.pingIntervalMs);
  }
  updateHostVisibilityWarning();
}

function wireDebugTools() {
  const tools = app.querySelector("#debug-tools");
  if (!tools) return;
  tools.addEventListener("click", (event) => {
    const action = event.target?.dataset?.debug;
    const debug = state.gameController?.debug;
    if (!action || !debug) return;
    if (action === "skip") debug.skipPhase();
    else if (action === "bot") debug.spawnDogBot();
    else if (action === "hurt") debug.damage(state.playerId, 40);
    else if (action === "event") debug.forceEvent();
    else if (action === "cooldowns") debug.cooldownOff();
    else if (action === "dash") {
      const results = debug.measureDash();
      console.table(results);
      traceConnection(`dash timing: ${JSON.stringify(results)}`);
      showArenaNotice("Dash timing report written to the console and debug log.");
    }
  });
}

function showArenaNotice(message) {
  const notice = app.querySelector("#arena-notice");
  if (!notice) return;
  notice.textContent = message;
  notice.classList.add("is-visible");
  clearTimeout(notice._hideTimer);
  notice._hideTimer = setTimeout(
    () => notice.classList.remove("is-visible"),
    2100,
  );
}

function renderLaunch() {
  app.innerHTML = `<main class="launch-page"><div class="launch-card"><div class="launch-badge">✦ LOBBY CHECK COMPLETE</div><div class="launch-cat">🐈‍⬛</div><p class="eyebrow">ROOM ${escapeHTML(state.code)}</p><h1>The rumble is ready.</h1><p>Your room, teams, class picks and round settings are connected. The 3D arena is the next milestone.</p><div class="launch-recap"><span>${state.room.players.length} players</span><span>${state.room.settings.difficulty} difficulty</span><span>${state.room.settings.rounds} ${state.room.settings.rounds === 1 ? "round" : "rounds"}</span></div><button class="button button-primary" data-action="back">Back to lobby <span>↗</span></button></div></main>`;
  app.querySelector('[data-action="back"]').addEventListener("click", () => {
    if (state.isHost) {
      state.room.phase = "lobby";
      state.view = "lobby";
      emitRoom();
    } else {
      send(state.hostConnection, "back-to-lobby");
      state.room.phase = "lobby";
      state.view = "lobby";
      render();
    }
  });
}

function render() {
  if (state.view === "lobby") renderLobby();
  else if (state.view === "arena") renderArena();
  else if (state.view === "launch") renderLaunch();
  else renderLanding();
  renderDebugOverlay();
  updateConnectionBanner();
}

function updateHostVisibilityWarning() {
  const warning = document.querySelector("#host-visibility-warning");
  if (state.isHost && document.hidden) state.hostWasHidden = true;
  if (warning) warning.hidden = !(state.isHost && state.hostWasHidden);
  if (!document.hidden && state.isHost && state.hostWasHidden) {
    clearTimeout(state.hostVisibilityTimer);
    state.hostVisibilityTimer = setTimeout(() => {
      state.hostWasHidden = false;
      updateHostVisibilityWarning();
    }, GAME_CONFIG.network.hostVisibilityWarningMs);
  }
}

document.addEventListener("visibilitychange", updateHostVisibilityWarning);

render();
