import * as THREE from "three";
import { GAME_CONFIG } from "./config.js";

const PALETTE = {
  grass: 0x779159,
  grassLight: 0x8da468,
  grassDark: 0x607a4c,
  dirt: 0xa78a61,
  wood: 0xb88758,
  woodDark: 0x80573f,
  patio: 0xb99871,
  leaf: 0x52724c,
  leafLight: 0x718d5b,
  cream: 0xf5dfb4,
  cats: [0xe7975e, 0xddad65, 0xc98271, 0xd3c084],
  dogs: [0x788690, 0x8a857b, 0x697c82, 0x92918b],
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const damp = (current, target, rate, dt) =>
  THREE.MathUtils.damp(current, target, rate, dt);

function createBotPlayers(humans, difficulty, debug) {
  const botConfig = GAME_CONFIG.bots;
  const humanCats = humans.filter((player) => player.team !== "dogs").length;
  const humanDogs = humans.length - humanCats;
  let dogBots = 0;
  let catBots = 0;
  if (humans.length === 1 && debug) {
    if (humanDogs === 1) {
      dogBots = botConfig.soloDogBotsWhenDog;
      catBots = botConfig.soloCatBotsWhenDog;
    } else dogBots = botConfig.soloDogBotsWhenCat;
  } else if (humanDogs > 0 || humans.length > 1) {
    dogBots = botConfig.dogFillByHumans[humans.length] || 0;
  }
  const bots = [];
  for (let index = 0; index < dogBots; index += 1) {
    bots.push({
      id: `bot-dog-${index + 1}`,
      name: botConfig.names[index % botConfig.names.length],
      team: "dogs",
      className: "Terrier",
      isBot: true,
      ready: true,
    });
  }
  for (let index = 0; index < catBots; index += 1) {
    bots.push({
      id: `bot-cat-${index + 1}`,
      name: botConfig.catNames[index % botConfig.catNames.length],
      team: "cats",
      className: index % 2 ? "Chonk" : "Cool Cat",
      isBot: true,
      ready: true,
    });
  }
  return bots;
}

function createScoreRecord() {
  return {
    damage: 0,
    revives: 0,
    treatsShared: 0,
    dashDistance: 0,
    escapes: 0,
    dogDowns: 0,
    trapsTriggered: 0,
    chaseSeconds: 0,
    points: 0,
  };
}

export function createArena({
  container,
  room,
  localPlayerId,
  isHost,
  onInput,
  onAction,
  onRoundAction,
  onHostSnapshot,
  onDebug,
  onNotice,
  onLeave,
  debug = false,
}) {
  const difficulty = room.settings?.difficulty || "normal";
  const humanPlayers = room.players.map((player) => ({ ...player }));
  const players = [
    ...humanPlayers,
    ...createBotPlayers(humanPlayers, difficulty, debug),
  ];
  const humanTeamCounts = {
    cats: humanPlayers.filter((player) => player.team !== "dogs").length,
    dogs: humanPlayers.filter((player) => player.team === "dogs").length,
  };
  const classConfig = GAME_CONFIG.classes;
  const botConfig = GAME_CONFIG.bots;
  const eventConfig = GAME_CONFIG.events;
  const arena = GAME_CONFIG.arena;
  const combat = GAME_CONFIG.combat;
  const movement = GAME_CONFIG.movement;
  const config = GAME_CONFIG.camera;
  const roundConfig = GAME_CONFIG.roundFlow;
  const roundNumber = Number(room.roundNumber) || 1;
  const innerFenceRoot = new THREE.Group();
  const initialMatchScores = { ...(room.matchScores || {}) };
  const initialCatSidePoints = { ...(room.catSidePoints || {}) };
  const roundFlow = {
    roundNumber,
    phase: "scavenge",
    phaseTimeRemaining: roundConfig.scavengeSeconds[difficulty],
    fenceDropped: false,
    fenceDropProgress: 0,
    vanEdge: null,
    escapedPlayerIds: [],
    winner: null,
    results: null,
    vanArrivalRemaining: 0,
    carrierDoorProgress: 0,
    roundScores: Object.fromEntries(
      players.map((player) => [player.id, createScoreRecord()]),
    ),
    matchScores: initialMatchScores,
    catSidePoints: initialCatSidePoints,
    dashRouteRatio: 0,
    event: null,
    nextEventIn: 0,
    lastEventKind: null,
  };
  const states = new Map();
  const visuals = new Map();
  const inputs = new Map();
  const obstacles = [];
  const pickups = combat.pickupSpawns
    .filter((pickup) => !(pickup.bonus && difficulty === "hard"))
    .map((pickup) => ({ ...pickup, active: true }));
  const pickupVisuals = new Map();
  const projectiles = [];
  const projectileVisuals = new Map();
  const telegraphs = [];
  const telegraphVisuals = new Map();
  const traps = [];
  const trapVisuals = new Map();
  const clouds = [];
  const cloudVisuals = new Map();
  const pulses = [];
  const pulseVisuals = new Map();
  const botBrains = new Map();
  let binRoot = null;
  let debugFreezeBots = false;
  const eventVisuals = { group: null, leaves: [], ball: null, lane: null, discs: [] };
  let lastEventKey = "";
  const combatEvents = [];
  const combatEventVisuals = new Map();
  const pressed = new Set();
  const keys = new Set();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const aimPoint = new THREE.Vector3();
  let scene;
  let camera;
  let renderer;
  let animationFrame = 0;
  let elapsed = 0;
  let lastRenderAt = performance.now();
  let lastInputSentAt = lastRenderAt;
  let lastHostTickAt = lastRenderAt;
  let lastFpsReportAt = lastRenderAt;
  let frameCount = 0;
  let fps = 0;
  let localInputSequence = 0;
  let lastSnapshotInputSequence = 0;
  let lastPredictionError = 0;
  let simAccumulator = 0;
  let hostAccumulator = 0;
  let snapshotAccumulator = 0;
  let hostClockWorker = null;
  let hostClockUrl = null;
  let hostClockFallback = null;
  let disposed = false;
  let lastActionAt = 0;
  let activeSlot = 1;
  let cameraStarted = false;
  let currentAim = 0;
  let nextEntityId = 1;
  let lastFlowBannerPhase = "";
  let flowBannerRemaining = 0;
  let vanArrivalRemaining = 0;
  let carrierDoorProgress = 0;
  let cameraShakeRemaining = 0;
  let fenceDust = [];
  const pendingInputs = [];
  const currentLocalInput = { x: 0, z: 0, aim: 0, dash: false };
  const cameraLook = new THREE.Vector3();

  const materials = {};

  function startHostClock() {
    lastHostTickAt = performance.now();
    document.addEventListener("visibilitychange", onVisibilityChange);
    try {
      const workerSource = `setInterval(() => postMessage(0), ${movement.hostClockWorkerIntervalMs});`;
      hostClockUrl = URL.createObjectURL(
        new Blob([workerSource], { type: "text/javascript" }),
      );
      hostClockWorker = new Worker(hostClockUrl);
      hostClockWorker.onmessage = () => tickHostSimulation(performance.now());
      hostClockWorker.onerror = () => {
        hostClockWorker?.terminate();
        hostClockWorker = null;
        if (!hostClockFallback) {
          hostClockFallback = window.setInterval(
            () => tickHostSimulation(performance.now()),
            movement.hostClockWorkerIntervalMs,
          );
        }
      };
    } catch {
      hostClockFallback = window.setInterval(
        () => tickHostSimulation(performance.now()),
        movement.hostClockWorkerIntervalMs,
      );
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") {
      tickHostSimulation(performance.now());
    } else {
      keys.clear();
      currentLocalInput.x = 0;
      currentLocalInput.z = 0;
      currentLocalInput.dash = false;
      inputs.set(localPlayerId, { ...currentLocalInput });
    }
  }

  function tickHostSimulation(now) {
    if (disposed || !isHost) return;
    const realElapsed = Math.max(0, (now - lastHostTickAt) / 1000);
    lastHostTickAt = now;
    const maxElapsed = movement.fixedStep * movement.maxCatchUpSteps;
    hostAccumulator = Math.min(hostAccumulator + realElapsed, maxElapsed);
    snapshotAccumulator += realElapsed;

    let steps = 0;
    while (
      hostAccumulator >= movement.fixedStep &&
      steps < movement.maxCatchUpSteps
    ) {
      simulate(movement.fixedStep, currentLocalInput);
      hostAccumulator -= movement.fixedStep;
      steps += 1;
    }
    if (steps === movement.maxCatchUpSteps) {
      hostAccumulator = Math.min(hostAccumulator, movement.fixedStep);
    }

    if (snapshotAccumulator >= movement.snapshotInterval) {
      snapshotAccumulator %= movement.snapshotInterval;
      onHostSnapshot?.(getSnapshot());
    }
  }

  try {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(GAME_CONFIG.render.clearColor);
    scene.fog = new THREE.Fog(
      GAME_CONFIG.render.clearColor,
      GAME_CONFIG.render.fogNear,
      GAME_CONFIG.render.fogFar,
    );
    camera = new THREE.PerspectiveCamera(
      config.fov,
      container.clientWidth / Math.max(1, container.clientHeight),
      config.near,
      config.far,
    );
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(
      Math.min(
        window.devicePixelRatio || 1,
        GAME_CONFIG.render.pixelRatioLimit,
      ),
    );
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.14;
    container.appendChild(renderer.domElement);
  } catch (error) {
    onNotice?.("This browser could not start the 3D canvas.");
    throw error;
  }

  renderer.domElement.className = "arena-canvas";
  renderer.domElement.setAttribute(
    "aria-label",
    "Three-dimensional backyard arena",
  );
  renderer.domElement.addEventListener("contextmenu", preventContextMenu);

  materials.grass = makeMaterial(PALETTE.grass);
  materials.grassLight = makeMaterial(PALETTE.grassLight);
  materials.grassDark = makeMaterial(PALETTE.grassDark);
  materials.dirt = makeMaterial(PALETTE.dirt);
  materials.wood = makeMaterial(PALETTE.wood);
  materials.woodDark = makeMaterial(PALETTE.woodDark);
  materials.patio = makeMaterial(PALETTE.patio);
  materials.leaf = makeMaterial(PALETTE.leaf);
  materials.leafLight = makeMaterial(PALETTE.leafLight);
  materials.cream = makeMaterial(PALETTE.cream);
  materials.dark = makeMaterial(0x34392e);
  materials.eye = makeMaterial(0x252820);
  materials.eyeShine = makeMaterial(0xfff6df);
  materials.nose = makeMaterial(0x704b49);
  materials.dogDoor = makeMaterial(0x493b32);
  materials.gold = makeMaterial(0xe7bc72);
  materials.cloud = makeMaterial(0xd2d2c4);

  buildLighting();
  buildMap();
  buildVanMarkers();
  buildActors();
  syncActorVisuals(0);

  const localState = states.get(localPlayerId);
  if (localState) currentAim = localState.yaw;
  if (isHost) startHostClock();

  const onResize = () => resize();
  const onKeyDown = (event) => handleKeyDown(event);
  const onKeyUp = (event) => handleKeyUp(event);
  const onBlur = () => {
    keys.clear();
    pressed.clear();
  };
  const onPointerMove = (event) => updatePointer(event);
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    practiceSwipe();
  };
  const onWheel = (event) => {
    event.preventDefault();
    setActiveSlot(activeSlot === 1 ? 2 : 1);
  };

  window.addEventListener("resize", onResize);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

  const api = {
    setPlayerInput,
    performAction,
    setActiveSlot,
    applySnapshot,
    getSnapshot,
    getRoundFlow: () => structuredClone(roundFlow),
    requestAbility: () => requestAction({ type: "ability", aim: currentAim }),
    showNotice: onNotice,
    debug: debug ? debugApi() : null,
    dispose,
  };
  if (debug) window.catDebug = api.debug;

  function makeMaterial(color, extra = {}) {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.91,
      flatShading: true,
      ...extra,
    });
  }

  function addMesh(parent, geometry, material, position, scale, rotation) {
    const mesh = new THREE.Mesh(geometry, material);
    if (position)
      mesh.position.set(position.x || 0, position.y || 0, position.z || 0);
    if (scale) mesh.scale.set(scale.x || 1, scale.y || 1, scale.z || 1);
    if (rotation)
      mesh.rotation.set(rotation.x || 0, rotation.y || 0, rotation.z || 0);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    parent.add(mesh);
    return mesh;
  }

  function addBox(parent, position, size, material, rotationY = 0) {
    return addMesh(
      parent,
      new THREE.BoxGeometry(size.x, size.y, size.z),
      material,
      position,
      null,
      { y: rotationY },
    );
  }

  function addCollider(x, z, halfX, halfZ) {
    obstacles.push({ x, z, halfX, halfZ });
  }

  function buildLighting() {
    scene.add(new THREE.HemisphereLight(0xffe0b5, 0x45543b, 2.15));
    const sun = new THREE.DirectionalLight(0xffd6a0, 2.7);
    sun.position.set(-18, 33, -24);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xb5d6d3, 0.75);
    fill.position.set(17, 16, 20);
    scene.add(fill);
  }

  function buildMap() {
    const halfWidth = arena.width / 2;
    const halfDepth = arena.depth / 2;

    addMesh(
      scene,
      new THREE.PlaneGeometry(arena.width, arena.depth),
      materials.grass,
      { y: -0.07 },
      null,
      { x: -Math.PI / 2 },
    );

    addBox(
      scene,
      { x: -8.75, y: -0.035, z: 0 },
      { x: 42.5, y: 0.08, z: arena.depth - 1 },
      materials.grassLight,
    );
    addBox(
      scene,
      { x: 20, y: -0.025, z: 0 },
      { x: 16, y: 0.09, z: arena.depth - 1 },
      materials.dirt,
    );
    addBox(
      scene,
      { x: 13.95, y: 0.015, z: 0 },
      { x: 3.8, y: 0.04, z: arena.depth - 1 },
      makeMaterial(0xb89667),
    );

    const patio = arena.patio;
    addBox(
      scene,
      { x: patio.x, y: 0.08, z: patio.z },
      { x: patio.width, y: 0.23, z: patio.depth },
      materials.patio,
    );
    for (let index = -5; index <= 5; index += 1) {
      addBox(
        scene,
        { x: patio.x + index * 1.25, y: 0.205, z: patio.z },
        { x: 0.08, y: 0.025, z: patio.depth - 0.22 },
        materials.woodDark,
      );
    }

    buildOuterFence(halfWidth, halfDepth);
    buildInnerFence();
    buildGardenBeds();
    buildBushes();
    buildTrees();
    buildPatioProps();
    buildDoghouses();
    buildTunnelHoles();
    buildBorderFlowers();
    buildDogPrepProps();
    buildPickups();
  }

  function buildPickups() {
    for (const pickup of pickups) createPickupVisual(pickup);
  }

  function createPickupVisual(pickup) {
    const colors = {
      spray: 0x87bdce,
      bone: 0xf1e0b1,
      yarn: 0xd27471,
      treat: 0xe7a65c,
      stink: 0x91a766,
      trap: 0xb88958,
      launcher: 0x81a4b7,
      dogTreat: 0xd3965e,
      catnip: 0xc48db2,
      mallet: 0xd9b27a,
    };
    {
      const root = new THREE.Group();
      root.position.set(pickup.x, 0, pickup.z);
      addMesh(
        root,
        new THREE.SphereGeometry(0.32, 8, 6),
        makeMaterial(colors[pickup.item] || 0xe7bc72, {
          emissive: colors[pickup.item] || 0xe7bc72,
          emissiveIntensity: 0.14,
        }),
        { y: 0.42 },
      );
      addMesh(
        root,
        new THREE.TorusGeometry(0.46, 0.045, 5, 12),
        makeMaterial(0xffe2a3, { emissive: 0x6b4418, emissiveIntensity: 0.2 }),
        { y: 0.14 },
        null,
        { x: Math.PI / 2 },
      );
      const label = makeLabelSprite(
        combat.items[pickup.item]?.name || pickup.item,
        "#fff1ce",
        pickup.team === "dogs" ? "#42514c" : "#72503c",
      );
      label.position.set(0, 1.15, 0);
      label.scale.set(1.8, 0.42, 1);
      root.add(label);
      root.userData.seed = pickup.x * 0.1 + pickup.z * 0.03;
      scene.add(root);
      pickupVisuals.set(pickup.id, root);
    }
  }

  function buildOuterFence(halfWidth, halfDepth) {
    buildFenceLine(
      { x: -halfWidth + 0.6, z: -halfDepth + 0.55 },
      { x: -halfWidth + 0.6, z: halfDepth - 0.55 },
      false,
    );
    buildFenceLine(
      { x: -halfWidth + 0.6, z: -halfDepth + 0.55 },
      { x: halfWidth - 0.6, z: -halfDepth + 0.55 },
      true,
    );
    buildFenceLine(
      { x: -halfWidth + 0.6, z: halfDepth - 0.55 },
      { x: halfWidth - 0.6, z: halfDepth - 0.55 },
      true,
    );
    buildFenceLine(
      { x: halfWidth - 0.6, z: -halfDepth + 0.55 },
      { x: halfWidth - 0.6, z: halfDepth - 0.55 },
      false,
    );
  }

  function buildInnerFence() {
    const x = arena.catFenceX;
    const start = -arena.depth / 2 + 0.55;
    const end = arena.depth / 2 - 0.55;
    const openings = [...arena.fenceOpenings].sort((a, b) => a.z - b.z);
    let cursor = start;
    innerFenceRoot.position.set(x, 0, 0);
    scene.add(innerFenceRoot);

    for (const opening of openings) {
      const openingStart = opening.z - opening.width / 2;
      const openingEnd = opening.z + opening.width / 2;
      if (openingStart > cursor) {
        buildFenceLine(
          { x: 0, z: cursor },
          { x: 0, z: openingStart },
          false,
          innerFenceRoot,
        );
      }
      buildFenceGate(0, opening.z, opening.width, innerFenceRoot);
      cursor = openingEnd;
    }
    if (cursor < end)
      buildFenceLine(
        { x: 0, z: cursor },
        { x: 0, z: end },
        false,
        innerFenceRoot,
      );
  }

  function buildFenceGate(x, z, width, parent = scene) {
    const railDepth = 0.19;
    for (const height of [0.73, 1.45]) {
      addBox(
        parent,
        { x, y: height, z },
        { x: railDepth, y: 0.17, z: width },
        materials.wood,
      );
    }
    const sections = Math.max(2, Math.floor(width / 0.6));
    for (let index = 0; index <= sections; index += 1) {
      addBox(
        parent,
        { x, y: 0.86, z: z - width / 2 + (width * index) / sections },
        { x: 0.2, y: 1.75, z: 0.2 },
        materials.woodDark,
      );
    }
  }

  function buildFenceLine(start, end, horizontal, parent = scene) {
    const length = horizontal
      ? Math.abs(end.x - start.x)
      : Math.abs(end.z - start.z);
    const sections = Math.max(1, Math.ceil(length / 1.65));
    const step = length / sections;
    const center = {
      x: (start.x + end.x) / 2,
      z: (start.z + end.z) / 2,
    };
    const railDepth = 0.2;
    const railSpan = length + railDepth;

    for (const height of [0.73, 1.45]) {
      addBox(
        parent,
        { x: center.x, y: height, z: center.z },
        horizontal
          ? { x: railSpan, y: 0.17, z: railDepth }
          : { x: railDepth, y: 0.17, z: railSpan },
        materials.wood,
      );
    }

    for (let index = 0; index <= sections; index += 1) {
      const distance = Math.min(index * step, length);
      const x = horizontal
        ? start.x + Math.sign(end.x - start.x) * distance
        : start.x;
      const z = horizontal
        ? start.z
        : start.z + Math.sign(end.z - start.z) * distance;
      addBox(
        parent,
        { x, y: 0.86, z },
        { x: 0.2, y: 1.75, z: 0.2 },
        materials.woodDark,
      );
      addMesh(
        parent,
        new THREE.ConeGeometry(0.14, 0.27, 4),
        materials.wood,
        { x, y: 1.86, z },
        null,
        { y: Math.PI / 4 },
      );
    }
  }

  function buildGardenBeds() {
    const beds = [
      { x: -1.5, z: -7.2, width: 7.2, depth: 3.5 },
      { x: 4.1, z: 11.8, width: 5, depth: 3.2 },
    ];
    for (const bed of beds) {
      addBox(
        scene,
        { x: bed.x, y: 0.18, z: bed.z },
        { x: bed.width, y: 0.4, z: bed.depth },
        materials.woodDark,
      );
      addBox(
        scene,
        { x: bed.x, y: 0.4, z: bed.z },
        { x: bed.width - 0.4, y: 0.16, z: bed.depth - 0.4 },
        makeMaterial(0x65513d),
      );
      for (let index = 0; index < 9; index += 1) {
        const x = bed.x - bed.width * 0.38 + index * bed.width * 0.095;
        const z = bed.z + Math.sin(index * 1.9) * bed.depth * 0.22;
        addMesh(
          scene,
          new THREE.SphereGeometry(0.31, 6, 5),
          index % 2 ? materials.leaf : materials.leafLight,
          { x, y: 0.68, z },
          { x: 1.1, y: 0.85, z: 1 },
        );
      }
      addCollider(bed.x, bed.z, bed.width / 2, bed.depth / 2);
    }
  }

  function buildBushes() {
    for (const [index, bush] of arena.bushPositions.entries()) {
      const scale = bush.scale;
      const radius = 0.8 * scale;
      const material = index % 2 ? materials.leaf : materials.leafLight;
      const root = new THREE.Group();
      root.position.set(bush.x, 0, bush.z);
      scene.add(root);
      for (const [dx, dy, dz, size] of [
        [-0.5, 0.45, 0.05, 0.72],
        [0.38, 0.54, -0.1, 0.82],
        [0, 0.83, 0.1, 0.75],
      ]) {
        addMesh(
          root,
          new THREE.DodecahedronGeometry(size * scale, 0),
          material,
          { x: dx * scale, y: dy * scale, z: dz * scale },
        );
      }
      addCollider(bush.x, bush.z, radius, radius);
    }
  }

  function buildTrees() {
    const trees = [
      { x: -27, z: -14, scale: 1.1 },
      { x: -27, z: 12, scale: 0.9 },
      { x: 5, z: -17, scale: 0.78 },
    ];
    for (const tree of trees) {
      const root = new THREE.Group();
      root.position.set(tree.x, 0, tree.z);
      scene.add(root);
      addMesh(
        root,
        new THREE.CylinderGeometry(
          0.28 * tree.scale,
          0.48 * tree.scale,
          2.4 * tree.scale,
          6,
        ),
        materials.woodDark,
        { y: 1.2 * tree.scale },
      );
      for (const [x, y, z, size, material] of [
        [0, 2.45, 0, 1.5, materials.leaf],
        [-0.68, 2.05, 0.28, 1.05, materials.leafLight],
        [0.7, 2.08, -0.18, 1.1, materials.leaf],
      ]) {
        addMesh(
          root,
          new THREE.DodecahedronGeometry(size * tree.scale, 0),
          material,
          { x: x * tree.scale, y: y * tree.scale, z: z * tree.scale },
        );
      }
      addCollider(tree.x, tree.z, 0.8 * tree.scale, 0.8 * tree.scale);
    }
  }

  function buildPatioProps() {
    addBox(
      scene,
      { x: -22.7, y: 0.52, z: -15.2 },
      { x: 3.1, y: 0.65, z: 0.55 },
      materials.woodDark,
    );
    for (const x of [-23.8, -21.6]) {
      for (const z of [-15.45, -14.95]) {
        addBox(
          scene,
          { x, y: 0.2, z },
          { x: 0.16, y: 0.55, z: 0.16 },
          materials.woodDark,
        );
      }
    }
    addCollider(-22.7, -15.2, 1.55, 0.34);

    const bin = new THREE.Group();
    bin.position.set(-13, 0, 15.6);
    scene.add(bin);
    binRoot = bin;
    addMesh(
      bin,
      new THREE.CylinderGeometry(0.58, 0.49, 1.25, 8),
      makeMaterial(0x536e6b),
      { y: 0.64 },
    );
    addMesh(
      bin,
      new THREE.CylinderGeometry(0.63, 0.63, 0.12, 8),
      materials.dark,
      { y: 1.29 },
    );
    addCollider(-13, 15.6, 0.72, 0.72);

    addMesh(
      scene,
      new THREE.TorusGeometry(0.62, 0.12, 5, 9),
      makeMaterial(0xd9c179),
      { x: -6, y: 0.26, z: -1.5 },
      null,
      { x: Math.PI / 2 },
    );
    addMesh(
      scene,
      new THREE.TorusGeometry(0.62, 0.12, 5, 9),
      makeMaterial(0xd27d5d),
      { x: 6.2, y: 0.26, z: 4.6 },
      null,
      { x: Math.PI / 2 },
    );
  }

  function buildDoghouses() {
    for (const [index, house] of arena.doghousePositions.entries()) {
      const color = [0x8b6951, 0x987454, 0x7f6552][index];
      addBox(
        scene,
        { x: house.x, y: 0.7, z: house.z },
        { x: 2.45, y: 1.4, z: 2.3 },
        makeMaterial(color),
      );
      addMesh(
        scene,
        new THREE.ConeGeometry(1.86, 1.15, 4),
        materials.woodDark,
        { x: house.x, y: 1.94, z: house.z },
        { x: 1, y: 1, z: 1.03 },
        { y: Math.PI / 4 },
      );
      addMesh(
        scene,
        new THREE.CircleGeometry(0.42, 8),
        materials.dogDoor,
        { x: house.x, y: 0.38, z: house.z + 1.16 },
        null,
        { x: 0, y: 0, z: 0 },
      );
      addCollider(house.x, house.z, 1.3, 1.25);
    }
  }

  function buildTunnelHoles() {
    for (const z of arena.tunnelPositions) {
      addMesh(
        scene,
        new THREE.CylinderGeometry(0.86, 0.92, 0.14, 12),
        makeMaterial(0x534231),
        { x: arena.catFenceX, y: 0.01, z },
      );
      addMesh(
        scene,
        new THREE.TorusGeometry(0.93, 0.08, 5, 14),
        makeMaterial(0x805c3c),
        { x: arena.catFenceX, y: 0.1, z },
      );
      for (let index = 0; index < 5; index += 1) {
        const x = arena.catFenceX + (index - 2) * 0.28;
        addMesh(
          scene,
          new THREE.SphereGeometry(0.11, 5, 4),
          index % 2 ? materials.dirt : materials.wood,
          { x, y: 0.1, z: z + Math.sin(index * 1.6) * 0.62 },
        );
      }
    }
  }

  function buildBorderFlowers() {
    const flowerMaterial = [
      makeMaterial(0xf2d481),
      makeMaterial(0xd98671),
      makeMaterial(0xe9e1bf),
    ];
    for (let index = 0; index < 32; index += 1) {
      const side = index % 2 ? -1 : 1;
      const x = -25 + ((index * 7.3) % 34);
      const z = side * (18 + ((index * 1.7) % 0.6));
      addMesh(
        scene,
        new THREE.ConeGeometry(0.16, 0.5, 5),
        index % 4 === 0 ? materials.leaf : materials.leafLight,
        { x, y: 0.22, z },
        null,
        { z: Math.sin(index) * 0.16 },
      );
      addMesh(
        scene,
        new THREE.SphereGeometry(0.12, 5, 4),
        flowerMaterial[index % flowerMaterial.length],
        { x, y: 0.48, z },
      );
    }
  }

  function buildDogPrepProps() {
    addBox(
      scene,
      { x: 20, y: 0.18, z: -18.3 },
      { x: 9, y: 0.3, z: 1.1 },
      materials.woodDark,
    );
    for (let index = 0; index < 6; index += 1) {
      addBox(
        scene,
        { x: 16.3 + index * 1.45, y: 0.44, z: -18.3 },
        { x: 1.1, y: 0.34, z: 0.72 },
        index % 2 ? materials.wood : materials.woodDark,
      );
    }
    addCollider(20, -18.3, 4.8, 0.75);
  }

  function buildVanMarkers() {
    for (const [index, marker] of arena.vanMarkers.entries()) {
      const root = new THREE.Group();
      root.position.set(marker.x, 0, marker.z);
      scene.add(root);
      addMesh(
        root,
        new THREE.TorusGeometry(1.45, 0.08, 5, 28),
        makeMaterial(0xf4d078, { emissive: 0x5a3c12, emissiveIntensity: 0.25 }),
        { y: 0.05 },
      );
      addMesh(
        root,
        new THREE.CylinderGeometry(0.11, 0.11, 1.9, 5),
        materials.cream,
        { x: 0, y: 1.05, z: 0 },
      );
      addMesh(
        root,
        new THREE.ConeGeometry(0.34, 0.57, 4),
        materials.gold,
        { x: 0, y: 2.03, z: 0 },
        null,
        { z: Math.PI },
      );
      const sign = makeLabelSprite(marker.label, "#fff1cc", "#71593c");
      sign.position.set(0, 2.8, 0);
      sign.scale.set(3.7, 0.7, 1);
      root.add(sign);
      const exclusion = new THREE.Group();
      for (let index = 0; index < 28; index += 1) {
        const angle = (index / 28) * Math.PI * 2;
        addMesh(
          exclusion,
          new THREE.BoxGeometry(0.28, 0.025, 0.07),
          makeMaterial(0xffefb8, { transparent: true, opacity: 0.7 }),
          {
            x: Math.cos(angle) * roundConfig.dogCarrierExclusionRadius,
            y: 0.06,
            z: Math.sin(angle) * roundConfig.dogCarrierExclusionRadius,
          },
          null,
          { y: -angle },
        );
      }
      root.add(exclusion);
      const van = new THREE.Group();
      addBox(
        van,
        { y: 0.72 },
        { x: 4.6, y: 1.2, z: 2.1 },
        makeMaterial(0xd4d5c1),
      );
      addBox(
        van,
        { x: 1.25, y: 1.37, z: 0 },
        { x: 1.75, y: 0.72, z: 1.82 },
        makeMaterial(0x81989a),
      );
      addBox(
        van,
        { x: 2.13, y: 0.87, z: 0.72 },
        { x: 0.18, y: 0.24, z: 0.32 },
        makeMaterial(0xffeaa0, { emissive: 0xffd764, emissiveIntensity: 1.1 }),
      );
      addBox(
        van,
        { x: 2.13, y: 0.87, z: -0.72 },
        { x: 0.18, y: 0.24, z: 0.32 },
        makeMaterial(0xffeaa0, { emissive: 0xffd764, emissiveIntensity: 1.1 }),
      );
      for (const x of [-1.35, 1.35])
        for (const z of [-0.78, 0.78]) {
          addMesh(
            van,
            new THREE.CylinderGeometry(0.34, 0.34, 0.18, 8),
            materials.dark,
            { x, y: 0.34, z },
            null,
            { z: Math.PI / 2 },
          );
        }
      const door = new THREE.Group();
      door.position.set(-2.22, 1.15, 0);
      addBox(
        door,
        { x: -0.06, y: 0, z: 0 },
        { x: 0.13, y: 1.18, z: 1.9 },
        makeMaterial(0x9d9c86),
      );
      van.add(door);
      van.userData.door = door;
      van.position.set(0, 0, 0);
      van.visible = false;
      root.add(van);
      root.userData.van = van;
      root.userData.exclusion = exclusion;
      root.visible = false;
      root.userData.seed = index * 0.67;
      visuals.set(`van-${index}`, root);
    }
  }

  function buildActors() {
    const teamIndex = { cats: 0, dogs: 0 };
    for (const player of players) {
      const team = player.team === "dogs" ? "dogs" : "cats";
      createActor(player, teamIndex[team]++);
    }
  }

  function createActor(player, index) {
    {
      const team = player.team === "dogs" ? "dogs" : "cats";
      const spawn = getSpawn(player, index);
      const stats = makeActorStats(player);
      const state = {
        id: player.id,
        player,
        x: spawn.x,
        z: spawn.z,
        previousX: spawn.x,
        previousZ: spawn.z,
        previousYaw: team === "cats" ? Math.PI / 2 : -Math.PI / 2,
        vx: 0,
        vz: 0,
        yaw: team === "cats" ? Math.PI / 2 : -Math.PI / 2,
        dashTimer: 0,
        dashCooldown: 0,
        dashX: 0,
        dashZ: 0,
        lastDashHeld: false,
        hp: stats.maxHp,
        maxHp: stats.maxHp,
        radius: stats.radius,
        isBot: Boolean(player.isBot),
        abilityCooldown: 0,
        abilityCooldownMax: classAbility(player)?.cooldown || 0,
        abilityDashTimer: 0,
        abilityDashX: 0,
        abilityDashZ: 0,
        abilityDashSpeed: 0,
        abilityKind: null,
        abilityLanding: false,
        abilityHitIds: [],
        zoomTimer: 0,
        howlTimer: 0,
        auraTimer: 0,
        revealTimer: 0,
        healMoveTimer: 0,
        rootedTimer: 0,
        healingTotal: 0,
        downed: false,
        escaped: false,
        downedTimer: 0,
        respawnTimer: 0,
        respawnCount: 0,
        stunnedTimer: 0,
        invulnerabilityTimer: 0,
        snaredTimer: 0,
        slowedTimer: 0,
        slowScale: 1,
        distractedTimer: 0,
        catnipTimer: 0,
        distractionX: 0,
        distractionZ: 0,
        attackCooldown: 0,
        actionWindup: null,
        lastInteractHeld: false,
        reviveTargetId: null,
        reviveProgress: 0,
        healingTimer: 0,
        healingTarget: 0,
        healingRecipientId: null,
        items: player.isBot
          ? [createItemStack("bite"), null]
          : team === "dogs"
            ? [createItemStack("bite"), createItemStack("stink")]
            : [createItemStack("mallet"), createItemStack("spray")],
        selectedSlot: 0,
        target: null,
        lastProcessedInputSequence: 0,
        lastReceivedInputSequence: 0,
      };
      states.set(player.id, state);
      inputs.set(player.id, {
        x: 0,
        z: 0,
        aim: state.yaw,
        dash: false,
        interact: false,
      });
      const visual = makeCharacter(player, index);
      scene.add(visual.root);
      visuals.set(player.id, visual);
    }
  }

  function getSpawn(player, index) {
    const team = player.team === "dogs" ? "dogs" : "cats";
    const spawn = team === "dogs" ? arena.dogSpawn : arena.catSpawn;
    const playerIndex =
      team === "dogs"
        ? players
            .filter((entry) => entry.team === "dogs")
            .findIndex((entry) => entry.id === player.id)
        : players
            .filter((entry) => entry.team !== "dogs")
            .findIndex((entry) => entry.id === player.id);
    const column = playerIndex % 2;
    const row = Math.floor(playerIndex / 2);
    const teamCount = players.filter((entry) =>
      team === "dogs" ? entry.team === "dogs" : entry.team !== "dogs",
    ).length;
    const rows = Math.ceil(teamCount / 2);
    return {
      x: spawn.x + (column ? spawn.columnGap : -spawn.columnGap),
      z: spawn.z + (row - (rows - 1) / 2) * spawn.rowGap,
    };
  }

  function makeCharacter(player, index) {
    const isDog = player.team === "dogs";
    const colors = isDog ? PALETTE.dogs : PALETTE.cats;
    const root = new THREE.Group();
    const bodyColor = makeMaterial(colors[index % colors.length]);
    const accentColor = makeMaterial(isDog ? 0x59645f : 0xb96e51);
    const muzzleColor = makeMaterial(isDog ? 0xc0b29e : 0xf3d5aa);
    const legColor = makeMaterial(
      isDog ? 0x626d68 : colors[index % colors.length],
    );
    const head = new THREE.Group();
    const body = addMesh(
      root,
      new THREE.SphereGeometry(0.47, 9, 7),
      bodyColor,
      { x: 0, y: 0.56, z: -0.03 },
      isDog ? { x: 0.9, y: 0.82, z: 1.28 } : { x: 0.9, y: 0.84, z: 1.08 },
    );
    root.add(head);
    head.position.set(0, isDog ? 0.97 : 1.04, isDog ? 0.4 : 0.42);
    addMesh(
      head,
      new THREE.SphereGeometry(isDog ? 0.37 : 0.4, 9, 7),
      bodyColor,
      { y: 0.02 },
      isDog ? { x: 1.04, y: 0.91, z: 0.94 } : { x: 1, y: 0.98, z: 0.9 },
    );

    if (isDog) {
      buildDogFace(head, bodyColor, accentColor, muzzleColor, player.className);
    } else {
      buildCatFace(head, accentColor);
    }

    const legs = [];
    for (const x of [-0.25, 0.25]) {
      for (const z of [-0.33, 0.32]) {
        const leg = new THREE.Group();
        leg.position.set(x, 0.42, z);
        addMesh(
          leg,
          new THREE.CapsuleGeometry(0.1, isDog ? 0.27 : 0.26, 2, 4),
          legColor,
          { y: -0.15 },
        );
        addMesh(
          leg,
          new THREE.SphereGeometry(0.12, 6, 5),
          muzzleColor,
          { x: 0, y: -0.31, z: 0.06 },
          { x: 1.05, y: 0.65, z: 1.3 },
        );
        root.add(leg);
        legs.push(leg);
      }
    }

    const tail = new THREE.Group();
    tail.position.set(0, 0.71, isDog ? -0.55 : -0.49);
    root.add(tail);
    for (let segment = 0; segment < 4; segment += 1) {
      const size = 0.2 - segment * 0.026;
      addMesh(
        tail,
        new THREE.SphereGeometry(size, 6, 5),
        bodyColor,
        { x: 0, y: segment * 0.15, z: -segment * 0.1 },
        { x: 0.88, y: 0.88, z: 1.13 },
      );
    }

    const shadow = addMesh(
      root,
      new THREE.CircleGeometry(0.58, 12),
      makeMaterial(0x414537, {
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
      }),
      { y: 0.025 },
      isDog ? { x: 1.35, y: 0.88, z: 1 } : { x: 1.13, y: 0.8, z: 1 },
      { x: -Math.PI / 2 },
    );
    shadow.renderOrder = 1;

    const label = makeLabelSprite(
      player.name,
      isDog ? "#dbe8e3" : "#ffe9c4",
      isDog ? "#374847" : "#614532",
    );
    label.position.set(0, isDog ? 2.35 : 2.4, 0);
    label.scale.set(2.15, 0.48, 1);
    root.add(label);

    return {
      root,
      body,
      head,
      legs,
      tail,
      label,
      isDog,
      color: bodyColor,
      accentColor,
      pulse: Math.random() * Math.PI * 2,
      dashRing: null,
      dashVisual: 0,
    };
  }

  function buildCatFace(head, accent) {
    const earMaterial = accent;
    for (const x of [-0.22, 0.22]) {
      addMesh(
        head,
        new THREE.ConeGeometry(0.19, 0.39, 4),
        earMaterial,
        { x, y: 0.36, z: -0.005 },
        null,
        { z: x < 0 ? 0.16 : -0.16 },
      );
      addMesh(
        head,
        new THREE.SphereGeometry(0.066, 7, 5),
        materials.eye,
        { x: x * 0.62, y: 0.08, z: 0.33 },
        { x: 0.8, y: 1.2, z: 0.55 },
      );
      addMesh(head, new THREE.SphereGeometry(0.022, 5, 4), materials.eyeShine, {
        x: x * 0.62 - 0.02,
        y: 0.112,
        z: 0.363,
      });
      addMesh(head, new THREE.SphereGeometry(0.035, 5, 4), materials.cream, {
        x: x * 0.62,
        y: -0.12,
        z: 0.315,
      });
    }
    addMesh(
      head,
      new THREE.SphereGeometry(0.055, 5, 4),
      materials.nose,
      { y: -0.025, z: 0.37 },
      { x: 1, y: 0.7, z: 0.7 },
    );
  }

  function buildDogFace(head, fur, accent, muzzle, className) {
    const earScale = className === "Great Dane" ? 1.12 : 1;
    for (const x of [-0.31, 0.31]) {
      const ear = addMesh(
        head,
        new THREE.SphereGeometry(0.16, 7, 5),
        accent,
        { x, y: 0.05, z: -0.04 },
        { x: 1.06, y: 1.48 * earScale, z: 0.66 },
      );
      ear.rotation.z = x < 0 ? -0.2 : 0.2;
      addMesh(
        head,
        new THREE.SphereGeometry(0.07, 7, 5),
        materials.eye,
        { x: x * 0.6, y: 0.05, z: 0.31 },
        { x: 0.8, y: 1.25, z: 0.62 },
      );
      addMesh(head, new THREE.SphereGeometry(0.026, 5, 4), materials.eyeShine, {
        x: x * 0.6 - 0.022,
        y: 0.078,
        z: 0.345,
      });
    }
    addMesh(
      head,
      new THREE.SphereGeometry(0.2, 7, 5),
      muzzle,
      { x: 0, y: -0.15, z: 0.28 },
      { x: 1.18, y: 0.69, z: 0.75 },
    );
    addMesh(
      head,
      new THREE.SphereGeometry(0.07, 6, 4),
      materials.dark,
      { y: -0.11, z: 0.43 },
      { x: 1.05, y: 0.64, z: 0.55 },
    );
    const tongue = addMesh(
      head,
      new THREE.SphereGeometry(0.09, 6, 4),
      makeMaterial(0xe77777),
      { x: 0.04, y: -0.28, z: 0.37 },
      { x: 0.68, y: 1.55, z: 0.8 },
    );
    tongue.userData.isTongue = true;
  }

  function makeLabelSprite(name, foreground, background) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    context.fillStyle = `${background}dd`;
    context.beginPath();
    context.roundRect(4, 9, 504, 110, 34);
    context.fill();
    context.fillStyle = foreground;
    context.font = '700 48px "DM Sans", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(name).slice(0, 16), 256, 66, 470);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: true,
      }),
    );
    sprite.userData.texture = texture;
    return sprite;
  }

  function createItemStack(itemId) {
    return {
      itemId,
      charges: combat.items[itemId]?.charges ?? 0,
    };
  }

  function classEntry(player) {
    return classConfig[player?.className] || null;
  }

  function classAbility(player) {
    return classEntry(player)?.ability || null;
  }

  function classPassive(player) {
    return classEntry(player)?.passive || {};
  }

  function botTuning() {
    return botConfig.byDifficulty[difficulty] || botConfig.byDifficulty.normal;
  }

  function makeActorStats(player) {
    const passive = classPassive(player);
    let maxHp = combat.maxHealth * (passive.maxHpScale || 1);
    if (
      player.team === "dogs" &&
      !player.isBot &&
      humanTeamCounts.dogs < humanTeamCounts.cats
    ) {
      maxHp *= combat.outnumberedDogHpScale;
    }
    if (player.isBot) maxHp *= botTuning().hpScale;
    return {
      maxHp: Math.round(maxHp),
      radius: passive.radius || arena.playerRadius,
    };
  }

  // Every speed modifier is derived from replicated state (hp, timers) so a guest's
  // predicted movement matches the host's simulation.
  function speedMultiplier(state) {
    const passive = classPassive(state.player);
    let scale = passive.speedScale || 1;
    if (
      passive.lowHpSpeedScale &&
      state.hp < state.maxHp * passive.lowHpThreshold
    ) {
      scale *= passive.lowHpSpeedScale;
    }
    if (state.slowedTimer > 0) scale *= state.slowScale;
    if (state.catnipTimer > 0) scale *= combat.items.catnip.speedScale;
    if (state.zoomTimer > 0) scale *= classConfig.Terrier.ability.speedScale;
    if (state.howlTimer > 0) scale *= classConfig.Hound.ability.buffSpeedScale;
    if (state.auraTimer > 0) scale *= classConfig.Hound.passive.auraSpeedScale;
    if (state.isBot) scale *= botTuning().speedScale;
    return scale;
  }

  function damageMultiplier(attacker) {
    if (!attacker) return 1;
    const passive = classPassive(attacker.player);
    let scale = 1;
    if (passive.fullHpDamageScale && attacker.hp >= attacker.maxHp)
      scale *= passive.fullHpDamageScale;
    if (attacker.isBot) scale *= botTuning().damageScale;
    return scale;
  }

  function setPlayerInput(playerId, input) {
    if (!states.has(playerId) || !input) return;
    const state = states.get(playerId);
    const sequence = Number.isFinite(input.sequence) ? input.sequence : null;
    if (sequence !== null && sequence <= state.lastReceivedInputSequence)
      return;
    if (sequence !== null) state.lastReceivedInputSequence = sequence;
    inputs.set(playerId, {
      x: clamp(Number(input.x) || 0, -1, 1),
      z: clamp(Number(input.z) || 0, -1, 1),
      aim: Number.isFinite(Number(input.aim)) ? Number(input.aim) : 0,
      dash: Boolean(input.dash),
      interact: Boolean(input.interact),
      sequence,
    });
  }

  function performAction(playerId, action) {
    if (!isHost || !action) return;
    if (action.type === "next-round" || action.type === "return-lobby") {
      onRoundAction?.(
        playerId,
        action.type === "next-round" ? "next-round" : "return-lobby",
      );
      return;
    }
    if (!states.has(playerId)) return;
    const state = states.get(playerId);
    if (action.type === "switch") {
      if (state.downed || state.respawnTimer > 0) return;
      state.selectedSlot = clamp(Number(action.slot) || 0, 0, 1);
      return;
    }
    if (action.type === "ability") {
      useAbility(state, action.aim);
      return;
    }
    if (action.type !== "use" || state.downed || state.respawnTimer > 0) return;
    if (state.stunnedTimer > 0 || state.snaredTimer > 0) return;
    if (state.rootedTimer > 0 || state.abilityDashTimer > 0) return;
    if (roundFlow.phase === "results") return;
    if (
      state.attackCooldown > 0 ||
      state.actionWindup ||
      state.healingTimer > 0
    )
      return;

    const aim = Number.isFinite(action.aim) ? action.aim : state.yaw;
    state.yaw = dampAngle(state.yaw, aim, movement.acceleration, 0.12);
    const stack = state.items[state.selectedSlot];
    const exhausted = stack && stack.charges === 0;
    const itemId =
      !stack || exhausted
        ? state.player.team === "dogs"
          ? "bite"
          : null
        : stack.itemId;
    if (!itemId) return;
    const item =
      itemId === "bite"
        ? { name: "Bite", kind: "melee", ...combat.basicDogBite }
        : combat.items[itemId];
    if (!item || (stack && stack.charges === 0)) return;

    if (item.kind === "heal") {
      const nearbyAlly = [...states.values()]
        .filter(
          (other) =>
            other.id !== state.id &&
            other.player.team === state.player.team &&
            !other.downed &&
            other.respawnTimer <= 0 &&
            other.hp < other.maxHp,
        )
        .map((other) => ({
          other,
          distance: Math.hypot(state.x - other.x, state.z - other.z),
        }))
        .filter(({ distance }) => distance <= combat.interactionRange)
        .sort((a, b) => a.distance - b.distance)[0]?.other;
      if (!nearbyAlly && state.hp >= state.maxHp) {
        showCombatText(state.x, state.z, "NOT HUNGRY!", 0xffe29f);
        return;
      }
      state.healingTimer = item.channelSeconds;
      state.healingTotal = item.channelSeconds;
      state.healingTarget = item.healing;
      state.healingRecipientId = nearbyAlly?.id || state.id;
      state.healingItemId = itemId;
      state.healingSlot = state.selectedSlot;
      state.healingStartX = state.x;
      state.healingStartZ = state.z;
      state.healMoveTimer = 0;
      state.attackCooldown = item.cooldown;
      if (stack && stack.charges > 0) stack.charges -= 1;
      showCombatText(
        state.x,
        state.z,
        nearbyAlly ? "SHARING SNACK!" : "SNACK TIME!",
        0xffe29f,
      );
      return;
    }

    if (stack && stack.charges > 0) stack.charges -= 1;
    state.attackCooldown =
      item.cooldown * (state.isBot ? botTuning().cooldownScale : 1);
    const kind = ["melee", "cone"].includes(item.kind)
      ? item.kind
      : "projectile";
    const passive = classPassive(state.player);
    const isBite = itemId === "bite";
    const length =
      (item.range || combat.items.launcher.range) *
      (isBite ? passive.biteRangeScale || 1 : 1);
    const startDistance = kind === "melee" || kind === "cone" ? length : 1.05;
    const telegraph = {
      id: `telegraph-${nextEntityId++}`,
      ownerId: playerId,
      itemId,
      x: state.x,
      z: state.z,
      yaw: state.yaw,
      kind,
      range: length,
      halfAngle: item.halfAngle || 0.65,
      damageScale: isBite ? passive.biteDamageScale || 1 : 1,
      timeRemaining: combat.attackWindupSeconds,
      totalTime: combat.attackWindupSeconds,
      projectX: state.x + Math.sin(state.yaw) * startDistance,
      projectZ: state.z + Math.cos(state.yaw) * startDistance,
    };
    telegraphs.push(telegraph);
    state.actionWindup = telegraph.id;
  }

  function processInteraction(state, input, dt) {
    if (state.downed || state.respawnTimer > 0) {
      state.lastInteractHeld = input.interact;
      return;
    }
    if (!input.interact) {
      state.reviveTargetId = null;
      state.reviveProgress = 0;
      state.lastInteractHeld = false;
      return;
    }

    const isNewPress = !state.lastInteractHeld;
    state.lastInteractHeld = true;
    if (state.player.team === "cats") {
      let closest = null;
      let closestDistance = combat.interactionRange;
      for (const pickup of pickups) {
        if (!pickup.active || pickup.team !== "cats") continue;
        const distance = Math.hypot(state.x - pickup.x, state.z - pickup.z);
        if (distance <= closestDistance) {
          closest = pickup;
          closestDistance = distance;
        }
      }
      if (closest && isNewPress) {
        collectPickup(state, closest);
        return;
      }
    }

    if (state.player.team === "dogs" && isNewPress) {
      let closest = null;
      for (const pickup of pickups) {
        if (!pickup.active || pickup.team !== "dogs") continue;
        const distance = Math.hypot(state.x - pickup.x, state.z - pickup.z);
        if (
          distance <= combat.interactionRange &&
          (!closest || distance < closest.distance)
        ) {
          closest = { pickup, distance };
        }
      }
      if (closest) {
        collectPickup(state, closest.pickup);
        return;
      }
    }

    const nearbyTrap = traps.find(
      (trap) =>
        trap.armed !== false &&
        Math.hypot(state.x - trap.x, state.z - trap.z) <=
          combat.interactionRange,
    );
    if (nearbyTrap && isNewPress) {
      nearbyTrap.armed = false;
      nearbyTrap.timeRemaining = 0;
      showCombatText(state.x, state.z, "DEFUSED!", 0xb8e89d);
      return;
    }

    if (state.player.team !== "cats") return;
    if (state.stunnedTimer > 0 || state.snaredTimer > 0) return;
    const target = [...states.values()]
      .filter(
        (other) =>
          other.player.team === "cats" && other.downed && other.id !== state.id,
      )
      .map((other) => ({
        other,
        distance: Math.hypot(state.x - other.x, state.z - other.z),
      }))
      .filter(({ distance }) => distance <= combat.reviveInteractionRadius)
      .sort((a, b) => a.distance - b.distance)[0]?.other;
    if (!target) {
      state.reviveTargetId = null;
      state.reviveProgress = 0;
      return;
    }
    if (state.reviveTargetId !== target.id) {
      state.reviveTargetId = target.id;
      state.reviveProgress = 0;
    }
    state.reviveProgress += dt;
    if (state.reviveProgress >= combat.reviveSeconds) {
      target.downed = false;
      target.hp = Math.ceil(target.maxHp * combat.reviveHealthRatio);
      target.downedTimer = 0;
      target.stunnedTimer = combat.downedInvulnerabilitySeconds;
      target.invulnerabilityTimer = combat.downedInvulnerabilitySeconds;
      state.reviveTargetId = null;
      state.reviveProgress = 0;
      showCombatText(target.x, target.z, "REVIVED!", 0xffefbd);
      showCombatText(state.x, state.z, "GOOD NURSE!", 0xffefbd);
      scoreFor(state.id).revives += 1;
    }
  }

  function collectPickup(state, pickup) {
    const emptySlot = state.items.findIndex(
      (stack) => !stack || stack.charges === 0,
    );
    // Never overwrite an infinite-use weapon (mallet, bite) if a finite item can go.
    const other = state.selectedSlot === 0 ? 1 : 0;
    const replaceable = [state.selectedSlot, other].find(
      (index) => state.items[index] && state.items[index].charges > 0,
    );
    const slot =
      emptySlot >= 0 ? emptySlot : (replaceable ?? state.selectedSlot);
    state.items[slot] = createItemStack(pickup.item);
    state.selectedSlot = slot;
    pickup.active = false;
    pickup.respawnTimer = combat.pickupRespawnSeconds;
    showCombatText(state.x, state.z, "GOT IT!", 0xffe4a1);
    onNotice?.(`${combat.items[pickup.item]?.name || pickup.item} picked up`);
    updateCombatHud();
  }

  function tickPlayerCombatState(state, input, dt) {
    state.attackCooldown = Math.max(0, state.attackCooldown - dt);
    state.stunnedTimer = Math.max(0, state.stunnedTimer - dt);
    state.invulnerabilityTimer = Math.max(0, state.invulnerabilityTimer - dt);
    state.snaredTimer = Math.max(0, state.snaredTimer - dt);
    state.slowedTimer = Math.max(0, state.slowedTimer - dt);
    state.distractedTimer = Math.max(0, state.distractedTimer - dt);
    state.catnipTimer = Math.max(0, state.catnipTimer - dt);
    state.abilityCooldown = Math.max(0, state.abilityCooldown - dt);
    state.zoomTimer = Math.max(0, state.zoomTimer - dt);
    state.howlTimer = Math.max(0, state.howlTimer - dt);
    state.auraTimer = Math.max(0, state.auraTimer - dt);
    state.revealTimer = Math.max(0, state.revealTimer - dt);
    state.rootedTimer = Math.max(0, state.rootedTimer - dt);
    tickAbilityMotion(state);

    if (state.healingTimer > 0) {
      const recipient = states.get(state.healingRecipientId) || state;
      state.healMoveTimer =
        Math.hypot(input.x, input.z) > 0.1 || input.dash
          ? state.healMoveTimer + dt
          : 0;
      const moved =
        state.healMoveTimer > combat.healCancelMoveSeconds ||
        Math.hypot(
          state.x - state.healingStartX,
          state.z - state.healingStartZ,
        ) > combat.healCancelDisplacement;
      if (
        moved ||
        state.stunnedTimer > 0 ||
        state.snaredTimer > 0 ||
        state.downed ||
        recipient.downed ||
        recipient.stunnedTimer > 0 ||
        Math.hypot(state.x - recipient.x, state.z - recipient.z) >
          combat.interactionRange + combat.healCancelDisplacement
      ) {
        state.healingTimer = 0;
        state.healingRecipientId = null;
        showCombatText(state.x, state.z, "SNACK DROPPED!", 0xffb4a1);
      } else {
        state.healingTimer = Math.max(0, state.healingTimer - dt);
        if (state.healingTimer === 0) {
          recipient.hp = Math.min(
            recipient.maxHp,
            recipient.hp + state.healingTarget,
          );
          showCombatText(
            recipient.x,
            recipient.z,
            `+${state.healingTarget} HP`,
            0xb8e89d,
          );
          if (recipient.id !== state.id) {
            scoreFor(state.id).treatsShared += 1;
            showCombatText(state.x, state.z, "GOOD FRIEND!", 0xffe4a1);
          }
          state.healingRecipientId = null;
          state.healingItemId = null;
        }
      }
    }

    if (state.player.team === "dogs" && state.respawnTimer > 0) {
      state.respawnTimer = Math.max(0, state.respawnTimer - dt);
      if (state.respawnTimer === 0) respawnDog(state);
    }
  }

  // ---- Class abilities (host-authoritative) ----
  function addPulse(x, z, radius, color, seconds = 0.6) {
    pulses.push({
      id: `pulse-${nextEntityId++}`,
      x,
      z,
      radius,
      color,
      timeRemaining: seconds,
      totalTime: seconds,
    });
  }

  function enemiesOf(state) {
    return [...states.values()].filter(
      (other) =>
        other.player.team !== state.player.team &&
        !other.downed &&
        !other.escaped &&
        other.respawnTimer <= 0,
    );
  }

  function startAbilityDash(state, kind, dirX, dirZ, speed, duration) {
    state.abilityKind = kind;
    state.abilityDashX = dirX;
    state.abilityDashZ = dirZ;
    state.abilityDashSpeed = speed;
    state.abilityDashTimer = duration;
    state.abilityHitIds = [];
  }

  function useAbility(state, aimValue) {
    const ability = classAbility(state.player);
    if (!ability) return;
    if (state.downed || state.escaped || state.respawnTimer > 0) return;
    if (roundFlow.phase === "results") return;
    if (
      state.abilityCooldown > 0 ||
      state.stunnedTimer > 0 ||
      state.snaredTimer > 0 ||
      state.rootedTimer > 0 ||
      state.actionWindup ||
      state.healingTimer > 0 ||
      state.abilityDashTimer > 0
    )
      return;
    const aim = Number.isFinite(aimValue) ? aimValue : state.yaw;
    state.yaw = aim;
    const aimX = Math.sin(aim);
    const aimZ = Math.cos(aim);
    const input = inputs.get(state.id);
    const inputLength = input ? Math.hypot(input.x, input.z) : 0;
    const moveX = inputLength > 0.1 ? input.x / inputLength : aimX;
    const moveZ = inputLength > 0.1 ? input.z / inputLength : aimZ;
    const multiplier = state.isBot ? 1.5 : 1;
    const targets = enemiesOf(state);

    switch (ability.id) {
      case "yowl": {
        addPulse(state.x, state.z, ability.radius, 0xffd37a);
        showCombatText(state.x, state.z, "PANIC YOWL!", 0xffe4a1);
        for (const target of targets) {
          if (Math.hypot(target.x - state.x, target.z - state.z) > ability.radius)
            continue;
          if (target.invulnerabilityTimer > 0) continue;
          target.stunnedTimer = Math.max(target.stunnedTimer, ability.stunSeconds);
          target.healingTimer = 0;
          showCombatText(target.x, target.z, "YEEOWCH!", 0xffd5a0);
        }
        break;
      }
      case "dodge": {
        startAbilityDash(state, "dodge", moveX, moveZ, ability.speed, ability.duration);
        state.invulnerabilityTimer = Math.max(
          state.invulnerabilityTimer,
          ability.invulnerability,
        );
        showCombatText(state.x, state.z, "SLICK!", 0xffe4a1);
        break;
      }
      case "bump": {
        addPulse(
          state.x + aimX * ability.range * 0.6,
          state.z + aimZ * ability.range * 0.6,
          ability.range * 0.7,
          0xf1c086,
          0.4,
        );
        showCombatText(state.x, state.z, "BELLY BUMP!", 0xffe4a1);
        for (const target of targets) {
          const dx = target.x - state.x;
          const dz = target.z - state.z;
          const distance = Math.hypot(dx, dz);
          if (distance > ability.range + arena.playerRadius) continue;
          const delta = Math.atan2(
            Math.sin(Math.atan2(dx, dz) - aim),
            Math.cos(Math.atan2(dx, dz) - aim),
          );
          if (Math.abs(delta) > ability.halfAngle) continue;
          hitTarget(
            target,
            ability.damage,
            state.id,
            ability.knockback,
            "bump",
          );
          if (target.invulnerabilityTimer <= 0 || target.hp > 0)
            target.stunnedTimer = Math.max(target.stunnedTimer, ability.stunSeconds);
        }
        break;
      }
      case "pounce": {
        startAbilityDash(state, "pounce", aimX, aimZ, ability.speed, ability.duration);
        state.abilityLanding = true;
        showCombatText(state.x, state.z, "POUNCE!", 0xffe4a1);
        break;
      }
      case "zoomies": {
        state.zoomTimer = ability.seconds;
        addPulse(state.x, state.z, 1.8, 0xe9e1bf, 0.4);
        showCombatText(state.x, state.z, "ZOOMIES!", 0xffe4a1);
        break;
      }
      case "charge": {
        state.rootedTimer = ability.windup;
        const id = `telegraph-${nextEntityId++}`;
        telegraphs.push({
          id,
          ownerId: state.id,
          itemId: null,
          abilityId: "charge",
          x: state.x,
          z: state.z,
          yaw: aim,
          kind: "arrow",
          range: ability.speed * ability.duration,
          halfAngle: 0,
          timeRemaining: ability.windup,
          totalTime: ability.windup,
        });
        state.actionWindup = id;
        showCombatText(state.x, state.z, "GRRR...", 0xffb4a1);
        break;
      }
      case "howl": {
        addPulse(state.x, state.z, ability.radius, 0xb9c8d6, 0.8);
        showCombatText(state.x, state.z, "AROOOO!", 0xffe4a1);
        for (const ally of states.values()) {
          if (ally.player.team !== "dogs" || ally.respawnTimer > 0) continue;
          if (Math.hypot(ally.x - state.x, ally.z - state.z) <= ability.radius)
            ally.howlTimer = ability.buffSeconds;
          if (!ally.isBot) ally.revealTimer = ability.revealSeconds;
        }
        break;
      }
      case "slam": {
        state.rootedTimer = ability.windup;
        const id = `telegraph-${nextEntityId++}`;
        telegraphs.push({
          id,
          ownerId: state.id,
          itemId: null,
          abilityId: "slam",
          x: state.x,
          z: state.z,
          yaw: aim,
          kind: "ring",
          range: ability.radius,
          halfAngle: Math.PI,
          timeRemaining: ability.windup,
          totalTime: ability.windup,
        });
        state.actionWindup = id;
        showCombatText(state.x, state.z, "SLAM INCOMING!", 0xffb4a1);
        break;
      }
      default:
        return;
    }
    state.abilityCooldown = ability.cooldown * multiplier;
    state.abilityCooldownMax = ability.cooldown * multiplier;
  }

  function resolveAbilityTelegraph(attack, owner) {
    const ability = classAbility(owner.player);
    if (!ability || owner.downed || owner.respawnTimer > 0) return;
    owner.rootedTimer = 0;
    if (attack.abilityId === "charge") {
      startAbilityDash(
        owner,
        "charge",
        Math.sin(attack.yaw),
        Math.cos(attack.yaw),
        ability.speed,
        ability.duration,
      );
      return;
    }
    if (attack.abilityId === "slam") {
      addPulse(owner.x, owner.z, ability.radius, 0xd9554a, 0.7);
      showCombatText(owner.x, owner.z, "SLAM!", 0xffe4a1);
      cameraShakeRemaining = Math.max(cameraShakeRemaining, 0.25);
      for (const target of enemiesOf(owner)) {
        if (Math.hypot(target.x - owner.x, target.z - owner.z) > ability.radius)
          continue;
        hitTarget(target, ability.damage, owner.id, ability.knockback, "slam");
        target.stunnedTimer = Math.max(target.stunnedTimer, ability.stunSeconds);
      }
    }
  }

  // Landing hit for Pounce and body hits for Charge, evaluated every host tick.
  function tickAbilityMotion(state) {
    const ability = classAbility(state.player);
    if (!ability) return;
    if (state.abilityKind === "charge" && state.abilityDashTimer > 0) {
      for (const target of enemiesOf(state)) {
        if (state.abilityHitIds.includes(target.id)) continue;
        if (
          Math.hypot(target.x - state.x, target.z - state.z) >
          ability.hitRadius + arena.playerRadius
        )
          continue;
        state.abilityHitIds.push(target.id);
        hitTarget(target, ability.damage, state.id, ability.knockback, "charge");
      }
    }
    if (state.abilityLanding && state.abilityDashTimer <= 0) {
      state.abilityLanding = false;
      addPulse(state.x, state.z, ability.landingRadius, 0xf4d078, 0.45);
      for (const target of enemiesOf(state)) {
        if (
          Math.hypot(target.x - state.x, target.z - state.z) >
          ability.landingRadius + arena.playerRadius
        )
          continue;
        hitTarget(target, ability.damage, state.id, ability.knockback, "pounce");
      }
    }
  }

  // ---- Navigation grid and A* (used by AI dogs, cat bots and the dash-timer bot) ----
  let navGrid = null;

  function buildNavGrid() {
    const cell = botConfig.navCellSize;
    const cols = Math.ceil(arena.width / cell);
    const rows = Math.ceil(arena.depth / cell);
    const originX = -arena.width / 2;
    const originZ = -arena.depth / 2;
    const blocked = new Uint8Array(cols * rows);
    const margin = arena.playerRadius + 0.22;
    const edge = arena.outerInset + arena.playerRadius;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = originX + (col + 0.5) * cell;
        const z = originZ + (row + 0.5) * cell;
        let isBlocked =
          Math.abs(x) > arena.width / 2 - edge ||
          Math.abs(z) > arena.depth / 2 - edge;
        if (!isBlocked) {
          for (const obstacle of obstacles) {
            if (
              Math.abs(x - obstacle.x) < obstacle.halfX + margin &&
              Math.abs(z - obstacle.z) < obstacle.halfZ + margin
            ) {
              isBlocked = true;
              break;
            }
          }
        }
        blocked[row * cols + col] = isBlocked ? 1 : 0;
      }
    }
    navGrid = { cell, cols, rows, originX, originZ, blocked };
  }

  function navCellBlocked(col, row, team) {
    if (col < 0 || row < 0 || col >= navGrid.cols || row >= navGrid.rows)
      return true;
    if (navGrid.blocked[row * navGrid.cols + col]) return true;
    if (!roundFlow.fenceDropped) {
      const x = navGrid.originX + (col + 0.5) * navGrid.cell;
      if (team === "dogs" && x < arena.catFenceX + 0.9) return true;
      if (team !== "dogs" && x > arena.catFenceX - 0.9) return true;
    }
    return false;
  }

  function navNearestFree(col, row, team) {
    if (!navCellBlocked(col, row, team)) return { col, row };
    for (let radius = 1; radius <= 6; radius += 1) {
      let best = null;
      let bestDistance = Infinity;
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          if (navCellBlocked(col + dx, row + dz, team)) continue;
          const distance = dx * dx + dz * dz;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = { col: col + dx, row: row + dz };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  function findPath(fromX, fromZ, toX, toZ, team) {
    if (!navGrid) buildNavGrid();
    const { cell, cols, originX, originZ } = navGrid;
    const toCell = (x, z) => ({
      col: Math.floor((x - originX) / cell),
      row: Math.floor((z - originZ) / cell),
    });
    const startRaw = toCell(fromX, fromZ);
    const goalRaw = toCell(toX, toZ);
    const start = navNearestFree(startRaw.col, startRaw.row, team);
    const goal = navNearestFree(goalRaw.col, goalRaw.row, team);
    if (!start || !goal) return null;
    const key = (col, row) => row * cols + col;
    const open = [];
    const gScore = new Map([[key(start.col, start.row), 0]]);
    const cameFrom = new Map();
    const closed = new Set();
    const heuristic = (col, row) => {
      const dx = Math.abs(col - goal.col);
      const dz = Math.abs(row - goal.row);
      return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
    };
    const push = (node) => {
      open.push(node);
      let index = open.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (open[parent].f <= open[index].f) break;
        [open[parent], open[index]] = [open[index], open[parent]];
        index = parent;
      }
    };
    const pop = () => {
      const top = open[0];
      const last = open.pop();
      if (open.length) {
        open[0] = last;
        let index = 0;
        for (;;) {
          const left = index * 2 + 1;
          const right = left + 1;
          let smallest = index;
          if (left < open.length && open[left].f < open[smallest].f)
            smallest = left;
          if (right < open.length && open[right].f < open[smallest].f)
            smallest = right;
          if (smallest === index) break;
          [open[smallest], open[index]] = [open[index], open[smallest]];
          index = smallest;
        }
      }
      return top;
    };
    push({ col: start.col, row: start.row, f: heuristic(start.col, start.row) });
    const neighbors = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142],
    ];
    let found = false;
    let iterations = 0;
    while (open.length && iterations < 9000) {
      iterations += 1;
      const node = pop();
      const nodeKey = key(node.col, node.row);
      if (closed.has(nodeKey)) continue;
      closed.add(nodeKey);
      if (node.col === goal.col && node.row === goal.row) {
        found = true;
        break;
      }
      for (const [dx, dz, cost] of neighbors) {
        const col = node.col + dx;
        const row = node.row + dz;
        if (navCellBlocked(col, row, team)) continue;
        if (
          dx !== 0 &&
          dz !== 0 &&
          (navCellBlocked(node.col + dx, node.row, team) ||
            navCellBlocked(node.col, node.row + dz, team))
        )
          continue;
        const nextKey = key(col, row);
        if (closed.has(nextKey)) continue;
        const tentative = gScore.get(nodeKey) + cost;
        if (tentative >= (gScore.get(nextKey) ?? Infinity)) continue;
        gScore.set(nextKey, tentative);
        cameFrom.set(nextKey, nodeKey);
        push({ col, row, f: tentative + heuristic(col, row) });
      }
    }
    if (!found) return null;
    const path = [];
    let cursor = key(goal.col, goal.row);
    while (cursor !== undefined) {
      const col = cursor % cols;
      const row = Math.floor(cursor / cols);
      path.push({ x: originX + (col + 0.5) * cell, z: originZ + (row + 0.5) * cell });
      cursor = cameFrom.get(cursor);
    }
    path.reverse();
    path.push({ x: toX, z: toZ });
    return path;
  }

  function pathLength(path, fromX, fromZ) {
    if (!path?.length) return 0;
    let length = Math.hypot(path[0].x - fromX, path[0].z - fromZ);
    for (let index = 1; index < path.length; index += 1)
      length += Math.hypot(
        path[index].x - path[index - 1].x,
        path[index].z - path[index - 1].z,
      );
    return length;
  }

  // Steers `state` along `nav.path`. Returns a movement input vector.
  function steerAlongPath(state, nav, targetX, targetZ, dt) {
    nav.repath = (nav.repath ?? 0) - dt;
    if (!nav.path || nav.repath <= 0) {
      nav.path = findPath(state.x, state.z, targetX, targetZ, state.player.team);
      nav.index = 0;
      nav.repath = botConfig.repathSeconds;
    }
    const path = nav.path;
    if (!path || !path.length) {
      const dx = targetX - state.x;
      const dz = targetZ - state.z;
      const length = Math.hypot(dx, dz) || 1;
      return { x: dx / length, z: dz / length };
    }
    while (
      nav.index < path.length - 1 &&
      Math.hypot(path[nav.index].x - state.x, path[nav.index].z - state.z) < 0.65
    )
      nav.index += 1;
    const waypoint = path[Math.min(nav.index, path.length - 1)];
    const dx = waypoint.x - state.x;
    const dz = waypoint.z - state.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.05) return { x: 0, z: 0 };
    return { x: dx / length, z: dz / length };
  }

  // ---- Bot brains (dog filler AI, debug cat bots, dash autopilot) ----
  function brainFor(state) {
    let brain = botBrains.get(state.id);
    if (!brain) {
      brain = {
        nav: {},
        retarget: Math.random() * botConfig.retargetSeconds,
        targetId: null,
        wanderTimer: 0,
        wanderX: state.x,
        wanderZ: state.z,
      };
      botBrains.set(state.id, brain);
    }
    return brain;
  }

  function updateBotAI(state, dt) {
    const idle = { x: 0, z: 0, aim: state.yaw, dash: false, interact: false };
    if (debugFreezeBots && state.isBot) {
      inputs.set(state.id, idle);
      return;
    }
    if (state.downed || state.respawnTimer > 0 || state.escaped) {
      inputs.set(state.id, idle);
      return;
    }
    const brain = brainFor(state);
    const input =
      state.player.team === "dogs"
        ? dogBotInput(state, brain, dt)
        : catBotInput(state, brain, dt);
    inputs.set(state.id, { ...idle, ...input });
  }

  function dogBotInput(state, brain, dt) {
    const tuning = botTuning();
    if (!roundFlow.fenceDropped) {
      brain.wanderTimer -= dt;
      if (brain.wanderTimer <= 0) {
        brain.wanderTimer = 2 + Math.random() * 2.5;
        brain.wanderX = arena.catFenceX + 3 + Math.random() * 11;
        brain.wanderZ = (Math.random() - 0.5) * 24;
        brain.nav.path = null;
      }
      if (Math.hypot(brain.wanderX - state.x, brain.wanderZ - state.z) < 1)
        return { x: 0, z: 0 };
      const step = steerAlongPath(state, brain.nav, brain.wanderX, brain.wanderZ, dt);
      return { x: step.x * 0.55, z: step.z * 0.55, aim: Math.atan2(step.x, step.z) };
    }
    brain.retarget -= dt;
    if (brain.retarget <= 0) {
      brain.retarget = botConfig.retargetSeconds;
      let best = null;
      let bestDistance = Infinity;
      for (const cat of states.values()) {
        if (cat.player.team !== "cats" || cat.downed || cat.escaped) continue;
        const distance = Math.hypot(cat.x - state.x, cat.z - state.z);
        const sneaky = classPassive(cat.player).noticeRange;
        const notice = sneaky ? Math.min(sneaky, tuning.noticeRange) : tuning.noticeRange;
        if (distance > notice) continue;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = cat;
        }
      }
      brain.targetId = best?.id ?? null;
    }
    const target = brain.targetId ? states.get(brain.targetId) : null;
    if (!target || target.downed || target.escaped) {
      brain.targetId = null;
      // Patrol toward the cats' side; during the dash, toward the van.
      let goalX = 0;
      let goalZ = 0;
      if (roundFlow.phase === "dash" && roundFlow.vanEdge !== null) {
        const marker = arena.vanMarkers[roundFlow.vanEdge];
        goalX = marker.x + 4;
        goalZ = marker.z;
      } else {
        const cats = [...states.values()].filter(
          (cat) => cat.player.team === "cats" && !cat.downed && !cat.escaped,
        );
        if (cats.length) {
          goalX = cats.reduce((sum, cat) => sum + cat.x, 0) / cats.length;
          goalZ = cats.reduce((sum, cat) => sum + cat.z, 0) / cats.length;
        }
      }
      const step = steerAlongPath(state, brain.nav, goalX, goalZ, dt);
      return { x: step.x * 0.8, z: step.z * 0.8, aim: Math.atan2(step.x, step.z) };
    }
    const dx = target.x - state.x;
    const dz = target.z - state.z;
    const distance = Math.hypot(dx, dz);
    const aim = Math.atan2(dx, dz);
    const biteRange = combat.items.bite.range * botConfig.attackRangeScale;
    if (distance < biteRange) {
      performAction(state.id, { type: "use", aim });
      return { x: 0, z: 0, aim };
    }
    const step = steerAlongPath(state, brain.nav, target.x, target.z, dt);
    return { x: step.x, z: step.z, aim: Math.atan2(step.x, step.z) };
  }

  function catBotInput(state, brain, dt) {
    if (roundFlow.phase === "dash" && roundFlow.vanEdge !== null) {
      const marker = arena.vanMarkers[roundFlow.vanEdge];
      const step = steerAlongPath(state, brain.nav, marker.x, marker.z, dt);
      return { x: step.x, z: step.z, aim: Math.atan2(step.x, step.z) };
    }
    if (state.autopilot) return { x: 0, z: 0 };
    if (roundFlow.phase !== "hunt") return { x: 0, z: 0 };
    let nearest = null;
    let nearestDistance = botConfig.fleeRange;
    for (const dog of states.values()) {
      if (dog.player.team !== "dogs" || dog.respawnTimer > 0) continue;
      const distance = Math.hypot(dog.x - state.x, dog.z - state.z);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = dog;
      }
    }
    if (!nearest) return { x: 0, z: 0 };
    let awayX = state.x - nearest.x;
    let awayZ = state.z - nearest.z;
    // Bend toward the middle of the yard so bots don't pin themselves to walls.
    awayX += (0 - state.x) * 0.04;
    awayZ += (0 - state.z) * 0.08;
    const length = Math.hypot(awayX, awayZ) || 1;
    return { x: awayX / length, z: awayZ / length, aim: Math.atan2(awayX, awayZ) };
  }

  function respawnDog(state) {
    const index = Math.max(
      0,
      state.respawnCount % arena.doghousePositions.length,
    );
    const den = arena.doghousePositions[index];
    state.x = den.x + combat.respawnEdgeOffset;
    state.z = den.z;
    state.previousX = state.x;
    state.previousZ = state.z;
    state.vx = 0;
    state.vz = 0;
    state.hp = state.maxHp;
    state.downed = false;
    state.respawnCount += 1;
    state.stunnedTimer = combat.respawnProtectionSeconds;
    showCombatText(state.x, state.z, "BACK IN!", 0xffe4a1);
  }

  function tickCombatEntities(dt) {
    for (const event of combatEvents) event.timeRemaining -= dt;
    removeExpired(combatEvents);
    for (const pulse of pulses) pulse.timeRemaining -= dt;
    removeExpired(pulses);
    // Hound aura: nearby allied dogs run a little faster.
    const houndPassive = classConfig.Hound.passive;
    for (const hound of states.values()) {
      if (hound.player.className !== "Hound" || hound.respawnTimer > 0) continue;
      for (const ally of states.values()) {
        if (
          ally.id === hound.id ||
          ally.player.team !== "dogs" ||
          ally.respawnTimer > 0
        )
          continue;
        if (
          Math.hypot(ally.x - hound.x, ally.z - hound.z) <= houndPassive.auraRadius
        )
          ally.auraTimer = combat.statusRefreshSeconds;
      }
    }
    if (roundFlow.phase === "hunt" || roundFlow.phase === "dash") {
      for (const pickup of pickups) {
        if (pickup.active || !(pickup.respawnTimer > 0)) continue;
        pickup.respawnTimer -= dt;
        if (pickup.respawnTimer <= 0) pickup.active = true;
      }
    }
    for (const telegraph of [...telegraphs]) {
      telegraph.timeRemaining -= dt;
      if (telegraph.timeRemaining <= 0) {
        resolveTelegraph(telegraph);
        removeById(telegraphs, telegraph.id);
        const owner = states.get(telegraph.ownerId);
        if (owner?.actionWindup === telegraph.id) owner.actionWindup = null;
      }
    }
    for (const projectile of [...projectiles]) {
      projectile.timeRemaining -= dt;
      const oldX = projectile.x;
      const oldZ = projectile.z;
      projectile.x += projectile.vx * dt;
      projectile.z += projectile.vz * dt;
      const crossesClosedFence =
        !roundFlow.fenceDropped &&
        ((projectile.team === "cats" && projectile.x > arena.catFenceX) ||
          (projectile.team === "dogs" && projectile.x < arena.catFenceX));
      if (crossesClosedFence) {
        removeById(projectiles, projectile.id);
        continue;
      }
      const collision = [...states.values()].find(
        (target) =>
          projectile.itemId !== "catnip" &&
          target.player.team !== projectile.team &&
          !target.downed &&
          target.respawnTimer <= 0 &&
          Math.hypot(target.x - projectile.x, target.z - projectile.z) <
            combat.projectileRadius + arena.playerRadius,
      );
      if (collision) {
        hitTarget(
          collision,
          projectile.damage,
          projectile.ownerId,
          projectile.knockback || 0,
          projectile.kind,
        );
        if (projectile.kind === "bone") {
          collision.distractedTimer = combat.items.bone.distractionSeconds;
          collision.distractionX = projectile.x;
          collision.distractionZ = projectile.z;
          showCombatText(collision.x, collision.z, "SQUIRREL?", 0xffe4a1);
        } else if (projectile.kind === "yarn") {
          collision.snaredTimer = combat.items.yarn.snareSeconds;
          showCombatText(collision.x, collision.z, "TANGLED!", 0xffb9cf);
        } else if (projectile.kind === "cloud") {
          makeCloud(
            projectile.x,
            projectile.z,
            projectile.team,
            projectile.itemId,
          );
        }
        removeById(projectiles, projectile.id);
        continue;
      }
      const halfWidth = arena.width / 2 - arena.outerInset;
      const halfDepth = arena.depth / 2 - arena.outerInset;
      if (
        Math.abs(projectile.x) > halfWidth ||
        Math.abs(projectile.z) > halfDepth
      ) {
        if (projectile.bouncesLeft > 0) {
          if (Math.abs(projectile.x) > halfWidth) projectile.vx *= -1;
          if (Math.abs(projectile.z) > halfDepth) projectile.vz *= -1;
          projectile.bouncesLeft -= 1;
        } else projectile.timeRemaining = 0;
      }
      if (
        Math.hypot(
          projectile.x - (projectile.originX ?? oldX),
          projectile.z - (projectile.originZ ?? oldZ),
        ) > projectile.range
      )
        projectile.timeRemaining = 0;
      if (projectile.kind === "cloud" && projectile.timeRemaining <= 0)
        makeCloud(
          projectile.x,
          projectile.z,
          projectile.team,
          projectile.itemId || "stink",
        );
    }
    removeExpired(projectiles);

    for (const trap of traps) {
      trap.timeRemaining -= dt;
      if (trap.timeRemaining <= 0) trap.armed = false;
      if (trap.armed === false) continue;
      const target = [...states.values()].find(
        (state) =>
          state.player.team !== trap.team &&
          !state.downed &&
          state.respawnTimer <= 0 &&
          Math.hypot(state.x - trap.x, state.z - trap.z) <=
            combat.trapTriggerRadius,
      );
      if (target) {
        trap.armed = false;
        trap.timeRemaining = combat.items.trap.snareSeconds;
        target.snaredTimer = combat.items.trap.snareSeconds;
        scoreFor(trap.ownerId).trapsTriggered += 1;
        showCombatText(target.x, target.z, "BOING!", 0xffe4a1);
      }
    }
    removeExpired(traps);
    for (const cloud of clouds) {
      cloud.timeRemaining -= dt;
      for (const state of states.values()) {
        const affects =
          cloud.kind === "catnip"
            ? state.player.team === cloud.team
            : state.player.team !== cloud.team;
        if (!affects || state.downed) continue;
        if (
          Math.hypot(state.x - cloud.x, state.z - cloud.z) <= combat.cloudRadius
        ) {
          if (cloud.kind === "stink") {
            state.slowedTimer = combat.statusRefreshSeconds;
            state.slowScale = combat.items.stink.slowScale;
          } else
            state.catnipTimer = Math.max(
              state.catnipTimer,
              combat.statusRefreshSeconds,
            );
        }
      }
    }
    removeExpired(clouds);
    syncCombatVisuals();
  }

  function resolveTelegraph(attack) {
    const owner = states.get(attack.ownerId);
    if (!owner) return;
    if (attack.abilityId) {
      resolveAbilityTelegraph(attack, owner);
      return;
    }
    const item = combat.items[attack.itemId] || combat.basicDogBite;
    if (attack.itemId === "trap") {
      const halfWidth = arena.width / 2 - arena.outerInset;
      const minX =
        !roundFlow.fenceDropped && owner.player.team === "dogs"
          ? arena.catFenceX + arena.playerRadius + 0.2
          : -halfWidth + arena.playerRadius;
      const maxX =
        !roundFlow.fenceDropped && owner.player.team !== "dogs"
          ? arena.catFenceX - arena.playerRadius - 0.2
          : halfWidth - arena.playerRadius;
      traps.push({
        id: `trap-${nextEntityId++}`,
        ownerId: owner.id,
        team: owner.player.team,
        x: clamp(attack.projectX, minX, maxX),
        z: clamp(
          attack.projectZ,
          -arena.depth / 2 + arena.playerRadius,
          arena.depth / 2 - arena.playerRadius,
        ),
        armed: true,
        timeRemaining: combat.trapLifetimeSeconds,
      });
      return;
    }
    if (
      ["bone", "yarn", "catnip", "stink", "launcher"].includes(attack.itemId)
    ) {
      const isLauncher = attack.itemId === "launcher";
      const isCloud = ["catnip", "stink"].includes(attack.itemId);
      const speed = isCloud
        ? combat.projectileSpeed * 0.7
        : combat.projectileSpeed;
      projectiles.push({
        id: `projectile-${nextEntityId++}`,
        ownerId: owner.id,
        team: owner.player.team,
        kind: isCloud ? "cloud" : attack.itemId,
        itemId: attack.itemId,
        x: owner.x,
        z: owner.z,
        originX: owner.x,
        originZ: owner.z,
        vx: Math.sin(attack.yaw) * speed,
        vz: Math.cos(attack.yaw) * speed,
        damage: item.damage || 0,
        knockback: item.knockback || 0,
        range: item.range || 8,
        timeRemaining: combat.projectileLifetimeSeconds,
        bouncesLeft: isLauncher ? combat.projectileBounces : 0,
      });
      return;
    }
    for (const target of states.values()) {
      if (
        target.player.team === owner.player.team ||
        target.downed ||
        target.respawnTimer > 0
      )
        continue;
      const dx = target.x - owner.x;
      const dz = target.z - owner.z;
      const distance = Math.hypot(dx, dz);
      const angle = Math.atan2(dx, dz);
      const delta = Math.atan2(
        Math.sin(angle - attack.yaw),
        Math.cos(angle - attack.yaw),
      );
      if (distance > attack.range + arena.playerRadius) continue;
      if (attack.kind === "cone" && Math.abs(delta) > attack.halfAngle)
        continue;
      hitTarget(
        target,
        (item.damage || 0) * (attack.damageScale || 1),
        owner.id,
        item.knockback || 0,
        attack.itemId,
      );
      if (item.slowSeconds) {
        target.slowedTimer = item.slowSeconds;
        target.slowScale = 0.65;
      }
    }
  }

  function hitTarget(
    target,
    damage,
    attackerId,
    knockback = 0,
    label = "BONK!",
  ) {
    if (target.downed || target.respawnTimer > 0 || damage <= 0) return;
    if (target.invulnerabilityTimer > 0) return;
    damage = Math.round(damage * damageMultiplier(states.get(attackerId)));
    knockback *= classPassive(target.player).knockbackTaken ?? 1;
    const dealt = Math.min(target.hp, damage);
    target.hp = Math.max(0, target.hp - damage);
    scoreFor(attackerId).damage += dealt;
    target.stunnedTimer = Math.max(target.stunnedTimer, combat.hitStunSeconds);
    target.healingTimer = 0;
    for (const state of states.values()) {
      if (state.healingRecipientId === target.id) {
        state.healingTimer = 0;
        state.healingRecipientId = null;
      }
      if (state.id === target.id && state.reviveTargetId) {
        state.reviveTargetId = null;
        state.reviveProgress = 0;
      }
      if (state.reviveTargetId === target.id) {
        state.reviveTargetId = null;
        state.reviveProgress = 0;
      }
    }
    if (knockback > 0) {
      const attacker = states.get(attackerId);
      const dx = target.x - (attacker?.x ?? target.x - 1);
      const dz = target.z - (attacker?.z ?? target.z);
      const length = Math.max(0.01, Math.hypot(dx, dz));
      target.vx += (dx / length) * knockback;
      target.vz += (dz / length) * knockback;
    }
    showCombatText(
      target.x,
      target.z,
      target.hp === 0
        ? target.player.team === "cats"
          ? "DOWN!"
          : "DIZZY!"
        : label === "yarn"
          ? "TANGLED!"
          : "BONK!",
      0xffd5a0,
    );
    if (target.hp === 0) {
      if (target.player.team === "cats") {
        target.downed = true;
        target.downedTimer += 1;
      } else {
        scoreFor(attackerId).dogDowns += 1;
        const scale =
          humanTeamCounts.dogs < humanTeamCounts.cats
            ? combat.outnumberedDogRespawnScale
            : 1;
        target.respawnTimer =
          combat.dogRespawnSeconds * scale * (target.isBot ? 1.4 : 1);
        target.vx = 0;
        target.vz = 0;
      }
    }
    updateCombatHud();
  }

  function makeCloud(x, z, team, kind) {
    clouds.push({
      id: `cloud-${nextEntityId++}`,
      x,
      z,
      team,
      kind,
      timeRemaining: combat.items[kind]?.cloudSeconds || 3,
    });
  }

  function showCombatText(x, z, text, color) {
    combatEvents.push({
      id: `event-${nextEntityId++}`,
      x,
      z,
      text,
      color,
      timeRemaining: combat.floatingTextSeconds,
    });
  }

  function removeById(list, id) {
    const index = list.findIndex((entry) => entry.id === id);
    if (index >= 0) list.splice(index, 1);
  }

  function removeExpired(list) {
    for (let index = list.length - 1; index >= 0; index -= 1)
      if (list[index].timeRemaining <= 0) list.splice(index, 1);
  }

  function syncCombatVisuals() {
    for (const pickup of pickups) {
      const visual = pickupVisuals.get(pickup.id);
      if (visual) visual.visible = pickup.active;
    }
    syncEntityVisualMap(
      projectiles,
      projectileVisuals,
      (entity) => {
        const root = new THREE.Group();
        const color =
          entity.kind === "stink" || entity.kind === "cloud"
            ? 0x92a965
            : entity.kind === "yarn"
              ? 0xd87c93
              : 0xf3e1b0;
        addMesh(
          root,
          new THREE.SphereGeometry(0.28, 8, 6),
          makeMaterial(color, { emissive: color, emissiveIntensity: 0.2 }),
          { y: 0.4 },
        );
        scene.add(root);
        return root;
      },
      (visual, entity) => visual.position.set(entity.x, 0, entity.z),
    );
    syncEntityVisualMap(
      telegraphs,
      telegraphVisuals,
      (entity) => {
        if (entity.abilityId) {
          const material = makeMaterial(0xd9554a, {
            transparent: true,
            opacity: 0.42,
            side: THREE.DoubleSide,
          });
          if (entity.kind === "arrow") {
            const group = new THREE.Group();
            addMesh(
              group,
              new THREE.PlaneGeometry(1.3, entity.range),
              material,
              { x: 0, y: 0.12, z: entity.range / 2 },
              null,
              { x: -Math.PI / 2 },
            );
            addMesh(
              group,
              new THREE.ConeGeometry(0.95, 1.2, 3),
              material,
              { x: 0, y: 0.13, z: entity.range + 0.4 },
              null,
              { x: Math.PI / 2 },
            );
            group.position.set(entity.x, 0, entity.z);
            group.rotation.y = entity.yaw;
            scene.add(group);
            group.userData.isGroup = true;
            return group;
          }
          const ring = addMesh(
            scene,
            new THREE.RingGeometry(entity.range * 0.96, entity.range, 40),
            material,
            { x: entity.x, y: 0.12, z: entity.z },
            null,
            { x: -Math.PI / 2 },
          );
          const fill = addMesh(
            ring,
            new THREE.CircleGeometry(entity.range, 40),
            makeMaterial(0xd9554a, {
              transparent: true,
              opacity: 0.2,
              side: THREE.DoubleSide,
            }),
            { x: 0, y: 0, z: 0.001 },
          );
          fill.userData.fill = true;
          return ring;
        }
        const material = makeMaterial(
          entity.kind === "cone" ? 0xe6a55d : 0xffe2a0,
          { transparent: true, opacity: 0.48, side: THREE.DoubleSide },
        );
        const geometry = new THREE.RingGeometry(
          0.25,
          entity.range,
          24,
          1,
          -entity.halfAngle,
          entity.halfAngle * 2,
        );
        const mesh = addMesh(
          scene,
          geometry,
          material,
          { x: entity.x, y: 0.12, z: entity.z },
          null,
          { x: -Math.PI / 2, z: entity.yaw - Math.PI / 2 },
        );
        return mesh;
      },
      (visual, entity) => {
        visual.position.x = entity.x;
        visual.position.z = entity.z;
        if (entity.abilityId) {
          if (entity.kind === "arrow") visual.rotation.y = entity.yaw;
          const urgency = 1 - entity.timeRemaining / (entity.totalTime || 1);
          const pulse = 0.35 + urgency * 0.4;
          visual.traverse?.((child) => {
            if (child.material) child.material.opacity = pulse;
          });
        } else visual.rotation.z = entity.yaw - Math.PI / 2;
      },
    );
    syncEntityVisualMap(
      pulses,
      pulseVisuals,
      (entity) =>
        addMesh(
          scene,
          new THREE.RingGeometry(0.82, 1, 36),
          makeMaterial(entity.color, {
            transparent: true,
            opacity: 0.7,
            side: THREE.DoubleSide,
          }),
          { x: entity.x, y: 0.14, z: entity.z },
          null,
          { x: -Math.PI / 2 },
        ),
      (visual, entity) => {
        const progress = 1 - entity.timeRemaining / entity.totalTime;
        visual.position.x = entity.x;
        visual.position.z = entity.z;
        visual.scale.setScalar(Math.max(0.1, entity.radius * (0.25 + progress * 0.75)));
        visual.material.opacity = 0.7 * (1 - progress);
      },
    );
    syncEntityVisualMap(
      traps,
      trapVisuals,
      (entity) => {
        const root = new THREE.Group();
        addMesh(
          root,
          new THREE.TorusGeometry(0.42, 0.1, 6, 12),
          makeMaterial(0xb88b55),
          { y: 0.12 },
          null,
          { x: Math.PI / 2 },
        );
        scene.add(root);
        return root;
      },
      (visual, entity) => {
        const local = states.get(localPlayerId);
        const hiddenByGust =
          roundFlow.event?.kind === "gust" &&
          roundFlow.event.stage === "active" &&
          local &&
          entity.team !== local.player.team;
        visual.position.set(entity.x, 0, entity.z);
        visual.visible = entity.armed !== false && !hiddenByGust;
      },
    );
    syncEntityVisualMap(
      clouds,
      cloudVisuals,
      (entity) => {
        const color = entity.kind === "stink" ? 0x88a05b : 0xc48db2;
        const mesh = addMesh(
          scene,
          new THREE.CircleGeometry(combat.cloudRadius, 20),
          makeMaterial(color, {
            transparent: true,
            opacity: 0.38,
            side: THREE.DoubleSide,
          }),
          { x: entity.x, y: 0.08, z: entity.z },
          null,
          { x: -Math.PI / 2 },
        );
        return mesh;
      },
      (visual, entity) => {
        visual.position.x = entity.x;
        visual.position.z = entity.z;
        visual.material.opacity =
          0.38 * clamp(entity.timeRemaining / 1.2, 0.2, 1);
      },
    );
    syncEntityVisualMap(
      combatEvents,
      combatEventVisuals,
      (entity) => {
        const sprite = makeLabelSprite(
          entity.text,
          `#${Number(entity.color).toString(16).padStart(6, "0")}`,
          "#493a2e",
        );
        sprite.scale.set(2.4, 0.65, 1);
        scene.add(sprite);
        return sprite;
      },
      (visual, entity) => {
        visual.position.set(
          entity.x,
          1.8 + (combat.floatingTextSeconds - entity.timeRemaining) * 1.2,
          entity.z,
        );
        visual.material.opacity = clamp(
          entity.timeRemaining / combat.floatingTextSeconds,
          0,
          1,
        );
      },
    );
  }

  function syncEntityVisualMap(entities, visualMap, create, update) {
    const activeIds = new Set(entities.map((entity) => entity.id));
    for (const [id, visual] of visualMap)
      if (!activeIds.has(id)) {
        scene.remove(visual);
        visual.geometry?.dispose();
        visual.material?.dispose();
        visualMap.delete(id);
      }
    for (const entity of entities) {
      let visual = visualMap.get(entity.id);
      if (!visual) {
        visual = create(entity);
        visualMap.set(entity.id, visual);
      }
      update(visual, entity);
    }
  }

  // ---- Event visuals, edge markers and ability HUD ----
  function ensureEventVisuals() {
    if (eventVisuals.group) return;
    const group = new THREE.Group();
    scene.add(group);
    eventVisuals.group = group;
    for (const spot of eventConfig.sprinklers.positions) {
      const post = new THREE.Group();
      post.position.set(spot.x, 0, spot.z);
      addMesh(post, new THREE.CylinderGeometry(0.1, 0.12, 0.5, 6), makeMaterial(0x6f8a92), { y: 0.25 });
      addMesh(post, new THREE.SphereGeometry(0.2, 6, 5), makeMaterial(0xb9d4dc), { y: 0.55 });
      scene.add(post);
      const disc = addMesh(
        scene,
        new THREE.CircleGeometry(eventConfig.sprinklers.radius, 28),
        makeMaterial(0x7fc2e0, { transparent: true, opacity: 0, side: THREE.DoubleSide }),
        { x: spot.x, y: 0.09, z: spot.z },
        null,
        { x: -Math.PI / 2 },
      );
      disc.visible = false;
      eventVisuals.discs.push(disc);
    }
    const ball = new THREE.Group();
    addMesh(ball, new THREE.SphereGeometry(eventConfig.ball.radius, 14, 10), makeMaterial(0xd9696a), { y: eventConfig.ball.radius });
    addMesh(ball, new THREE.TorusGeometry(eventConfig.ball.radius * 0.98, 0.14, 5, 18), makeMaterial(0xf3e3b5), { y: eventConfig.ball.radius }, null, { y: Math.PI / 2 });
    ball.visible = false;
    scene.add(ball);
    eventVisuals.ball = ball;
    const lane = addMesh(
      scene,
      new THREE.PlaneGeometry(arena.width, eventConfig.ball.laneHalfWidth * 2),
      makeMaterial(0xd9554a, { transparent: true, opacity: 0.25, side: THREE.DoubleSide }),
      { x: 0, y: 0.1, z: 0 },
      null,
      { x: -Math.PI / 2 },
    );
    lane.visible = false;
    eventVisuals.lane = lane;
    for (let index = 0; index < 22; index += 1) {
      const leaf = addMesh(
        group,
        new THREE.BoxGeometry(0.34, 0.03, 0.2),
        makeMaterial(index % 2 ? 0xc99b45 : 0x8a9a4e),
        { x: 0, y: 1, z: 0 },
      );
      leaf.visible = false;
      leaf.userData.seed = Math.random() * 100;
      eventVisuals.leaves.push(leaf);
    }
  }

  function syncEventVisuals(dt) {
    ensureEventVisuals();
    const event = roundFlow.event;
    const active = event?.stage === "active";
    const warning = event?.stage === "warning";
    eventVisuals.discs.forEach((disc) => {
      const show = event?.kind === "sprinklers";
      disc.visible = show;
      if (show) {
        disc.material.opacity = active
          ? 0.28 + Math.sin(elapsed * 14) * 0.05
          : 0.1 + Math.abs(Math.sin(elapsed * 6)) * 0.12;
      }
    });
    const showBall = event?.kind === "ball";
    eventVisuals.lane.visible = showBall;
    eventVisuals.ball.visible = showBall && active;
    if (showBall) {
      eventVisuals.lane.position.z = event.laneZ;
      eventVisuals.lane.material.opacity = warning
        ? 0.15 + Math.abs(Math.sin(elapsed * 9)) * 0.25
        : 0.12;
      eventVisuals.ball.position.set(event.x, 0, event.laneZ);
      eventVisuals.ball.rotation.z = -event.x * 0.9 * (event.dir || 1);
    }
    const gust = event?.kind === "gust" && event.stage !== "warning";
    eventVisuals.leaves.forEach((leaf, index) => {
      leaf.visible = gust;
      if (!gust) return;
      const t = elapsed * 5 + leaf.userData.seed;
      const camX = camera.position.x;
      const camZ = camera.position.z - config.trailingDistance;
      leaf.position.set(
        camX - 20 + ((t * 4 + index * 1.9) % 40),
        0.7 + Math.abs(Math.sin(t * 1.3)) * 2.2,
        camZ + Math.sin(index * 2.1) * 12 + Math.cos(t) * 1.4,
      );
      leaf.rotation.set(t, t * 1.7, t * 0.6);
    });
    if (binRoot) {
      const tipping = event?.kind === "bin";
      const target = tipping && event.stage === "active" ? 1.35 : 0;
      const wobble = tipping && warning ? Math.sin(elapsed * 30) * 0.08 : 0;
      binRoot.rotation.z = damp(binRoot.rotation.z, target + wobble, 9, dt);
      binRoot.position.y = target ? 0.35 : 0;
    }
    const key = `${event?.kind || ""}:${event?.stage || ""}`;
    if (key !== lastEventKey) {
      lastEventKey = key;
      const banner = document.querySelector("#event-banner");
      if (banner) {
        const text = event
          ? {
              sprinklers: "SPRINKLERS! Stay out of the wet zones.",
              ball: "RUNAWAY BALL! Clear the red lane.",
              bin: "TRASH CAN TIPPED! Free snacks and gear.",
              gust: "LEAF GUST! Traps are hidden.",
            }[event.kind]
          : "";
        banner.textContent = text;
        banner.classList.toggle("show", Boolean(text));
      }
    }
  }

  // Off-screen teammate arrows plus revealed cats (Hound howl).
  const edgeMarkers = new Map();
  const markerVector = new THREE.Vector3();

  function updateEdgeMarkers() {
    const host = document.querySelector("#edge-markers");
    if (!host) return;
    const local = states.get(localPlayerId);
    if (!local) return;
    const wanted = new Map();
    for (const other of states.values()) {
      if (other.id === local.id || other.escaped) continue;
      const sameTeam = other.player.team === local.player.team;
      const revealed =
        !sameTeam && local.player.team === "dogs" && local.revealTimer > 0;
      if (!sameTeam && !revealed) continue;
      if (other.respawnTimer > 0) continue;
      wanted.set(other.id, { other, revealed });
    }
    for (const [id, marker] of edgeMarkers) {
      if (!wanted.has(id)) {
        marker.remove();
        edgeMarkers.delete(id);
      }
    }
    const rect = host.getBoundingClientRect();
    for (const [id, { other, revealed }] of wanted) {
      let marker = edgeMarkers.get(id);
      if (!marker) {
        marker = document.createElement("div");
        marker.className = "edge-marker";
        marker.innerHTML = "<i>▲</i><span></span>";
        host.appendChild(marker);
        edgeMarkers.set(id, marker);
      }
      markerVector.set(other.x, 0.8, other.z).project(camera);
      const onScreen =
        Math.abs(markerVector.x) < 0.92 &&
        Math.abs(markerVector.y) < 0.9 &&
        markerVector.z < 1;
      marker.hidden = onScreen;
      if (onScreen) continue;
      let dx = markerVector.x;
      let dy = markerVector.y;
      if (markerVector.z > 1) {
        dx = -dx;
        dy = -dy;
      }
      const scale = 0.88 / Math.max(Math.abs(dx), Math.abs(dy), 0.0001);
      const px = (dx * scale * 0.5 + 0.5) * rect.width;
      const py = (-dy * scale * 0.5 + 0.5) * rect.height;
      marker.style.transform = `translate(${px}px, ${py}px)`;
      marker.firstChild.style.transform = `rotate(${Math.atan2(dx, dy)}rad)`;
      marker.classList.toggle("is-enemy", revealed);
      marker.classList.toggle("is-downed", other.downed);
      marker.lastChild.textContent = other.player.name.slice(0, 3).toUpperCase();
    }
  }

  function updateAbilityHud() {
    const local = states.get(localPlayerId);
    if (!local) return;
    const ability = classAbility(local.player);
    const button = document.querySelector("#arena-ability");
    if (button && ability) {
      const max = Math.max(0.01, local.abilityCooldownMax || ability.cooldown);
      const fraction = clamp(local.abilityCooldown / max, 0, 1);
      button.style.setProperty("--cooldown", `${fraction * 360}deg`);
      button.classList.toggle("is-ready", local.abilityCooldown <= 0);
      const name = button.querySelector(".ability-name");
      if (name) name.textContent = ability.name;
      const sub = button.querySelector(".ability-cooldown");
      if (sub)
        sub.textContent =
          local.abilityCooldown > 0
            ? `${local.abilityCooldown.toFixed(1)}s`
            : "READY";
    }
    const channel = document.querySelector("#arena-channel");
    if (channel) {
      const total = local.healingTotal || combat.items.treat.channelSeconds;
      const show = local.healingTimer > 0;
      channel.hidden = !show;
      if (show) {
        const fill = channel.querySelector("i");
        if (fill)
          fill.style.width = `${clamp(1 - local.healingTimer / total, 0, 1) * 100}%`;
      }
    }
    const passive = document.querySelector("#arena-passive");
    if (passive) passive.textContent = describePassive(local.player.className);
  }

  function describePassive(className) {
    return (
      {
        "Scaredy Cat": "Passive: +15% speed below half HP",
        "Cool Cat": "Passive: +15% damage at full HP",
        Chonk: "Passive: +30% max HP, a little slower",
        "Sneaky Cat": "Passive: dogs only notice you up close",
        Terrier: "Passive: quick, tight turns and a small frame",
        Bulldog: "Passive: sturdy and hard to knock back",
        Hound: "Passive: nearby dogs run faster",
        "Great Dane": "Passive: huge bite reach, slow feet",
      }[className] || ""
    );
  }

  function updateCombatHud() {
    const state = states.get(localPlayerId);
    if (!state) return;
    const fill = document.querySelector(".arena-health-fill");
    if (fill)
      fill.style.width = `${clamp(state.hp / Math.max(1, state.maxHp), 0, 1) * 100}%`;
    const label = document.querySelector(".arena-health-label");
    if (label)
      label.textContent =
        state.respawnTimer > 0
          ? `RESPAWNING ${state.respawnTimer.toFixed(1)}s`
          : state.downed
            ? "DOWNED · HOLD FOR A REVIVE"
            : `${Math.ceil(state.hp)} / ${state.maxHp} HP`;
    document.querySelectorAll(".arena-slot").forEach((element, index) => {
      const stack = state.items[index];
      const item = stack ? combat.items[stack.itemId] : null;
      const title = element.querySelector(".slot-name");
      const charge = element.querySelector(".slot-charge");
      if (title) title.textContent = item?.name || "Empty slot";
      if (charge)
        charge.textContent = stack
          ? stack.charges < 0
            ? "∞"
            : `${stack.charges} uses`
          : "Pick up an item";
      element.classList.toggle("active", state.selectedSlot === index);
    });
  }

  function scoreFor(playerId) {
    if (!roundFlow.roundScores[playerId])
      roundFlow.roundScores[playerId] = createScoreRecord();
    return roundFlow.roundScores[playerId];
  }

  function startFenceDrop() {
    roundFlow.phase = "fence-drop";
    roundFlow.phaseTimeRemaining = roundConfig.fenceDropSeconds;
    roundFlow.fenceDropProgress = 0;
    innerFenceRoot.rotation.z = 0;
    addFenceDust();
    showCombatText(arena.catFenceX, 0, "TIMBER!", 0xffe4a1);
    syncRoundVisuals();
  }

  function addFenceDust() {
    for (const opening of arena.fenceOpenings) {
      const puff = addMesh(
        scene,
        new THREE.SphereGeometry(0.38, 7, 5),
        makeMaterial(0xd5b88f, { transparent: true, opacity: 0.52 }),
        { x: arena.catFenceX, y: 0.22, z: opening.z },
        { x: 1.4, y: 0.7, z: 1 },
      );
      puff.userData.life = roundConfig.fenceImpactShakeSeconds;
      fenceDust.push(puff);
    }
  }

  function startRescueDash(edgeOverride, difficultyOverride) {
    roundFlow.phase = "dash";
    roundFlow.vanEdge = Number.isInteger(edgeOverride)
      ? edgeOverride
      : Math.floor(Math.random() * arena.vanMarkers.length);
    const marker = arena.vanMarkers[roundFlow.vanEdge];
    const catStates = [...states.values()].filter(
      (state) => state.player.team === "cats" && !state.downed,
    );
    const slowestTravel = catStates.reduce((longest, state) => {
      const speedScale = classPassive(state.player).speedScale || 1;
      const path = findPath(state.x, state.z, marker.x, marker.z, "cats");
      const distance = path
        ? pathLength(path, state.x, state.z)
        : Math.hypot(marker.x - state.x, marker.z - state.z);
      return Math.max(longest, distance / (movement.catSpeed * speedScale));
    }, 0);
    const ratio = roundConfig.dashSlackRatio[difficultyOverride || difficulty];
    const rawTimer = slowestTravel / ratio;
    roundFlow.phaseTimeRemaining = clamp(
      rawTimer,
      roundConfig.dashMinimumSeconds,
      roundConfig.dashMaximumSeconds,
    );
    roundFlow.dashRouteRatio = slowestTravel / roundFlow.phaseTimeRemaining;
    roundFlow.escapedPlayerIds = [];
    vanArrivalRemaining = roundConfig.vanArrivalSeconds;
    carrierDoorProgress = 0;
    roundFlow.vanArrivalRemaining = vanArrivalRemaining;
    roundFlow.carrierDoorProgress = 0;
    pickups.forEach((pickup) => (pickup.active = true));
    showCombatText(marker.x, marker.z, "THE VAN!", 0xffedaa);
    syncRoundVisuals();
  }

  function finishRound(winner) {
    if (roundFlow.phase === "results") return;
    roundFlow.phase = "results";
    roundFlow.phaseTimeRemaining = 0;
    roundFlow.winner = winner;
    const catCount = players.filter((player) => player.team === "cats").length;
    const escapedCount = roundFlow.escapedPlayerIds.length;
    const catStars =
      escapedCount === 0
        ? 0
        : escapedCount === catCount
          ? 3
          : escapedCount >= Math.ceil(catCount / 2)
            ? 2
            : 1;
    const weights = roundConfig.scoreWeights;
    const rows = humanPlayers.map((player) => {
      const stats = scoreFor(player.id);
      if (player.team === "dogs") {
        stats.points = Math.round(
          stats.damage * weights.damagePerPoint +
            stats.dogDowns * weights.dogDown +
            stats.trapsTriggered * weights.trapTriggered +
            stats.chaseSeconds * weights.chaseSecond +
            (catCount - escapedCount) * weights.catNotEscaped,
        );
      } else {
        stats.points = Math.round(
          stats.damage * weights.damagePerPoint +
            stats.revives * weights.revive +
            stats.treatsShared * weights.treatShared +
            stats.dashDistance * weights.dashDistance +
            stats.escapes * weights.catEscape,
        );
        roundFlow.catSidePoints[player.id] =
          (roundFlow.catSidePoints[player.id] || 0) + stats.points;
      }
      roundFlow.matchScores[player.id] =
        (roundFlow.matchScores[player.id] || 0) + stats.points;
      return {
        id: player.id,
        name: player.name,
        team: player.team,
        points: stats.points,
        stats: { ...stats },
      };
    });
    const topBy = (key) =>
      [...rows].sort((a, b) => b.stats[key] - a.stats[key])[0];
    const awards = [
      { name: "MVP", player: [...rows].sort((a, b) => b.points - a.points)[0] },
      { name: "Best Nurse", player: topBy("revives") },
      { name: "Most Likely to Run Away", player: topBy("dashDistance") },
      { name: "Best Trapper", player: topBy("trapsTriggered") },
    ].filter(
      (award) =>
        award.player &&
        (award.name === "MVP" ||
          (award.name === "Best Nurse" && award.player.stats.revives > 0) ||
          (award.name === "Most Likely to Run Away" &&
            award.player.stats.dashDistance > 0.1) ||
          (award.name === "Best Trapper" &&
            award.player.stats.trapsTriggered > 0)),
    );
    roundFlow.results = {
      winner,
      escapedCount,
      catCount,
      catStars,
      dogStars: 3 - catStars,
      leftBehindNames: players
        .filter(
          (player) =>
            player.team === "cats" &&
            !roundFlow.escapedPlayerIds.includes(player.id),
        )
        .map((player) => player.name),
      rows,
      awards,
      finalMatch: roundFlow.roundNumber >= Number(room.settings?.rounds || 1),
    };
    showCombatText(
      0,
      0,
      winner === "cats" ? "CATS ESCAPED!" : "DOGS WIN!",
      0xffe4a1,
    );
    syncRoundVisuals();
  }

  // ---- Chaos events (host-simulated, replicated through roundFlow.event) ----
  function randomBetween([min, max]) {
    return min + Math.random() * (max - min);
  }

  function scheduleNextEvent(first) {
    const table = first ? eventConfig.firstDelaySeconds : eventConfig.intervalSeconds;
    roundFlow.nextEventIn = randomBetween(table[difficulty] || table.normal);
  }

  function startRandomEvent(forcedKind) {
    const options = eventConfig.kinds.filter(
      (kind) => kind !== roundFlow.lastEventKind,
    );
    const kind =
      forcedKind || options[Math.floor(Math.random() * options.length)];
    roundFlow.lastEventKind = kind;
    const warning = eventConfig.warningSeconds;
    const event = {
      kind,
      stage: "warning",
      timeRemaining: warning,
      totalTime: warning,
      hitIds: [],
    };
    if (kind === "ball") {
      const direction = Math.random() < 0.5 ? 1 : -1;
      const halfWidth = arena.width / 2;
      event.dir = direction;
      event.laneZ = (Math.random() - 0.5) * 22;
      event.x = -direction * (halfWidth + 2);
    }
    roundFlow.event = event;
    const text = {
      sprinklers: "SPRINKLERS INCOMING!",
      ball: "RUNAWAY BALL!",
      bin: "THE TRASH CAN IS WOBBLING!",
      gust: "A GUST IS COMING!",
    }[kind];
    showCombatText(0, 0, text, 0xffe4a1);
  }

  function activateEvent(event) {
    event.stage = "active";
    if (event.kind === "sprinklers") {
      event.timeRemaining = eventConfig.sprinklers.seconds;
      event.totalTime = event.timeRemaining;
    } else if (event.kind === "gust") {
      event.timeRemaining = eventConfig.gust.seconds;
      event.totalTime = event.timeRemaining;
    } else if (event.kind === "bin") {
      event.timeRemaining = 1.4;
      event.totalTime = 1.4;
      const bin = eventConfig.bin;
      const pool = [...bin.spillItems].sort(() => Math.random() - 0.5);
      for (let index = 0; index < bin.count; index += 1) {
        const choice = pool[index % pool.length];
        const angle = (index / bin.count) * Math.PI * 2 + 0.5;
        pickups.push({
          id: `spill-${nextEntityId++}`,
          item: choice.item,
          team: choice.team,
          x: clamp(bin.x + Math.cos(angle) * 2.1, -26, 26),
          z: clamp(bin.z - 1.2 + Math.sin(angle) * 1.6, -17, 17),
          active: true,
          dynamic: true,
        });
      }
      addPulse(bin.x, bin.z, 3, 0xd2d2c4, 0.6);
      showCombatText(bin.x, bin.z, "CRASH!", 0xffe4a1);
    } else if (event.kind === "ball") {
      const speed = eventConfig.ball.speed;
      event.timeRemaining = (arena.width + 6) / speed;
      event.totalTime = event.timeRemaining;
    }
  }

  function tickEvents(dt) {
    if (roundFlow.phase !== "hunt") {
      roundFlow.event = null;
      return;
    }
    const event = roundFlow.event;
    if (!event) {
      if (roundFlow.phaseTimeRemaining < 9) return;
      roundFlow.nextEventIn -= dt;
      if (roundFlow.nextEventIn <= 0) startRandomEvent();
      return;
    }
    event.timeRemaining -= dt;
    if (event.stage === "warning") {
      if (event.timeRemaining <= 0) activateEvent(event);
      return;
    }
    if (event.kind === "sprinklers") {
      for (const target of states.values()) {
        if (target.downed || target.respawnTimer > 0) continue;
        const wet = eventConfig.sprinklers.positions.some(
          (spot) =>
            Math.hypot(target.x - spot.x, target.z - spot.z) <=
            eventConfig.sprinklers.radius,
        );
        if (!wet) continue;
        target.slowedTimer = Math.max(target.slowedTimer, combat.statusRefreshSeconds);
        target.slowScale = Math.min(
          target.slowScale && target.slowedTimer > 0 ? target.slowScale : 1,
          eventConfig.sprinklers.slowScale,
        );
        if (!event.hitIds.includes(target.id)) {
          event.hitIds.push(target.id);
          showCombatText(target.x, target.z, "SOAKED!", 0xbfe3f2);
        }
      }
    } else if (event.kind === "ball") {
      event.x += event.dir * eventConfig.ball.speed * dt;
      for (const target of states.values()) {
        if (target.downed || target.respawnTimer > 0 || target.escaped) continue;
        if (event.hitIds.includes(target.id)) continue;
        if (
          Math.hypot(target.x - event.x, target.z - event.laneZ) >
          eventConfig.ball.radius + arena.playerRadius
        )
          continue;
        event.hitIds.push(target.id);
        target.vx += event.dir * eventConfig.ball.knockback;
        target.vz += (target.z >= event.laneZ ? 1 : -1) * 4;
        target.stunnedTimer = Math.max(target.stunnedTimer, eventConfig.ball.stunSeconds);
        target.healingTimer = 0;
        showCombatText(target.x, target.z, "BOWLED OVER!", 0xffd5a0);
      }
    }
    if (event.timeRemaining <= 0) {
      roundFlow.event = null;
      scheduleNextEvent(false);
    }
  }

  function tickRoundFlow(dt) {
    if (roundFlow.phase === "results") return;
    if (roundFlow.phase === "dash") {
      vanArrivalRemaining = Math.max(0, vanArrivalRemaining - dt);
      roundFlow.vanArrivalRemaining = vanArrivalRemaining;
      if (vanArrivalRemaining === 0) {
        roundFlow.phaseTimeRemaining = Math.max(
          0,
          roundFlow.phaseTimeRemaining - dt,
        );
        carrierDoorProgress = Math.min(
          1,
          carrierDoorProgress + dt / roundConfig.carrierDoorSeconds,
        );
      }
      roundFlow.carrierDoorProgress = carrierDoorProgress;
      const marker = arena.vanMarkers[roundFlow.vanEdge];
      for (const state of states.values()) {
        if (state.player.team === "cats" && !state.downed && !state.escaped) {
          scoreFor(state.id).dashDistance += Math.hypot(
            state.x - state.previousX,
            state.z - state.previousZ,
          );
          if (
            vanArrivalRemaining === 0 &&
            Math.hypot(state.x - marker.x, state.z - marker.z) <=
              roundConfig.catCarrierRadius
          ) {
            state.escaped = true;
            roundFlow.escapedPlayerIds.push(state.id);
            scoreFor(state.id).escapes += 1;
            showCombatText(state.x, state.z, "SAFE!", 0xffefbd);
          }
        }
      }
      if (
        roundFlow.escapedPlayerIds.length ===
        players.filter((player) => player.team === "cats").length
      ) {
        finishRound("cats");
        return;
      }
      const catsStillOut = players.filter(
        (player) =>
          player.team === "cats" &&
          !roundFlow.escapedPlayerIds.includes(player.id),
      );
      if (catsStillOut.every((player) => states.get(player.id)?.downed)) {
        finishRound(roundFlow.escapedPlayerIds.length ? "cats" : "dogs");
        return;
      }
      if (roundFlow.phaseTimeRemaining === 0) {
        finishRound(roundFlow.escapedPlayerIds.length ? "cats" : "dogs");
        return;
      }
    } else {
      roundFlow.phaseTimeRemaining = Math.max(
        0,
        roundFlow.phaseTimeRemaining - dt,
      );
      if (roundFlow.phase === "fence-drop") {
        roundFlow.fenceDropProgress = clamp(
          1 - roundFlow.phaseTimeRemaining / roundConfig.fenceDropSeconds,
          0,
          1,
        );
      }
      if (roundFlow.phase === "hunt") {
        tickEvents(dt);
        for (const dog of states.values()) {
          if (dog.player.team !== "dogs" || dog.respawnTimer > 0) continue;
          const nearbyCat = [...states.values()].some(
            (cat) =>
              cat.player.team === "cats" &&
              !cat.downed &&
              Math.hypot(cat.x - dog.x, cat.z - dog.z) <=
                roundConfig.combatChaseRange,
          );
          if (nearbyCat) scoreFor(dog.id).chaseSeconds += dt;
        }
        const allCatsDown = players
          .filter((player) => player.team === "cats")
          .every((player) => states.get(player.id)?.downed);
        if (allCatsDown) {
          finishRound("dogs");
          return;
        }
      }
      if (roundFlow.phaseTimeRemaining === 0) {
        if (roundFlow.phase === "scavenge") startFenceDrop();
        else if (roundFlow.phase === "fence-drop") {
          roundFlow.fenceDropped = true;
          roundFlow.phase = "hunt";
          roundFlow.phaseTimeRemaining = roundConfig.huntSeconds[difficulty];
          scheduleNextEvent(true);
          pickups.forEach((pickup) => (pickup.active = true));
          syncRoundVisuals();
        } else if (roundFlow.phase === "hunt") startRescueDash();
      }
    }
  }

  function syncRoundVisuals() {
    let dropProgress = roundFlow.fenceDropped ? 1 : 0;
    if (roundFlow.phase === "fence-drop") {
      dropProgress = clamp(
        1 - roundFlow.phaseTimeRemaining / roundConfig.fenceDropSeconds,
        0,
        1,
      );
    }
    const overshoot =
      1 + 0.22 * Math.sin(dropProgress * Math.PI) * (1 - dropProgress);
    innerFenceRoot.rotation.z =
      dropProgress * overshoot * roundConfig.fenceFallAngle;
    if (roundFlow.phase === "dash") {
      visuals.forEach((root, key) => {
        if (!key.startsWith("van-")) return;
        const index = Number(key.slice(4));
        root.visible = index === roundFlow.vanEdge;
        root.userData.van.visible = index === roundFlow.vanEdge;
        const arrival = clamp(
          roundFlow.vanArrivalRemaining / roundConfig.vanArrivalSeconds,
          0,
          1,
        );
        root.userData.van.position.x = arrival * arrival * roundConfig.vanArrivalOffset;
        root.userData.van.userData.door.rotation.z =
          -roundFlow.carrierDoorProgress * (Math.PI / 2);
        root.userData.exclusion.visible = index === roundFlow.vanEdge;
        root.scale.setScalar(
          1 + Math.sin(elapsed * roundConfig.dashArrowPulseSpeed) * 0.025,
        );
      });
    } else {
      visuals.forEach((root, key) => {
        if (!key.startsWith("van-")) return;
        root.visible = false;
      });
    }
    if (roundFlow.phase !== lastFlowBannerPhase) {
      lastFlowBannerPhase = roundFlow.phase;
      flowBannerRemaining = 2.2;
      if (roundFlow.phase === "fence-drop")
        cameraShakeRemaining = roundConfig.fenceImpactShakeSeconds;
      const banner = document.querySelector("#phase-banner");
      if (banner) {
        banner.textContent =
          {
            scavenge: "SCAVENGE! GEAR UP!",
            "fence-drop": "THE FENCE IS COMING DOWN!",
            hunt: "HUNT! GUARD YOUR WHISKERS!",
            dash: "THE VAN IS HERE! RUN!",
            results: "ROUND OVER!",
          }[roundFlow.phase] || "";
        banner.classList.remove("show");
        requestAnimationFrame(() => banner.classList.add("show"));
      }
    }
    updateRoundHud();
  }

  function updateRoundHud() {
    const phaseName = document.querySelector("#phase-name");
    const timer = document.querySelector("#phase-timer");
    const objective = document.querySelector("#phase-objective");
    const resultPanel = document.querySelector("#phase-results");
    const vanArrow = document.querySelector("#van-arrow");
    const local = states.get(localPlayerId);
    if (!phaseName || !timer || !objective || !resultPanel || !local) return;
    const labels = {
      scavenge: "SCAVENGE",
      "fence-drop": "FENCE DROP",
      hunt: "HUNT",
      dash: "RESCUE DASH",
      results: "RESULTS",
    };
    phaseName.textContent = `ROUND ${roundFlow.roundNumber} · ${labels[roundFlow.phase]}`;
    const remaining = Math.ceil(roundFlow.phaseTimeRemaining);
    timer.textContent =
      roundFlow.phase === "results"
        ? roundFlow.results?.finalMatch
          ? "MATCH COMPLETE"
          : "ROUND COMPLETE"
        : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
    const marker = arena.vanMarkers[roundFlow.vanEdge];
    const objectiveCopy =
      roundFlow.phase === "scavenge"
        ? local.player.team === "cats"
          ? "Gather gear and treats before the fence drops."
          : "Stock up and set traps along your side of the fence."
        : roundFlow.phase === "fence-drop"
          ? "The yard is opening. Get ready!"
          : roundFlow.phase === "hunt"
            ? local.player.team === "cats"
              ? "Survive the hunt. Revive your teammates."
              : "Down every cat before the van arrives."
            : roundFlow.phase === "dash"
              ? local.player.team === "cats"
                ? `Reach the van at ${marker?.label || "the marked exit"}!`
                : "Stop the escapees. The carrier zone is protected."
              : roundFlow.results?.winner === "cats"
                ? "The cats made it out!"
                : "The dogs stopped the escape.";
    objective.textContent = objectiveCopy;
    const showVanArrow =
      roundFlow.phase === "dash" && local.player.team === "cats" && marker;
    if (vanArrow) {
      vanArrow.hidden = !showVanArrow;
      if (showVanArrow) {
        const angle = Math.atan2(marker.x - local.x, -(marker.z - local.z));
        vanArrow.style.setProperty("--arrow-angle", `${angle}rad`);
      }
    }
    const showResults = roundFlow.phase === "results" && roundFlow.results;
    resultPanel.hidden = !showResults;
    if (showResults) renderResultsPanel(resultPanel, roundFlow.results);
  }

  function renderResultsPanel(panel, result) {
    const final = result.finalMatch;
    const scoreRows = result.rows
      .map((row) => ({
        ...row,
        total: final ? roundFlow.matchScores[row.id] || 0 : row.points,
      }))
      .sort((a, b) => b.total - a.total);
    const awards = result.awards
      .map(
        (award) =>
          `<span><b>${escapeHtml(award.name)}</b> ${escapeHtml(award.player.name)}</span>`,
      )
      .join("");
    const leaderboard = scoreRows
      .map(
        (row) =>
          `<li><span>${escapeHtml(row.name)} <small>${row.team.toUpperCase()}</small></span><b>${row.total}</b></li>`,
      )
      .join("");
    const showButton = isHost;
    const action = final ? "return-lobby" : "next-round";
    const buttonLabel = final ? "Play again" : "Swap sides · Round 2";
    const leftBehind = result.leftBehindNames?.length
      ? `<p class="left-behind">Left behind: ${result.leftBehindNames.map(escapeHtml).join(", ")} 💤</p>`
      : "";
    const html = `<section class="results-card"><p class="eyebrow">${final ? "FINAL MATCH STANDINGS" : `ROUND ${roundFlow.roundNumber} COMPLETE`}</p><h2>${result.winner === "cats" ? "Cats escaped!" : "Dogs win!"}</h2><p class="result-stars">Cats ${"★".repeat(result.catStars)}${"☆".repeat(3 - result.catStars)} <i>·</i> Dogs ${"★".repeat(result.dogStars)}${"☆".repeat(3 - result.dogStars)}</p>${leftBehind}<div class="result-awards">${awards}</div><ol class="result-leaderboard">${leaderboard}</ol>${showButton ? `<button class="button button-primary" data-round-action="${action}">${buttonLabel} <span>↗</span></button>` : `<p class="waiting-copy">Waiting for the host…</p>`}</section>`;
    if (panel.dataset.renderedHtml === html) return;
    panel.dataset.renderedHtml = html;
    panel.innerHTML = html;
    panel
      .querySelector("[data-round-action]")
      ?.addEventListener("click", () => {
        requestAction({ type: action });
      });
  }

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  }

  function requestAction(action) {
    if (isHost) performAction(localPlayerId, action);
    else onAction?.(action);
  }

  function applySnapshot(snapshot) {
    if (!snapshot?.players || isHost) return lastPredictionError;
    if (snapshot.roundFlow) {
      Object.assign(roundFlow, structuredClone(snapshot.roundFlow));
      syncRoundVisuals();
    }
    for (const remote of snapshot.players) {
      const state = states.get(remote.id);
      if (!state) continue;
      if (remote.id === localPlayerId) {
        const oldPosition = { x: state.x, z: state.z };
        const acknowledged = Number(remote.lastProcessedInputSequence) || 0;
        lastSnapshotInputSequence = Math.max(
          lastSnapshotInputSequence,
          acknowledged,
        );
        while (
          pendingInputs.length &&
          pendingInputs[0].sequence <= lastSnapshotInputSequence
        ) {
          pendingInputs.shift();
        }

        restoreAuthoritativeState(state, remote);
        for (const pending of pendingInputs) {
          stepPlayer(state, pending.input, movement.fixedStep);
        }

        const correctedPosition = { x: state.x, z: state.z };
        const errorX = correctedPosition.x - oldPosition.x;
        const errorZ = correctedPosition.z - oldPosition.z;
        lastPredictionError = Math.hypot(errorX, errorZ);
        if (lastPredictionError > movement.reconciliationSnapDistance) {
          state.x = correctedPosition.x;
          state.z = correctedPosition.z;
        } else {
          const inputLength = Math.hypot(
            currentLocalInput.x,
            currentLocalInput.z,
          );
          let blendX = errorX;
          let blendZ = errorZ;
          if (inputLength > movement.reconciliationMovementThreshold) {
            const moveX = currentLocalInput.x / inputLength;
            const moveZ = currentLocalInput.z / inputLength;
            const alongMovement = blendX * moveX + blendZ * moveZ;
            if (alongMovement < 0) {
              blendX -= alongMovement * moveX;
              blendZ -= alongMovement * moveZ;
            }
          }
          state.x = oldPosition.x + blendX * movement.reconciliationBlend;
          state.z = oldPosition.z + blendZ * movement.reconciliationBlend;
        }
        state.previousX = state.x;
        state.previousZ = state.z;
        state.previousYaw = state.yaw;
        onDebug?.({ predictionError: lastPredictionError });
      } else {
        state.target = { x: remote.x, z: remote.z, yaw: remote.yaw };
        state.remoteDashing = Boolean(remote.dashing);
        restoreCombatState(state, remote);
      }
    }
    for (const remotePickup of snapshot.pickups || []) {
      const pickup = pickups.find((entry) => entry.id === remotePickup.id);
      if (pickup) pickup.active = remotePickup.active;
      else if (remotePickup.dynamic) {
        const created = { ...remotePickup };
        pickups.push(created);
        createPickupVisual(created);
      }
    }
    for (let index = pickups.length - 1; index >= 0; index -= 1) {
      const pickup = pickups[index];
      if (
        pickup.dynamic &&
        !(snapshot.pickups || []).some((entry) => entry.id === pickup.id)
      ) {
        const visual = pickupVisuals.get(pickup.id);
        if (visual) scene.remove(visual);
        pickupVisuals.delete(pickup.id);
        pickups.splice(index, 1);
      }
    }
    replaceEntities(projectiles, snapshot.projectiles);
    replaceEntities(telegraphs, snapshot.telegraphs);
    replaceEntities(traps, snapshot.traps);
    replaceEntities(clouds, snapshot.clouds);
    replaceEntities(pulses, snapshot.pulses);
    replaceEntities(combatEvents, snapshot.combatEvents);
    syncCombatVisuals();
    updateCombatHud();
    return lastPredictionError;
  }

  function replaceEntities(target, source = []) {
    target.splice(0, target.length, ...source.map((entity) => ({ ...entity })));
  }

  function restoreAuthoritativeState(state, remote) {
    state.x = remote.x;
    state.z = remote.z;
    state.yaw = remote.yaw;
    state.vx = Number(remote.vx) || 0;
    state.vz = Number(remote.vz) || 0;
    state.dashTimer = Number(remote.dashTimer) || 0;
    state.dashCooldown = Number(remote.dashCooldown) || 0;
    state.dashX = Number(remote.dashX) || 0;
    state.dashZ = Number(remote.dashZ) || 0;
    state.lastDashHeld = Boolean(remote.lastDashHeld);
    state.lastProcessedInputSequence =
      Number(remote.lastProcessedInputSequence) || 0;
    restoreCombatState(state, remote);
  }

  function restoreCombatState(state, remote) {
    state.hp = Number.isFinite(remote.hp) ? remote.hp : state.hp;
    state.maxHp = Number.isFinite(remote.maxHp) ? remote.maxHp : state.maxHp;
    state.downed = Boolean(remote.downed);
    state.escaped = Boolean(remote.escaped);
    state.downedTimer = Number(remote.downedTimer) || 0;
    state.respawnTimer = Number(remote.respawnTimer) || 0;
    state.respawnCount = Number(remote.respawnCount) || 0;
    state.stunnedTimer = Number(remote.stunnedTimer) || 0;
    state.invulnerabilityTimer = Number(remote.invulnerabilityTimer) || 0;
    state.snaredTimer = Number(remote.snaredTimer) || 0;
    state.slowedTimer = Number(remote.slowedTimer) || 0;
    state.slowScale = Number(remote.slowScale) || 1;
    state.distractedTimer = Number(remote.distractedTimer) || 0;
    state.catnipTimer = Number(remote.catnipTimer) || 0;
    state.distractionX = Number(remote.distractionX) || 0;
    state.distractionZ = Number(remote.distractionZ) || 0;
    state.attackCooldown = Number(remote.attackCooldown) || 0;
    state.actionWindup = remote.actionWindup || null;
    state.reviveTargetId = remote.reviveTargetId || null;
    state.reviveProgress = Number(remote.reviveProgress) || 0;
    state.healingTimer = Number(remote.healingTimer) || 0;
    state.healingTarget = Number(remote.healingTarget) || 0;
    state.healingRecipientId = remote.healingRecipientId || null;
    state.healingItemId = remote.healingItemId || null;
    state.healingSlot = Number.isFinite(remote.healingSlot)
      ? remote.healingSlot
      : 0;
    state.healingStartX = Number.isFinite(remote.healingStartX)
      ? remote.healingStartX
      : state.x;
    state.healingStartZ = Number.isFinite(remote.healingStartZ)
      ? remote.healingStartZ
      : state.z;
    state.healingTotal = Number(remote.healingTotal) || 0;
    state.abilityCooldown = Number(remote.abilityCooldown) || 0;
    state.abilityCooldownMax = Number(remote.abilityCooldownMax) || 0;
    state.abilityDashTimer = Number(remote.abilityDashTimer) || 0;
    state.abilityDashX = Number(remote.abilityDashX) || 0;
    state.abilityDashZ = Number(remote.abilityDashZ) || 0;
    state.abilityDashSpeed = Number(remote.abilityDashSpeed) || 0;
    state.abilityKind = remote.abilityKind || null;
    state.zoomTimer = Number(remote.zoomTimer) || 0;
    state.howlTimer = Number(remote.howlTimer) || 0;
    state.auraTimer = Number(remote.auraTimer) || 0;
    state.revealTimer = Number(remote.revealTimer) || 0;
    state.rootedTimer = Number(remote.rootedTimer) || 0;
    state.items = Array.isArray(remote.items)
      ? remote.items.map((stack) => (stack ? { ...stack } : null))
      : state.items;
    state.selectedSlot = Number.isFinite(remote.selectedSlot)
      ? remote.selectedSlot
      : state.selectedSlot;
  }

  function snapshotPlayer(state) {
    return {
      id: state.id,
      x: state.x,
      z: state.z,
      yaw: state.yaw,
      vx: state.vx,
      vz: state.vz,
      dashTimer: state.dashTimer,
      dashCooldown: state.dashCooldown,
      dashX: state.dashX,
      dashZ: state.dashZ,
      lastDashHeld: state.lastDashHeld,
      dashing: state.dashTimer > 0,
      lastProcessedInputSequence: state.lastProcessedInputSequence,
      hp: state.hp,
      maxHp: state.maxHp,
      downed: state.downed,
      escaped: state.escaped,
      downedTimer: state.downedTimer,
      respawnTimer: state.respawnTimer,
      respawnCount: state.respawnCount,
      stunnedTimer: state.stunnedTimer,
      invulnerabilityTimer: state.invulnerabilityTimer,
      snaredTimer: state.snaredTimer,
      slowedTimer: state.slowedTimer,
      slowScale: state.slowScale,
      distractedTimer: state.distractedTimer,
      catnipTimer: state.catnipTimer,
      distractionX: state.distractionX,
      distractionZ: state.distractionZ,
      attackCooldown: state.attackCooldown,
      actionWindup: state.actionWindup,
      reviveTargetId: state.reviveTargetId,
      reviveProgress: state.reviveProgress,
      healingTimer: state.healingTimer,
      healingTarget: state.healingTarget,
      healingRecipientId: state.healingRecipientId,
      healingItemId: state.healingItemId,
      healingSlot: state.healingSlot,
      healingStartX: state.healingStartX,
      healingStartZ: state.healingStartZ,
      healingTotal: state.healingTotal,
      abilityCooldown: state.abilityCooldown,
      abilityCooldownMax: state.abilityCooldownMax,
      abilityDashTimer: state.abilityDashTimer,
      abilityDashX: state.abilityDashX,
      abilityDashZ: state.abilityDashZ,
      abilityDashSpeed: state.abilityDashSpeed,
      abilityKind: state.abilityKind,
      zoomTimer: state.zoomTimer,
      howlTimer: state.howlTimer,
      auraTimer: state.auraTimer,
      revealTimer: state.revealTimer,
      rootedTimer: state.rootedTimer,
      items: state.items.map((stack) => (stack ? { ...stack } : null)),
      selectedSlot: state.selectedSlot,
    };
  }

  function getSnapshot() {
    return {
      time: performance.now(),
      players: [...states.values()].map(snapshotPlayer),
      pickups: pickups.map(({ id, active, item, x, z, team, dynamic }) => ({
        id,
        active,
        item,
        x,
        z,
        team,
        dynamic: Boolean(dynamic),
      })),
      projectiles: projectiles.map((entity) => ({ ...entity })),
      telegraphs: telegraphs.map((entity) => ({ ...entity })),
      traps: traps.map((entity) => ({ ...entity })),
      clouds: clouds.map((entity) => ({ ...entity })),
      pulses: pulses.map((entity) => ({ ...entity })),
      combatEvents: combatEvents.map((entity) => ({ ...entity })),
      roundFlow: structuredClone(roundFlow),
    };
  }

  function readLocalInput() {
    const x = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
    const z = Number(keys.has("KeyS")) - Number(keys.has("KeyW"));
    const vector = new THREE.Vector2(x, z);
    if (vector.lengthSq() > 1) vector.normalize();
    return {
      x: vector.x,
      z: vector.y,
      aim: currentAim,
      dash: keys.has("ShiftLeft") || keys.has("ShiftRight"),
      interact: keys.has("KeyE"),
    };
  }

  function stepPlayer(state, input, dt) {
    state.previousX = state.x;
    state.previousZ = state.z;
    state.previousYaw = state.yaw;
    if (
      state.downed ||
      state.escaped ||
      state.respawnTimer > 0 ||
      roundFlow.phase === "results"
    ) {
      state.vx = 0;
      state.vz = 0;
      return;
    }
    const player = state.player;
    const isDog = player.team === "dogs";
    const speed =
      (isDog ? movement.dogSpeed : movement.catSpeed) * speedMultiplier(state);
    const accelerationScale = classPassive(player).accelerationScale || 1;
    const aim = Number.isFinite(input.aim) ? input.aim : state.yaw;
    state.yaw = dampAngle(state.yaw, aim, movement.acceleration * 0.72, dt);

    if (
      input.dash &&
      !state.lastDashHeld &&
      state.dashCooldown <= 0 &&
      state.stunnedTimer <= 0 &&
      state.snaredTimer <= 0
    ) {
      const directionLength = Math.hypot(input.x, input.z);
      state.dashX =
        directionLength > 0.05
          ? input.x / directionLength
          : Math.sin(state.yaw);
      state.dashZ =
        directionLength > 0.05
          ? input.z / directionLength
          : Math.cos(state.yaw);
      state.dashTimer = movement.dashDuration;
      state.dashCooldown = movement.dashCooldown;
    }
    state.lastDashHeld = input.dash;
    state.dashCooldown = Math.max(0, state.dashCooldown - dt);

    let desiredX = 0;
    let desiredZ = 0;
    let acceleration = movement.stopping;
    if (
      state.stunnedTimer > 0 ||
      state.snaredTimer > 0 ||
      state.rootedTimer > 0
    ) {
      if (state.rootedTimer <= 0) state.abilityDashTimer = 0;
      desiredX = 0;
      desiredZ = 0;
      acceleration = movement.stopping * 2;
    } else if (state.abilityDashTimer > 0) {
      state.abilityDashTimer = Math.max(0, state.abilityDashTimer - dt);
      desiredX = state.abilityDashX * state.abilityDashSpeed;
      desiredZ = state.abilityDashZ * state.abilityDashSpeed;
      acceleration = movement.acceleration * 4;
    } else if (state.dashTimer > 0) {
      state.dashTimer = Math.max(0, state.dashTimer - dt);
      desiredX = state.dashX * movement.dashSpeed;
      desiredZ = state.dashZ * movement.dashSpeed;
      acceleration = movement.acceleration * 2.4;
    } else if (state.distractedTimer > 0) {
      const dx = state.distractionX - state.x;
      const dz = state.distractionZ - state.z;
      const distance = Math.hypot(dx, dz);
      if (distance > 0.5) {
        desiredX = (dx / distance) * speed;
        desiredZ = (dz / distance) * speed;
        acceleration = movement.acceleration;
      }
    } else if (Math.hypot(input.x, input.z) > 0.01) {
      desiredX = input.x * speed;
      desiredZ = input.z * speed;
      acceleration = movement.acceleration * accelerationScale;
    }

    state.vx = damp(state.vx, desiredX, acceleration, dt);
    state.vz = damp(state.vz, desiredZ, acceleration, dt);
    const previous = { x: state.x, z: state.z };
    const next = {
      x: state.x + state.vx * dt,
      z: state.z + state.vz * dt,
    };
    resolveWorldCollision(next, previous, player.team, state);
    state.x = next.x;
    state.z = next.z;
  }

  function resolveWorldCollision(position, previous, team, state) {
    const halfWidth = arena.width / 2 - arena.outerInset;
    const halfDepth = arena.depth / 2 - arena.outerInset;
    const radius = state?.radius || arena.playerRadius;
    const fenceClosed = !roundFlow.fenceDropped;
    const minX =
      fenceClosed && team === "dogs"
        ? arena.catFenceX + radius + 0.2
        : -halfWidth + radius;
    const maxX =
      fenceClosed && team !== "dogs"
        ? arena.catFenceX - radius - 0.2
        : halfWidth - radius;
    const minZ = -halfDepth + radius;
    const maxZ = halfDepth - radius;
    const unclampedX = position.x;
    const unclampedZ = position.z;
    position.x = clamp(position.x, minX, maxX);
    position.z = clamp(position.z, minZ, maxZ);
    if (position.x !== unclampedX) state.vx = 0;
    if (position.z !== unclampedZ) state.vz = 0;

    // Resolve against the side the character approached from. Choosing a side
    // from the final position can flip at corners and make clients jitter.
    for (const obstacle of obstacles) {
      const expandedX = obstacle.halfX + radius;
      const expandedZ = obstacle.halfZ + radius;
      if (Math.abs(position.z - obstacle.z) >= expandedZ) continue;
      if (
        position.x <= obstacle.x - expandedX ||
        position.x >= obstacle.x + expandedX
      )
        continue;
      const direction = position.x - previous.x;
      if (direction > 0 && previous.x <= obstacle.x - expandedX) {
        position.x = obstacle.x - expandedX;
        state.vx = 0;
      } else if (direction < 0 && previous.x >= obstacle.x + expandedX) {
        position.x = obstacle.x + expandedX;
        state.vx = 0;
      } else {
        const left = Math.abs(position.x - (obstacle.x - expandedX));
        const right = Math.abs(position.x - (obstacle.x + expandedX));
        position.x =
          left < right ? obstacle.x - expandedX : obstacle.x + expandedX;
        state.vx = 0;
      }
      position.x = clamp(position.x, minX, maxX);
    }

    for (const obstacle of obstacles) {
      const expandedX = obstacle.halfX + radius;
      const expandedZ = obstacle.halfZ + radius;
      if (Math.abs(position.x - obstacle.x) >= expandedX) continue;
      if (
        position.z <= obstacle.z - expandedZ ||
        position.z >= obstacle.z + expandedZ
      )
        continue;
      const direction = position.z - previous.z;
      if (direction > 0 && previous.z <= obstacle.z - expandedZ) {
        position.z = obstacle.z - expandedZ;
        state.vz = 0;
      } else if (direction < 0 && previous.z >= obstacle.z + expandedZ) {
        position.z = obstacle.z + expandedZ;
        state.vz = 0;
      } else {
        const near = Math.abs(position.z - (obstacle.z - expandedZ));
        const far = Math.abs(position.z - (obstacle.z + expandedZ));
        position.z =
          near < far ? obstacle.z - expandedZ : obstacle.z + expandedZ;
        state.vz = 0;
      }
      position.z = clamp(position.z, minZ, maxZ);
    }

    if (
      team === "dogs" &&
      roundFlow.phase === "dash" &&
      roundFlow.vanEdge !== null
    ) {
      const marker = arena.vanMarkers[roundFlow.vanEdge];
      const dx = position.x - marker.x;
      const dz = position.z - marker.z;
      const distance = Math.hypot(dx, dz);
      const safeRadius = roundConfig.dogCarrierExclusionRadius + radius;
      if (distance < safeRadius) {
        const directionX = distance > 0.001 ? dx / distance : 1;
        const directionZ = distance > 0.001 ? dz / distance : 0;
        position.x = marker.x + directionX * safeRadius;
        position.z = marker.z + directionZ * safeRadius;
        state.vx = 0;
        state.vz = 0;
      }
    }
  }

  function dampAngle(current, target, rate, dt) {
    const difference = Math.atan2(
      Math.sin(target - current),
      Math.cos(target - current),
    );
    return current + difference * (1 - Math.exp(-rate * dt));
  }

  function updatePointer(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    const crosshair = document.querySelector("#arena-crosshair");
    if (crosshair) {
      crosshair.style.left = `${event.clientX}px`;
      crosshair.style.top = `${event.clientY}px`;
    }
  }

  function aimAtPointer() {
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.ray.intersectPlane(groundPlane, aimPoint);
    const player = states.get(localPlayerId);
    if (hit && player) {
      const dx = aimPoint.x - player.x;
      const dz = aimPoint.z - player.z;
      if (dx * dx + dz * dz > 0.08) currentAim = Math.atan2(dx, dz);
    }
  }

  function handleKeyDown(event) {
    if (event.code === "Space" || event.code.startsWith("Arrow"))
      event.preventDefault();
    if (event.repeat) return;
    keys.add(event.code);
    if (event.code === "Space") practiceSwipe();
    if (event.code === "KeyQ") {
      requestAction({ type: "ability", aim: currentAim });
      pulseLocalActor();
    }
    if (event.code === "KeyE")
      onNotice?.(
        "Hold E near a pickup to grab it or near a downed cat to revive.",
      );
    if (event.code === "Digit1" || event.code === "Numpad1") setActiveSlot(1);
    if (event.code === "Digit2" || event.code === "Numpad2") setActiveSlot(2);
    if (event.code === "Tab") toggleScoreboard();
    if (event.code === "Escape") onLeave?.();
  }

  function handleKeyUp(event) {
    keys.delete(event.code);
  }

  function preventContextMenu(event) {
    event.preventDefault();
  }

  function setActiveSlot(slot) {
    activeSlot = slot;
    const local = states.get(localPlayerId);
    if (local) local.selectedSlot = slot - 1;
    requestAction({ type: "switch", slot: slot - 1 });
    for (const element of document.querySelectorAll(".arena-slot")) {
      element.classList.toggle("active", Number(element.dataset.slot) === slot);
    }
  }

  function toggleScoreboard() {
    document.querySelector(".arena-roster")?.classList.toggle("is-open");
  }

  function practiceSwipe() {
    const now = performance.now();
    if (now - lastActionAt < 210) return;
    lastActionAt = now;
    const actor = visuals.get(localPlayerId);
    const player = states.get(localPlayerId);
    if (!actor || !player || actor.isSwiping) return;
    requestAction({ type: "use", aim: currentAim });
    actor.isSwiping = true;
    const material = makeMaterial(0xffedbc, {
      transparent: true,
      opacity: 0.85,
      emissive: 0xe9a45c,
      emissiveIntensity: 0.25,
    });
    const slash = addMesh(
      actor.root,
      new THREE.TorusGeometry(0.76, 0.075, 5, 18, Math.PI * 0.78),
      material,
      { x: 0, y: 0.4, z: 0.92 },
      null,
      { x: Math.PI / 2, y: Math.PI * 0.1 },
    );
    slash.userData.practiceSlash = true;
    actor.practiceSlash = slash;
    actor.swipeTime = 0;
    onNotice?.("BONK! Use your held item.");
  }

  function pulseLocalActor() {
    const actor = visuals.get(localPlayerId);
    if (!actor) return;
    actor.abilityPulse = 0.72;
  }

  function updateActorAnimations(dt, alpha = 1) {
    for (const [id, visual] of visuals) {
      if (id.startsWith("van-")) {
        visual.children[0].rotation.y += dt * 0.45;
        continue;
      }
      const state = states.get(id);
      if (!state) continue;
      const moving = Math.min(1, Math.hypot(state.vx, state.vz) / 2.5);
      const useInterpolation = isHost || id === localPlayerId;
      const renderX = useInterpolation
        ? THREE.MathUtils.lerp(state.previousX, state.x, alpha)
        : state.x;
      const renderZ = useInterpolation
        ? THREE.MathUtils.lerp(state.previousZ, state.z, alpha)
        : state.z;
      const renderYaw = useInterpolation
        ? dampAngle(
            state.previousYaw,
            state.yaw,
            1 / movement.fixedStep,
            alpha * movement.fixedStep,
          )
        : state.yaw;
      const sneakyRange = classPassive(state.player).noticeRange;
      if (sneakyRange) {
        const viewer = states.get(localPlayerId);
        let seen = true;
        if (viewer?.player.team === "dogs" && viewer.revealTimer <= 0) {
          seen = [...states.values()].some(
            (dog) =>
              dog.player.team === "dogs" &&
              dog.respawnTimer <= 0 &&
              Math.hypot(dog.x - state.x, dog.z - state.z) <= sneakyRange,
          );
        }
        if (!visual.unknownMarker) {
          const marker = makeLabelSprite("?", "#fff1cc", "#493a2e");
          marker.scale.set(0.9, 0.9, 1);
          marker.position.y = 1.6;
          marker.visible = false;
          scene.add(marker);
          visual.unknownMarker = marker;
        }
        visual.unknownMarker.visible = !seen;
        visual.unknownMarker.position.set(renderX, 1.6, renderZ);
        visual.root.visible = seen;
      }
      visual.pulse += dt * (moving > 0.1 ? 10 : 2.1);
      const bob = Math.abs(Math.sin(visual.pulse)) * (0.06 + moving * 0.12);
      visual.root.position.set(
        renderX,
        state.downed
          ? combat.visualDefeatHeight
          : bob + (state.dashTimer > 0 ? 0.14 : 0),
        renderZ,
      );
      visual.root.rotation.set(state.downed ? Math.PI / 2 : 0, renderYaw, 0);
      visual.body.scale.y =
        (visual.isDog ? 0.82 : 0.84) *
        (state.dashTimer > 0 ? 0.91 : 1) *
        (state.downed ? 0.62 : 1);
      visual.body.scale.x =
        (visual.isDog ? 0.9 : 0.9) * (state.dashTimer > 0 ? 1.06 : 1);
      visual.head.rotation.z =
        Math.sin(visual.pulse * 0.5) * 0.035 +
        (state.dashTimer > 0 ? -0.12 : 0);
      visual.tail.rotation.x =
        Math.sin(visual.pulse * 0.72) * (visual.isDog ? 0.34 : 0.45);
      visual.tail.rotation.z = Math.cos(visual.pulse * 0.42) * 0.22;
      visual.legs.forEach((leg, index) => {
        const phase = visual.pulse + (index === 0 || index === 3 ? Math.PI : 0);
        leg.rotation.x = Math.sin(phase) * moving * 0.62;
      });
      if (visual.practiceSlash) {
        visual.swipeTime += dt;
        const progress = Math.min(1, visual.swipeTime / 0.25);
        visual.practiceSlash.rotation.z = -0.8 + progress * 1.8;
        visual.practiceSlash.scale.setScalar(
          0.85 + Math.sin(progress * Math.PI) * 0.25,
        );
        visual.practiceSlash.material.opacity = (1 - progress) * 0.85;
        if (progress >= 1) {
          visual.root.remove(visual.practiceSlash);
          visual.practiceSlash.geometry.dispose();
          visual.practiceSlash.material.dispose();
          visual.practiceSlash = null;
          visual.isSwiping = false;
        }
      }
      if (visual.abilityPulse > 0) {
        visual.abilityPulse = Math.max(0, visual.abilityPulse - dt);
        visual.root.scale.setScalar(
          1 + Math.sin((0.72 - visual.abilityPulse) * Math.PI * 2) * 0.055,
        );
      } else {
        visual.root.scale.setScalar(1);
      }
    }
  }

  function syncActorVisuals(dt) {
    for (const state of states.values()) {
      if (!isHost && state.id !== localPlayerId && state.target) {
        state.previousX = state.x;
        state.previousZ = state.z;
        state.previousYaw = state.yaw;
        state.x = damp(state.x, state.target.x, movement.remoteSmoothing, dt);
        state.z = damp(state.z, state.target.z, movement.remoteSmoothing, dt);
        state.yaw = dampAngle(
          state.yaw,
          state.target.yaw,
          movement.remoteSmoothing,
          dt,
        );
        state.dashTimer = state.remoteDashing ? movement.dashDuration : 0;
      }
    }
    const alpha = isHost
      ? clamp(hostAccumulator / movement.fixedStep, 0, 1)
      : clamp(simAccumulator / movement.fixedStep, 0, 1);
    updateActorAnimations(dt, alpha);
  }

  function simulate(dt, localInput) {
    if (isHost) {
      for (const state of states.values()) {
        if (state.isBot || state.autopilot) updateBotAI(state, dt);
        const input = inputs.get(state.id) || {
          x: 0,
          z: 0,
          aim: state.yaw,
          dash: false,
          interact: false,
        };
        processInteraction(state, input, dt);
        tickPlayerCombatState(state, input, dt);
        stepPlayer(state, input, dt);
        if (Number.isFinite(input.sequence)) {
          state.lastProcessedInputSequence = Math.max(
            state.lastProcessedInputSequence,
            input.sequence,
          );
        }
      }
      tickCombatEntities(dt);
      tickRoundFlow(dt);
    } else {
      const state = states.get(localPlayerId);
      if (state) {
        localInputSequence += 1;
        const input = { ...localInput, sequence: localInputSequence };
        pendingInputs.push({ sequence: localInputSequence, input });
        if (pendingInputs.length > movement.predictionHistoryLimit) {
          pendingInputs.shift();
        }
        stepPlayer(state, input, dt);
      }
    }
  }

  function updateCamera(dt) {
    const visual = visuals.get(localPlayerId);
    if (!visual) return;
    const target = new THREE.Vector3(
      visual.root.position.x,
      config.lookHeight + 0.3,
      visual.root.position.z,
    );
    const zoom = roundFlow.phase === "dash" ? config.dashZoomScale : 1;
    const offset = new THREE.Vector3(
      0,
      config.height * zoom,
      config.trailingDistance * zoom,
    );
    const desired = target.clone().add(offset);
    if (!cameraStarted) {
      cameraLook.copy(target);
      camera.position.copy(desired);
      cameraStarted = true;
    } else {
      const smoothing = 1 - Math.exp(-config.smoothing * dt);
      cameraLook.lerp(target, smoothing);
      camera.position.lerp(cameraLook.clone().add(offset), smoothing);
    }
    if (cameraShakeRemaining > 0) {
      cameraShakeRemaining = Math.max(0, cameraShakeRemaining - dt);
      const strength =
        (cameraShakeRemaining / roundConfig.fenceImpactShakeSeconds) *
        roundConfig.fenceShakeIntensity;
      camera.position.x += Math.sin(elapsed * 43) * strength;
      camera.position.y += Math.cos(elapsed * 37) * strength * 0.45;
    }
    camera.lookAt(cameraLook);
  }

  function update() {
    if (disposed) return;
    const now = performance.now();
    const dt = Math.min(
      (now - lastRenderAt) / 1000,
      movement.maxRenderDeltaSeconds,
    );
    lastRenderAt = now;
    elapsed += dt;
    frameCount += 1;
    if (now - lastFpsReportAt >= 1000) {
      fps = Math.round((frameCount * 1000) / (now - lastFpsReportAt));
      frameCount = 0;
      lastFpsReportAt = now;
      onDebug?.({ fps, predictionError: lastPredictionError });
    }
    aimAtPointer();
    Object.assign(currentLocalInput, readLocalInput());
    if (isHost) {
      inputs.set(localPlayerId, { ...currentLocalInput });
    } else {
      simAccumulator += dt;
      let steps = 0;
      while (
        simAccumulator >= movement.fixedStep &&
        steps < movement.maxCatchUpSteps
      ) {
        simulate(movement.fixedStep, currentLocalInput);
        simAccumulator -= movement.fixedStep;
        steps += 1;
      }
      if (steps === movement.maxCatchUpSteps) {
        simAccumulator = Math.min(simAccumulator, movement.fixedStep);
      }
      if (now - lastInputSentAt >= movement.inputSendInterval * 1000) {
        lastInputSentAt = now;
        onInput?.({ ...currentLocalInput, sequence: localInputSequence });
      }
    }
    syncActorVisuals(dt);
    updateCamera(dt);
    syncRoundVisuals();
    flowBannerRemaining = Math.max(0, flowBannerRemaining - dt);
    const phaseBanner = document.querySelector("#phase-banner");
    if (phaseBanner && flowBannerRemaining === 0)
      phaseBanner.classList.remove("show");
    for (let index = fenceDust.length - 1; index >= 0; index -= 1) {
      const puff = fenceDust[index];
      puff.userData.life -= dt;
      puff.position.y += dt * 0.6;
      puff.scale.multiplyScalar(1 + dt * 0.7);
      puff.material.opacity =
        Math.max(0, puff.userData.life / roundConfig.fenceImpactShakeSeconds) *
        0.52;
      if (puff.userData.life <= 0) {
        scene.remove(puff);
        puff.geometry.dispose();
        puff.material.dispose();
        fenceDust.splice(index, 1);
      }
    }
    for (const pickup of pickups) {
      const visual = pickupVisuals.get(pickup.id);
      if (visual) {
        visual.position.y =
          0.035 * Math.sin(elapsed * 2.4 + visual.userData.seed);
        visual.rotation.y += dt * 0.65;
      }
    }
    updateCombatHud();
    syncEventVisuals(dt);
    updateEdgeMarkers();
    updateAbilityHud();
    for (const [key, visual] of visuals) {
      if (!key.startsWith("van-")) continue;
      const pulse = Math.sin(elapsed * 1.6 + visual.userData.seed) * 0.025;
      visual.scale.setScalar(1 + pulse);
    }
    renderer.render(scene, camera);
    animationFrame = requestAnimationFrame(update);
  }

  // ---- Debug tools (?debug=1) ----
  function debugPlayers() {
    return [...states.values()].map((state) => ({
      id: state.id,
      name: state.player.name,
      team: state.player.team,
      className: state.player.className,
      isBot: state.isBot,
      x: +state.x.toFixed(2),
      z: +state.z.toFixed(2),
      hp: state.hp,
      maxHp: state.maxHp,
      downed: state.downed,
      escaped: state.escaped,
      respawn: +state.respawnTimer.toFixed(2),
      items: state.items.map((stack) => stack && { ...stack }),
      selectedSlot: state.selectedSlot,
      abilityCooldown: +state.abilityCooldown.toFixed(2),
      healingTimer: +state.healingTimer.toFixed(2),
      stunned: +state.stunnedTimer.toFixed(2),
      slowed: +state.slowedTimer.toFixed(2),
      catnip: +state.catnipTimer.toFixed(2),
      zoom: +state.zoomTimer.toFixed(2),
      howl: +state.howlTimer.toFixed(2),
      aura: +state.auraTimer.toFixed(2),
      reveal: +state.revealTimer.toFixed(2),
      rooted: +state.rootedTimer.toFixed(2),
    }));
  }

  function debugSkipPhase() {
    if (!isHost) return;
    if (roundFlow.phase === "dash") {
      vanArrivalRemaining = 0;
      roundFlow.vanArrivalRemaining = 0;
      roundFlow.phaseTimeRemaining = 0;
    } else if (roundFlow.phase !== "results") roundFlow.phaseTimeRemaining = 0;
    if (roundFlow.phase === "scavenge" || roundFlow.phase === "fence-drop")
      return;
  }

  function debugFastForward(seconds) {
    if (!isHost) return 0;
    const total = Math.min(seconds, GAME_CONFIG.debug.fastForwardMaxSeconds);
    const steps = Math.round(total / movement.fixedStep);
    for (let index = 0; index < steps; index += 1) {
      simulate(movement.fixedStep, currentLocalInput);
    }
    return steps * movement.fixedStep;
  }

  function debugSpawnDogBot() {
    if (!isHost) return null;
    const count = players.filter((player) => player.isBot && player.team === "dogs").length;
    const player = {
      id: `bot-dog-x${count + 1}-${nextEntityId++}`,
      name: botConfig.names[count % botConfig.names.length],
      team: "dogs",
      className: "Terrier",
      isBot: true,
      ready: true,
    };
    players.push(player);
    const dogIndex = players.filter((entry) => entry.team === "dogs").length - 1;
    createActor(player, dogIndex);
    const state = states.get(player.id);
    state.x = arena.dogSpawn.x;
    state.z = arena.dogSpawn.z + (Math.random() - 0.5) * 8;
    if (roundFlow.fenceDropped) {
      state.x = arena.catFenceX + 4;
    }
    state.previousX = state.x;
    state.previousZ = state.z;
    syncActorVisuals(0);
    return player.id;
  }

  function overlapsFootprint(obstacle, x, z, halfX, halfZ) {
    return (
      Math.abs(obstacle.x - x) < obstacle.halfX + halfX &&
      Math.abs(obstacle.z - z) < obstacle.halfZ + halfZ
    );
  }

  function debugCheckVanSpots() {
    if (!navGrid) buildNavGrid();
    const report = [];
    const wasDropped = roundFlow.fenceDropped;
    roundFlow.fenceDropped = true; // the dash always happens after the fence falls
    for (const [index, marker] of arena.vanMarkers.entries()) {
      const conflicts = obstacles
        .filter((obstacle) => overlapsFootprint(obstacle, marker.x, marker.z, 2.5, 1.3))
        .map((obstacle) => `collider@${obstacle.x},${obstacle.z}`);
      const nearPickups = pickups
        .filter((pickup) => Math.hypot(pickup.x - marker.x, pickup.z - marker.z) < 2.4)
        .map((pickup) => pickup.id);
      const halfWidth = arena.width / 2;
      const halfDepth = arena.depth / 2;
      const insideBounds =
        Math.abs(marker.x) + 2.5 <= halfWidth && Math.abs(marker.z) + 1.3 <= halfDepth;
      const spawnPath = findPath(arena.catSpawn.x, arena.catSpawn.z, marker.x, marker.z, "cats");
      report.push({
        edge: index,
        label: marker.label,
        conflicts,
        nearPickups,
        insideBounds,
        reachableFromCatSpawn: Boolean(spawnPath),
        walkDistance: spawnPath ? +pathLength(spawnPath, arena.catSpawn.x, arena.catSpawn.z).toFixed(1) : null,
      });
    }
    roundFlow.fenceDropped = wasDropped;
    return report;
  }

  // Walks an unimpeded cat to each carrier with the real simulation and compares
  // the time it needs against the dash timer for every difficulty.
  function debugMeasureDash() {
    if (!isHost) return [];
    const local = states.get(localPlayerId);
    if (!local || local.player.team !== "cats") return [{ error: "Play as a cat to measure the dash." }];
    const results = [];
    const savedDogs = [...states.values()].filter((state) => state.player.team === "dogs");
    const savedRespawn = savedDogs.map((state) => state.respawnTimer);
    for (const state of savedDogs) state.respawnTimer = 9999;
    for (const level of ["easy", "normal", "hard"]) {
      for (let edge = 0; edge < arena.vanMarkers.length; edge += 1) {
        for (const state of states.values()) {
          if (state.player.team !== "cats") continue;
          const spawn = getSpawn(state.player, 0);
          state.x = spawn.x;
          state.z = spawn.z;
          state.previousX = state.x;
          state.previousZ = state.z;
          state.vx = 0;
          state.vz = 0;
          state.hp = state.maxHp;
          state.downed = false;
          state.escaped = false;
          state.autopilot = true;
          botBrains.delete(state.id);
        }
        roundFlow.phase = "hunt";
        roundFlow.results = null;
        roundFlow.escapedPlayerIds = [];
        roundFlow.event = null;
        roundFlow.fenceDropped = true;
        startRescueDash(edge, level);
        const timer = roundFlow.phaseTimeRemaining;
        let steps = 0;
        const limit = Math.round(120 / movement.fixedStep);
        while (roundFlow.phase === "dash" && steps < limit) {
          simulate(movement.fixedStep, currentLocalInput);
          steps += 1;
        }
        // Total walking time from the moment the van starts arriving (conservative:
        // the dash timer itself only starts once the van has arrived).
        const used = steps * movement.fixedStep;
        results.push({
          difficulty: level,
          edge: arena.vanMarkers[edge].label,
          timer: +timer.toFixed(2),
          secondsUsed: +used.toFixed(2),
          ratio: +(used / timer).toFixed(3),
          target: roundConfig.dashSlackRatio[level],
          escaped: roundFlow.escapedPlayerIds.length > 0,
        });
      }
    }
    for (const state of states.values()) state.autopilot = false;
    savedDogs.forEach((state, index) => (state.respawnTimer = savedRespawn[index]));
    return results;
  }

  function debugApi() {
    const find = (id) => states.get(id);
    return {
      players: debugPlayers,
      flow: () => structuredClone(roundFlow),
      pickups: () => pickups.map(({ id, item, team, x, z, active, dynamic }) => ({ id, item, team, x, z, active, dynamic })),
      skipPhase: debugSkipPhase,
      fastForward: debugFastForward,
      spawnDogBot: debugSpawnDogBot,
      checkVanSpots: debugCheckVanSpots,
      measureDash: debugMeasureDash,
      damage(id, amount) {
        const state = find(id);
        if (!state) return;
        state.hp = Math.max(1, state.hp - amount);
        updateCombatHud();
      },
      teleport(id, x, z) {
        const state = find(id);
        if (!state) return;
        state.x = x;
        state.z = z;
        state.previousX = x;
        state.previousZ = z;
      },
      giveItem(id, itemId) {
        const state = find(id);
        if (!state) return;
        const slot = state.items.findIndex((stack) => !stack || stack.charges === 0);
        state.items[slot >= 0 ? slot : 1] = createItemStack(itemId);
      },
      autopilot(id, on) {
        const state = find(id);
        if (state) state.autopilot = Boolean(on);
      },
      forceEvent(kind) {
        if (roundFlow.phase === "hunt") startRandomEvent(kind);
      },
      act(id, action) {
        performAction(id, action);
      },
      setInput(id, input) {
        setPlayerInput(id, input);
      },
      freezeBots(on) {
        debugFreezeBots = Boolean(on);
      },
      cooldownOff() {
        for (const state of states.values()) state.abilityCooldown = 0;
      },
    };
  }

  function resize() {
    if (disposed || !container.clientWidth || !container.clientHeight) return;
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(
      Math.min(
        window.devicePixelRatio || 1,
        GAME_CONFIG.render.pixelRatioLimit,
      ),
    );
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (window.catDebug === api.debug) delete window.catDebug;
    cancelAnimationFrame(animationFrame);
    hostClockWorker?.terminate();
    hostClockWorker = null;
    if (hostClockUrl) URL.revokeObjectURL(hostClockUrl);
    hostClockUrl = null;
    if (hostClockFallback) clearInterval(hostClockFallback);
    hostClockFallback = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    renderer.domElement.removeEventListener("contextmenu", preventContextMenu);
    renderer.domElement.removeEventListener("pointermove", onPointerMove);
    renderer.domElement.removeEventListener("pointerdown", onPointerDown);
    renderer.domElement.removeEventListener("wheel", onWheel);
    scene.traverse((object) => {
      object.geometry?.dispose();
      if (object.material) {
        const list = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of list) {
          material.map?.dispose();
          material.dispose();
        }
      }
      object.userData.texture?.dispose();
    });
    renderer.dispose();
    renderer.domElement.remove();
  }

  resize();
  animationFrame = requestAnimationFrame(update);
  onNotice?.("WASD to roam · Mouse to aim · Shift to dodge");
  return api;
}
