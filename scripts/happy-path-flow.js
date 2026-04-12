const DEFAULT_BASE_URL = process.env.BACKEND_BASE_URL || "http://localhost:3000";
const DEFAULT_ITERATIONS = Number.parseInt(process.env.FLOW_ITERATIONS || "2", 10);

function parseArgs(argv) {
  const config = {
    baseUrl: DEFAULT_BASE_URL,
    iterations: Number.isInteger(DEFAULT_ITERATIONS) && DEFAULT_ITERATIONS > 0 ? DEFAULT_ITERATIONS : 2,
  };

  for (const arg of argv) {
    if (arg.startsWith("--base-url=")) {
      config.baseUrl = arg.slice("--base-url=".length);
    } else if (arg.startsWith("--iterations=")) {
      const parsed = Number.parseInt(arg.slice("--iterations=".length), 10);
      if (Number.isInteger(parsed) && parsed > 0) config.iterations = parsed;
    }
  }

  return config;
}

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function api(baseUrl, path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`${response.status} ${data?.error || response.statusText}`);
  }

  return data;
}

async function waitForBackend(baseUrl) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < 15000) {
    try {
      const health = await api(baseUrl, "/");
      if (health?.ok) return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw new Error(`Backend not reachable at ${baseUrl}. ${lastError ? lastError.message : ""}`.trim());
}

function seatLabel(seat) {
  return `seat ${seat}`;
}

function pickSeat(players, predicate) {
  return players.find((player) => predicate(player))?.seat ?? null;
}

function pickNightTargets(room, previous = {}) {
  const players = room.players || [];
  const alive = players.filter((player) => player.alive);
  const wolves = alive.filter((player) => player.role === "werewolf");
  const nonWolves = alive.filter((player) => player.role !== "werewolf");
  const witch = alive.find((player) => player.role === "witch");
  const guard = alive.find((player) => player.role === "guard");
  const seer = alive.find((player) => player.role === "seer");

  invariant(wolves.length > 0, "Expected at least one alive werewolf after role assignment");

  const wolvesTarget =
    pickSeat(nonWolves, (player) => player.role === "villager" && player.seat !== previous.wolvesTarget) ??
    pickSeat(nonWolves, (player) => player.seat !== previous.wolvesTarget) ??
    null;

  invariant(wolvesTarget != null, "Expected a non-werewolf target for werewolves");

  const guardTarget =
    guard
      ? pickSeat(alive, (player) => player.seat !== wolvesTarget && player.seat !== previous.guardTarget) ??
        pickSeat(alive, (player) => player.seat !== wolvesTarget) ??
        guard.seat
      : null;

  const seerTarget =
    seer
      ? pickSeat(wolves, (player) => player.seat !== seer.seat) ??
        pickSeat(alive, (player) => player.seat !== seer.seat) ??
        null
      : null;

  const poisonTarget =
    witch
      ? pickSeat(wolves, (player) => player.seat !== previous.poisonTarget) ?? null
      : null;

  return {
    guardTarget,
    wolvesTarget,
    seerTarget,
    poisonTarget,
    witchSeat: witch?.seat ?? null,
  };
}

async function createHappyPathRoom(baseUrl, iteration) {
  const room = await api(baseUrl, "/rooms", {
    method: "POST",
    body: JSON.stringify({
      name: `Flow Test ${iteration}`,
      maxSeats: 9,
      presetKey: "9p-classic",
      mode: "strict",
      initialPlayers: 0,
      playerCount: 9,
      rules: {
        witchSelfSaveFirstNight: false,
        guardConsecutiveProtectAllowed: false,
      },
    }),
  });

  invariant(room.status === "init", "Room should start in init phase");
  return room;
}

async function addPlayers(baseUrl, roomId, expectedCount) {
  const result = await api(baseUrl, `/rooms/${roomId}/players/bulk`, {
    method: "POST",
    body: JSON.stringify({ count: expectedCount }),
  });

  invariant(result.added === expectedCount, `Expected to add ${expectedCount} players, got ${result.added}`);
  invariant(result.room.players.length === expectedCount, "Bulk add should fill the room to the expected count");
  return result.room;
}

async function assignRoles(baseUrl, roomId) {
  const room = await api(baseUrl, `/rooms/${roomId}/assign`, {
    method: "POST",
    body: JSON.stringify({}),
  });

  invariant(room.status === "night", "Room should enter night after role assignment");
  invariant(room.players.every((player) => player.role), "Every player should have a role after assignment");
  return room;
}

async function resolveNight(baseUrl, roomId, payload) {
  return api(baseUrl, `/rooms/${roomId}/night/resolve`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function advancePhase(baseUrl, roomId) {
  return api(baseUrl, `/rooms/${roomId}/step`, {
    method: "POST",
    body: JSON.stringify({
      actor: "system",
      action: "advancePhase",
    }),
  });
}

async function fetchRoom(baseUrl, roomId) {
  return api(baseUrl, `/rooms/${roomId}`);
}

async function runIteration(baseUrl, iteration) {
  console.log(`\n[flow ${iteration}] create room`);
  const room = await createHappyPathRoom(baseUrl, iteration);

  console.log(`[flow ${iteration}] add players`);
  const populatedRoom = await addPlayers(baseUrl, room._id, 9);
  invariant(populatedRoom.meta?.ready === true, "Room should be ready after filling all strict-mode players");

  console.log(`[flow ${iteration}] assign roles / start game`);
  let assignedRoom = await assignRoles(baseUrl, room._id);

  console.log(`[flow ${iteration}] resolve first night`);
  const firstNightTargets = pickNightTargets(assignedRoom);
  const firstNight = await resolveNight(baseUrl, room._id, {
    guard: { targetSeat: firstNightTargets.guardTarget },
    wolves: { targetSeat: firstNightTargets.wolvesTarget },
    seer: { targetSeat: firstNightTargets.seerTarget },
    witch: {
      healTargetSeat: firstNightTargets.wolvesTarget,
      poisonTargetSeat: null,
      isFirstNight: true,
    },
    advanceToDay: true,
  });

  invariant(firstNight.room.status === "day", "Room should advance to day after first night resolution");
  invariant(
    firstNight.summary.survived.includes(firstNightTargets.wolvesTarget),
    `Expected ${seatLabel(firstNightTargets.wolvesTarget)} to survive first night because of heal`
  );

  console.log(`[flow ${iteration}] advance day -> vote -> night`);
  const voteRoom = await advancePhase(baseUrl, room._id);
  invariant(voteRoom.status === "vote", "Day should advance to vote");
  assignedRoom = await advancePhase(baseUrl, room._id);
  invariant(assignedRoom.status === "night", "Vote should advance back to night");

  console.log(`[flow ${iteration}] resolve second night`);
  const secondNightTargets = pickNightTargets(assignedRoom, {
    guardTarget: firstNightTargets.guardTarget,
    wolvesTarget: firstNightTargets.wolvesTarget,
    poisonTarget: null,
  });
  const secondNight = await resolveNight(baseUrl, room._id, {
    guard: { targetSeat: secondNightTargets.guardTarget },
    wolves: { targetSeat: secondNightTargets.wolvesTarget },
    seer: { targetSeat: secondNightTargets.seerTarget },
    witch: {
      healTargetSeat: null,
      poisonTargetSeat: secondNightTargets.poisonTarget,
      isFirstNight: false,
    },
    advanceToDay: true,
  });

  invariant(secondNight.room.status === "day", "Room should advance to day after second night resolution");
  invariant(
    secondNight.summary.killed.includes(secondNightTargets.wolvesTarget),
    `Expected ${seatLabel(secondNightTargets.wolvesTarget)} to die on second night`
  );
  if (secondNightTargets.poisonTarget != null) {
    invariant(
      secondNight.summary.killed.includes(secondNightTargets.poisonTarget),
      `Expected poison target ${seatLabel(secondNightTargets.poisonTarget)} to die on second night`
    );
  }

  console.log(`[flow ${iteration}] verify logs / state`);
  const finalRoom = await fetchRoom(baseUrl, room._id);
  const nightSummaries = (finalRoom.log || []).filter((entry) => entry?.payload?.action === "nightSummary");

  invariant(nightSummaries.length >= 2, "Expected at least two nightSummary log entries");
  invariant(
    finalRoom.players.some((player) => player.alive === false),
    "Expected at least one dead player after the second night"
  );

  console.log(
    `[flow ${iteration}] ok | room=${room._id} | night summaries=${nightSummaries.length} | dead=${finalRoom.players.filter((p) => !p.alive).length}`
  );
}

async function main() {
  const { baseUrl, iterations } = parseArgs(process.argv.slice(2));

  console.log(`[flow-test] base URL: ${baseUrl}`);
  console.log(`[flow-test] iterations: ${iterations}`);

  await waitForBackend(baseUrl);

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    await runIteration(baseUrl, iteration);
  }

  console.log(`\n[flow-test] success: completed ${iterations} happy-path run(s)`);
}

main().catch((error) => {
  console.error(`\n[flow-test] failed: ${error.message}`);
  process.exit(1);
});
