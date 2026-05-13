import express from "express";
import Room from "../models/room.js";
import { HttpError } from "../utils/errors.js";
import { performAction } from "../engine/actions.js";
import { PHASE_ACTORS, nextPhase } from "../engine/phases.js";
import { isGameOver } from "../engine/gameover.js";
import { PRESETS, totalRoles, nonVillagerCount, finalizeRoleConfig } from "../utils/presets.js";
import { resolveNight } from "../services/nightService.js";

const router = express.Router();

function cloneForLog(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createUndoSnapshot(room) {
  return {
    players: cloneForLog(room.players || []),
    status: room.status,
    meta: cloneForLog(room.meta || {}),
  };
}

function restoreRoomSnapshot(room, snapshot) {
  room.players = cloneForLog(snapshot?.players || []);
  room.status = snapshot?.status || "init";
  room.meta = cloneForLog(snapshot?.meta || {});
}

function toPlainRoles(mapOrObj) {
  if (!mapOrObj) return {};
  // Detect Map (has forEach and size, but plain objects don't)
  if (typeof mapOrObj.forEach === "function" && typeof mapOrObj.size === "number") {
    return Object.fromEntries(mapOrObj);
  }
  return mapOrObj;
}

function nextAvailableSeat(players, maxSeats) {
  const used = new Set(players.map((p) => p.seat));
  for (let s = 1; s <= maxSeats; s++) if (!used.has(s)) return s;
  return null;
}

function validateRolesAgainstPlayers(roles, playersCount) {
  const needed = totalRoles(roles);
  if (playersCount < needed) {
    throw new HttpError(400, `Players (${playersCount}) fewer than roles required (${needed}).`);
  }
}

function ensureRoomReadyForAssign(room, mode) {
  injectMeta(room, mode);

  const requiredPlayers = Number.isInteger(room.playerCount)
    ? room.playerCount
    : room.meta?.expectedPlayers ?? 0;

  if (room.players.length !== requiredPlayers) {
    throw new HttpError(
      409,
      `Player count must be exactly ${requiredPlayers} before assigning roles (got ${room.players.length}).`
    );
  }

  if (!room.meta?.ready) {
    throw new HttpError(409, room.meta?.readyIssues?.[0] || "Room is not ready for role assignment");
  }
}

function assignRolesRandomly(players, roles) {
  const bag = [];
  Object.entries(roles).forEach(([role, count]) => {
    for (let i = 0; i < count; i++) bag.push(role);
  });
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  for (let i = 0; i < bag.length; i++) sorted[i].role = bag[i];
  for (let i = bag.length; i < sorted.length; i++) sorted[i].role = "villager";
  return sorted;
}

function injectMeta(room, mode = "flex") {
  const prevMeta = room.meta || {};
  const base =
    (room.rolesConfig && Object.keys(toPlainRoles(room.rolesConfig)).length
      ? toPlainRoles(room.rolesConfig)
      : room.presetKey
      ? PRESETS[room.presetKey]
      : {}) || {};

  const playersCount = room.players.length;
  const fin = finalizeRoleConfig(base, playersCount, mode);
  const expectedPlayers = fin.error ? totalRoles(base) : fin.expectedPlayers;
  const playersNeeded = Math.max(0, expectedPlayers - playersCount);

  const issues = [];
  if (playersCount === 0) issues.push("No players added yet");
  if (mode === "strict") {
    const expectedStrict = totalRoles(base);
    if (playersCount !== expectedStrict) {
      issues.push(`Strict mode requires exactly ${expectedStrict} players (got ${playersCount})`);
    }
  } else {
    const mustHave = nonVillagerCount ? nonVillagerCount(base) : totalRoles(base) - (base.villager || 0);
    if (playersCount < mustHave) {
      issues.push(`Players must be >= non-villager count (${mustHave})`);
    }
  }
  const seats = room.players.map((p) => p.seat);
  if (new Set(seats).size !== seats.length) issues.push("Duplicate seats detected");
  if (seats.some((s) => s < 1 || s > room.maxSeats)) issues.push("Seat out of range");
  if (room.players.some((p) => !p.nickname)) issues.push("Nickname missing for some players");

  room.meta = {
    ...prevMeta,
    expectedPlayers,
    playersNeeded,
    phaseAllowedActors: PHASE_ACTORS[room.status] || [],
    mode,
    ready: issues.length === 0,
    readyIssues: issues,
    minPlayers: Math.max(4, nonVillagerCount ? nonVillagerCount(base) : 0),
    currentPlayers: playersCount,
  };
}

// Create a room
router.post("/", async (req, res, next) => {
  try {
    const {
      name = "",
      maxSeats,
      rules = {},
      presetKey,
      roles,
      mode = "flex",
      initialPlayers = 0,
      players = [],
      configType, // 'classic' | 'custom'
      playerCount,
    } = req.body || {};

    if (!maxSeats || maxSeats < 4) throw new HttpError(400, "maxSeats must be >= 4");

    const baseRoles = presetKey ? PRESETS[presetKey] : roles || {};
    if (!baseRoles || !Object.keys(baseRoles).length) {
      throw new HttpError(400, "Provide presetKey or roles");
    }

    let seedPlayers = Array.isArray(players) && players.length ? players : [];
    if (seedPlayers.length === 0 && Number.isFinite(+initialPlayers) && initialPlayers > 0) {
      const count = Math.min(Number(initialPlayers), maxSeats);
      for (let i = 1; i <= count; i++) {
        seedPlayers.push({ seat: i, nickname: `Player ${i}`, role: null, alive: true });
      }
    } else if (seedPlayers.length > 0) {
      seedPlayers = seedPlayers.map((p, idx) => {
        const seat = typeof p.seat === "number" ? p.seat : idx + 1;
        const nick = typeof p.nickname === "string" && p.nickname.trim().length > 0 ? p.nickname.trim() : `Player ${seat}`;
        return { seat, nickname: nick, role: p.role ?? null, alive: typeof p.alive === "boolean" ? p.alive : true };
      });
    }

    const resolvedConfigType = typeof configType === "string" && ["classic", "custom"].includes(configType)
      ? configType
      : presetKey ? "classic" : "custom";

    let resolvedPlayerCount = Number.isInteger(playerCount)
      ? playerCount
      : seedPlayers.length > 0
      ? seedPlayers.length
      : totalRoles(baseRoles)
      ? totalRoles(baseRoles)
      : seedPlayers.length;

    if (!Number.isInteger(resolvedPlayerCount) || resolvedPlayerCount < 1) {
      throw new HttpError(400, "playerCount must be >= 1");
    }
    if (resolvedPlayerCount > maxSeats) {
      throw new HttpError(400, `playerCount(${resolvedPlayerCount}) exceeds maxSeats(${maxSeats})`);
    }

    const doc = await Room.create({
      name,
      rules,
      maxSeats,
      configType: resolvedConfigType,
      playerCount: resolvedPlayerCount,
      players: seedPlayers,
      status: "init",
      log: [],
      presetKey: presetKey || null,
      rolesConfig: baseRoles,
    });

    injectMeta(doc, mode);
    await doc.save();
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

// Get room
router.get("/:id", async (req, res, next) => {
  try {
    const room = await Room.findById(req.params.id);
    if (!room) throw new HttpError(404, "Room not found");
    injectMeta(room, room.meta?.mode || "flex");
    await room.save();
    res.json(room);
  } catch (err) {
    next(err);
  }
});

// Assign roles and start night
router.post("/:id/assign", async (req, res, next) => {
  try {
    const room = await Room.findById(req.params.id);
    if (!room) throw new HttpError(404, "Room not found");
    if (room.status !== "init") throw new HttpError(409, "Room already started");

    const plainRoles = toPlainRoles(room.rolesConfig);
    const mode = room.meta?.mode || "flex";
    ensureRoomReadyForAssign(room, mode);

    if (mode === "strict") {
      const expectedPlayers = totalRoles(plainRoles);
      if (room.players.length !== expectedPlayers) {
        throw new HttpError(
          409,
          `Strict mode requires exactly ${expectedPlayers} players before assigning roles (got ${room.players.length}).`
        );
      }
    }

    validateRolesAgainstPlayers(plainRoles, room.players.length);
    room.players = assignRolesRandomly(room.players, plainRoles);
    room.status = "night";
    room.lobbyLocked = true;

    injectMeta(room, mode);
    await room.save();
    res.json(room);
  } catch (err) {
    next(err);
  }
});

// Update a player's seat or nickname
router.patch("/:id/players/:seat", async (req, res, next) => {
  try {
    const seat = Number(req.params.seat);
    const { nickname, newSeat } = req.body || {};
    const room = await Room.findById(req.params.id);
    if (!room) throw new HttpError(404, "Room not found");
    if (room.lobbyLocked) throw new HttpError(409, "Lobby is locked");

    const p = room.players.find((x) => x.seat === seat);
    if (!p) throw new HttpError(404, `Seat ${seat} not found`);

    if (typeof newSeat === "number") {
      if (newSeat < 1 || newSeat > room.maxSeats) throw new HttpError(400, "Seat out of range");
      if (room.players.some((x) => x.seat === newSeat)) throw new HttpError(409, "Seat already taken");
      p.seat = newSeat;
    }
    if (typeof nickname === "string") {
      const v = nickname.trim();
      p.nickname = v.length > 0 ? v : `Player ${p.seat}`;
    }

    injectMeta(room, room.meta?.mode || "flex");
    await room.save();
    res.json(room);
  } catch (err) {
    next(err);
  }
});

// Remove a player by seat
router.delete("/:id/players/:seat", async (req, res, next) => {
  try {
    const seat = Number(req.params.seat);
    const room = await Room.findById(req.params.id);
    if (!room) throw new HttpError(404, "Room not found");
    if (room.lobbyLocked) throw new HttpError(409, "Lobby is locked");

    const before = room.players.length;
    room.players = room.players.filter((p) => p.seat !== seat);
    if (room.players.length === before) throw new HttpError(404, "Seat not found");

    injectMeta(room, room.meta?.mode || "flex");
    await room.save();
    res.json(room);
  } catch (err) {
    next(err);
  }
});

// Bulk add N players (auto seats)
router.post("/:id/players/bulk", async (req, res, next) => {
  try {
    const { count = 1 } = req.body || {};
    const room = await Room.findById(req.params.id);
    if (!room) throw new HttpError(404, "Room not found");
    if (room.lobbyLocked) throw new HttpError(409, "Lobby is locked");

    let added = 0;
    for (let i = 0; i < count; i++) {
      if (room.players.length >= room.maxSeats) break;
      const seat = nextAvailableSeat(room.players, room.maxSeats);
      if (!seat) break;
      room.players.push({ seat, nickname: `Player ${seat}`, role: null, alive: true });
      added++;
    }

    injectMeta(room, room.meta?.mode || "flex");
    await room.save();
    res.status(201).json({ room, added });
  } catch (err) {
    next(err);
  }
});

// Add single player
router.post("/:id/players", async (req, res, next) => {
  try {
    const { seat: seatRaw, nickname } = req.body || {};
    const room = await Room.findById(req.params.id);
    if (!room) throw new HttpError(404, "Room not found");
    if (room.lobbyLocked) throw new HttpError(409, "Lobby is locked");

    let seat = typeof seatRaw === "number" ? seatRaw : nextAvailableSeat(room.players, room.maxSeats);
    if (!seat) throw new HttpError(409, "No available seats");
    if (seat < 1 || seat > room.maxSeats) throw new HttpError(400, "Seat out of range");
    if (room.players.some((p) => p.seat === seat)) throw new HttpError(409, "Seat already taken");

    const name = typeof nickname === "string" && nickname.trim().length > 0 ? nickname.trim() : `Player ${seat}`;
    room.players.push({ seat, nickname: name, role: null, alive: true });

    injectMeta(room, room.meta?.mode || "flex");
    await room.save();
    res.status(201).json(room);
  } catch (err) {
    next(err);
  }
});

// Step: actions and phase advance
router.post("/:id/step", async (req, res, next) => {
  try {
    const { actor, actorSeat, action, targetSeat, payload } = req.body || {};
    const room = await Room.findById(req.params.id);
    if (!room) throw new HttpError(404, "Room not found");

    if (actor === "system" && action === "advancePhase") {
      const undo = { snapshot: createUndoSnapshot(room), removeLogCount: 1 };
      room.log.push({
        at: new Date(),
        phase: room.status,
        actor: "system",
        targetSeat: null,
        payload: { action, undo },
        note: "advance"
      });
      room.status = nextPhase(room.status);
      const over = isGameOver(room.players);
      if (over.over) room.status = "end";
      injectMeta(room, room.meta?.mode || "flex");
      await room.save();
      return res.json(room);
    }

    if (actor === "system" && action === "exile") {
      if (typeof targetSeat !== "number") throw new HttpError(400, "targetSeat required for exile");
      const exiled = room.players.find((p) => p.seat === targetSeat);
      if (!exiled) throw new HttpError(404, `座位 ${targetSeat} 未找到`);
      if (!exiled.alive) throw new HttpError(409, `座位 ${targetSeat} 已死亡`);

      const undo = { snapshot: createUndoSnapshot(room), removeLogCount: 1 };
      exiled.alive = false;

      room.log.push({
        at: new Date(),
        phase: room.status,
        actor: "system",
        targetSeat: targetSeat,
        payload: { action, undo },
        note: `放逐 ${targetSeat} 号`
      });

      const over = isGameOver(room.players);
      if (over.over) room.status = "end";

      injectMeta(room, room.meta?.mode || "flex");
      await room.save();
      return res.json(room);
    }

    // For wolf pack convenience, pick a valid werewolf seat if needed
    let seatNum = typeof actorSeat === "number" ? actorSeat : null;
    if (actor === "werewolves") {
      const wolf = room.players.find((p) => p.alive && p.role === "werewolf");
      if (wolf) seatNum = wolf.seat;
    }
    if (seatNum == null) throw new HttpError(400, "actorSeat is required");

    const undo = { snapshot: createUndoSnapshot(room), removeLogCount: 1 };
    performAction(room, {
      actorSeat: seatNum,
      action,
      targetSeat,
      payload: { ...(payload || {}), undo },
    });

    const over = isGameOver(room.players);
    if (over.over) room.status = "end";

    injectMeta(room, room.meta?.mode || "flex");
    await room.save();
    res.json(room);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/undo", async (req, res, next) => {
  try {
    const { eventId } = req.body || {};
    if (!eventId) throw new HttpError(400, "eventId required");
    const room = await Room.findById(req.params.id);
    if (!room) throw new HttpError(404, "Room not found");
    if (!Array.isArray(room.log) || room.log.length === 0) throw new HttpError(409, "No events to undo");

    const last = room.log[room.log.length - 1];
    if (!last || String(last._id) !== String(eventId)) {
      throw new HttpError(409, "Only the latest event can be undone");
    }

    const undo = last?.payload?.undo;
    if (!undo?.snapshot) {
      throw new HttpError(409, "Latest event cannot be safely undone because no snapshot was recorded");
    }

    const removeLogCount = Number.isInteger(undo.removeLogCount) && undo.removeLogCount > 0
      ? undo.removeLogCount
      : 1;

    if (room.log.length < removeLogCount) {
      throw new HttpError(409, "Undo history is incomplete for the latest event");
    }

    restoreRoomSnapshot(room, undo.snapshot);
    room.log.splice(room.log.length - removeLogCount, removeLogCount);

    const restoredMeta = cloneForLog(room.meta || {});
    injectMeta(room, restoredMeta.mode || "flex");
    room.meta = { ...restoredMeta, ...room.meta };

    await room.save();
    res.json(room);
  } catch (err) {
    next(err);
  }
});

export default router;

// Night fast-forward: resolve full night in one pass and provide summary
router.post("/:id/night/resolve", async (req, res, next) => {
  try {
    const room = await Room.findById(req.params.id);
    if (!room) throw new HttpError(404, "Room not found");
    if (room.status !== "night") throw new HttpError(409, "Not in night phase");

    const undoSnapshot = createUndoSnapshot(room);
    const actions = req.body || {};
    const summary = resolveNight(room, actions);

    // Append detailed logs
    const now = new Date();
    const push = (actor, payload, targetSeat, note) => {
      room.log.push({ at: now, phase: room.status, actor, targetSeat: targetSeat ?? null, payload, note });
    };

    let addedLogs = 0;

    if (typeof actions?.guard?.targetSeat === "number") {
      push("guard", { action: "protect" }, actions.guard.targetSeat, `守卫守护 ${actions.guard.targetSeat}`);
      addedLogs++;
    }
    if (typeof actions?.wolves?.targetSeat === "number") {
      push("werewolf", { action: "kill" }, actions.wolves.targetSeat, `狼人击杀目标 ${actions.wolves.targetSeat}`);
      addedLogs++;
    }
    if (typeof actions?.seer?.targetSeat === "number") {
      const t = room.players.find((p) => p.seat === actions.seer.targetSeat);
      const isWolf = t?.role === "werewolf";
      push("seer", { action: "check" }, actions.seer.targetSeat, `预言家查验 ${actions.seer.targetSeat}=${isWolf ? "狼人" : "好人"}`);
      addedLogs++;
    }
    if (typeof actions?.witch?.healTargetSeat === "number") {
      push("witch", { action: "heal" }, actions.witch.healTargetSeat, `女巫救起 ${actions.witch.healTargetSeat}`);
      addedLogs++;
    }
    if (typeof actions?.witch?.poisonTargetSeat === "number") {
      push("witch", { action: "poison" }, actions.witch.poisonTargetSeat, `女巫毒杀 ${actions.witch.poisonTargetSeat}`);
      addedLogs++;
    }

    // Night summary
    room.log.push({
      at: new Date(),
      phase: room.status,
      actor: "system",
      targetSeat: null,
      payload: {
        action: "nightSummary",
        summary,
        undo: {
          snapshot: undoSnapshot,
          removeLogCount: addedLogs + 1,
        },
      },
      note: "夜晚结算"
    });

    const over = isGameOver(room.players);
    if (over.over) {
      room.status = "end";
      room.meta = { ...(room.meta || {}), winner: over.winner };
    } else if (actions?.advanceToDay) {
      room.status = "day";
    }

    injectMeta(room, room.meta?.mode || "flex");
    await room.save();
    res.json({ room, summary });
  } catch (err) {
    next(err);
  }
});
