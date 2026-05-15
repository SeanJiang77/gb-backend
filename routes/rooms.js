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

function normalizeSeatList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(Number).filter(Number.isInteger))].sort((a, b) => a - b)
    : [];
}

function tallyVoteRecords(records = {}, allowedTargets = null, options = {}) {
  const tally = new Map();
  const allowed = allowedTargets ? new Set(allowedTargets) : null;
  const aliveSeats = options.aliveSeats ? new Set(options.aliveSeats) : null;
  const excludedVoterSeats = options.excludedVoterSeats ? new Set(options.excludedVoterSeats) : null;

  for (const [voterRaw, targetRaw] of Object.entries(records || {})) {
    const voterSeat = Number(voterRaw);
    const targetSeat = Number(targetRaw);
    if (!Number.isInteger(voterSeat) || !Number.isInteger(targetSeat)) {
      throw new HttpError(400, "Vote records must map voter seats to target seats");
    }
    if (aliveSeats && !aliveSeats.has(voterSeat)) {
      throw new HttpError(409, `Vote voter ${voterSeat} is not alive`);
    }
    if (aliveSeats && !aliveSeats.has(targetSeat)) {
      throw new HttpError(409, `Vote target ${targetSeat} is not alive`);
    }
    if (excludedVoterSeats && excludedVoterSeats.has(voterSeat)) {
      throw new HttpError(409, `Vote voter ${voterSeat} is not eligible in this vote`);
    }
    if (voterSeat === targetSeat) {
      throw new HttpError(409, "Vote voter cannot vote for self");
    }
    if (allowed && !allowed.has(targetSeat)) {
      throw new HttpError(409, `Vote target ${targetSeat} is not eligible in this round`);
    }
    tally.set(targetSeat, (tally.get(targetSeat) || 0) + 1);
  }

  return [...tally.entries()]
    .map(([seat, count]) => ({ seat, count }))
    .sort((a, b) => b.count - a.count || a.seat - b.seat);
}

function topTiedSeats(tally) {
  if (!tally.length) throw new HttpError(400, "No votes to resolve");
  const maxVotes = tally[0].count;
  return tally.filter((item) => item.count === maxVotes).map((item) => item.seat).sort((a, b) => a - b);
}

function setVoteState(room, voteState) {
  room.meta = { ...(room.meta || {}), voteState };
}

function setSheriffState(room, { sheriffSeat = null, noSheriff = false, electionCompleted = false } = {}) {
  room.meta = {
    ...(room.meta || {}),
    sheriffSeat,
    noSheriff,
    sheriffElectionCompleted: electionCompleted,
    sheriffTransferRequired: false,
    deadSheriffSeat: null,
  };
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
  const persistedSheriffSeat = Number.isInteger(prevMeta.sheriffSeat) ? prevMeta.sheriffSeat : null;
  const noSheriff = prevMeta.noSheriff === true;
  const sheriffElectionCompleted = prevMeta.sheriffElectionCompleted === true || persistedSheriffSeat != null || noSheriff;
  const sheriffPlayer = persistedSheriffSeat == null ? null : room.players.find((p) => p.seat === persistedSheriffSeat);
  const sheriffTransferRequired = persistedSheriffSeat != null && sheriffPlayer?.alive === false;

  room.meta = {
    ...prevMeta,
    sheriffSeat: persistedSheriffSeat,
    noSheriff,
    sheriffElectionCompleted,
    sheriffTransferRequired,
    deadSheriffSeat: sheriffTransferRequired ? persistedSheriffSeat : null,
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

function roomWithComputedMeta(room) {
  const data = room.toObject ? room.toObject() : cloneForLog(room);
  injectMeta(data, data.meta?.mode || "flex");
  return data;
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
    res.json(roomWithComputedMeta(room));
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
      if (room.status === "vote") {
        throw new HttpError(409, "Resolve exile vote before advancing from vote phase");
      }

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
      if (room.status === "vote") {
        throw new HttpError(409, "Resolve exile vote through /vote/resolve");
      }
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

router.post("/:id/vote/resolve", async (req, res, next) => {
  try {
    const { type = "exile", records = {}, candidates = [] } = req.body || {};
    const room = await Room.findById(req.params.id);
    if (!room) throw new HttpError(404, "Room not found");
    if (!["exile", "sheriff"].includes(type)) throw new HttpError(400, "Invalid vote type");

    const previous = room.meta?.voteState || null;
    const round = previous?.type === type && previous?.round === 2 && previous?.awaitingResolution ? 2 : 1;
    const tiedTargets = normalizeSeatList(previous?.tiedTargetSeats);
    const candidateSeats = normalizeSeatList(candidates);
    const allowedTargets = round === 2 ? tiedTargets : type === "sheriff" ? candidateSeats : null;

    if (type === "exile" && room.status !== "vote") {
      throw new HttpError(409, "Exile vote can only be resolved in vote phase");
    }
    if (type === "sheriff" && room.status !== "day") {
      throw new HttpError(409, "Sheriff vote can only be resolved in day phase");
    }
    if (type === "sheriff" && round === 1 && candidateSeats.length === 0) {
      throw new HttpError(400, "Sheriff candidates are required");
    }
    if (round === 2 && tiedTargets.length === 0) {
      throw new HttpError(409, "Second-round vote state is missing tied targets");
    }

    const aliveSeats = room.players.filter((player) => player.alive).map((player) => player.seat);
    const aliveSeatSet = new Set(aliveSeats);
    const invalidAllowedTarget = (allowedTargets || []).find((seat) => !aliveSeatSet.has(seat));
    if (invalidAllowedTarget != null) {
      throw new HttpError(409, `Vote target ${invalidAllowedTarget} is not alive`);
    }
    const sheriffVoterExclusions = type === "sheriff" ? (round === 2 ? tiedTargets : candidateSeats) : [];
    const tally = tallyVoteRecords(records, allowedTargets, {
      aliveSeats,
      excludedVoterSeats: sheriffVoterExclusions,
    });
    const winners = topTiedSeats(tally);
    const undo = { snapshot: createUndoSnapshot(room), removeLogCount: 1 };

    if (winners.length === 1) {
      if (type === "exile") {
        const exiled = room.players.find((p) => p.seat === winners[0]);
        if (!exiled) throw new HttpError(404, `Seat ${winners[0]} not found`);
        if (!exiled.alive) throw new HttpError(409, `Seat ${winners[0]} is already dead`);

        exiled.alive = false;
        const over = isGameOver(room.players);
        room.status = over.over ? "end" : "night";
        setVoteState(room, {
          type,
          round,
          tiedTargetSeats: [],
          awaitingResolution: false,
          outcome: "exiled",
          resolvedSeat: winners[0],
        });
        if (over.over) room.meta.winner = over.winner;

        room.log.push({
          at: new Date(),
          phase: "vote",
          actor: "system",
          targetSeat: winners[0],
          payload: { action: "resolveExileVote", records, tally, round, undo },
          note: `放逐 ${winners[0]} 号`,
        });
      } else {
        setSheriffState(room, {
          sheriffSeat: winners[0],
          noSheriff: false,
          electionCompleted: true,
        });
        setVoteState(room, {
          type,
          round,
          tiedTargetSeats: [],
          awaitingResolution: false,
          outcome: "sheriff-elected",
          resolvedSeat: winners[0],
        });
        room.log.push({
          at: new Date(),
          phase: room.status,
          actor: "system",
          targetSeat: winners[0],
          payload: { action: "resolveSheriffVote", records, tally, round, undo },
          note: `警长 ${winners[0]} 号当选`,
        });
      }
    } else if (round === 1) {
      setVoteState(room, {
        type,
        round: 2,
        tiedTargetSeats: winners,
        awaitingResolution: true,
        outcome: "tie",
      });
      room.log.push({
        at: new Date(),
        phase: room.status,
        actor: "system",
        targetSeat: null,
        payload: { action: type === "exile" ? "exileVoteTie" : "sheriffVoteTie", records, tally, round, undo },
        note: `${winners.join("、")} 号平票，进入第二轮`,
      });
    } else {
      const phaseBeforeResolution = room.status;
      if (type === "sheriff") {
        setSheriffState(room, {
          sheriffSeat: null,
          noSheriff: true,
          electionCompleted: true,
        });
      }
      setVoteState(room, {
        type,
        round,
        tiedTargetSeats: [],
        awaitingResolution: false,
        outcome: type === "exile" ? "no-exile" : "no-sheriff",
      });
      if (type === "exile") room.status = "night";
      room.log.push({
        at: new Date(),
        phase: phaseBeforeResolution,
        actor: "system",
        targetSeat: null,
        payload: { action: type === "exile" ? "noExileAfterTie" : "noSheriffAfterTie", records, tally, round, undo },
        note: type === "exile" ? "第二轮仍平票，本轮无人放逐" : "第二轮仍平票，本局无警长",
      });
    }

    injectMeta(room, room.meta?.mode || "flex");
    await room.save();
    res.json(room);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/sheriff/transfer", async (req, res, next) => {
  try {
    const { targetSeat, tearBadge = false } = req.body || {};
    const room = await Room.findById(req.params.id);
    if (!room) throw new HttpError(404, "Room not found");

    injectMeta(room, room.meta?.mode || "flex");
    const deadSheriffSeat = room.meta?.deadSheriffSeat;
    if (room.meta?.sheriffTransferRequired !== true || !Number.isInteger(deadSheriffSeat)) {
      throw new HttpError(409, "Sheriff badge transfer is not required");
    }

    const undo = { snapshot: createUndoSnapshot(room), removeLogCount: 1 };

    if (tearBadge === true) {
      setSheriffState(room, {
        sheriffSeat: null,
        noSheriff: true,
        electionCompleted: true,
      });
      room.log.push({
        at: new Date(),
        phase: room.status,
        actor: "system",
        targetSeat: null,
        payload: { action: "tearSheriffBadge", deadSheriffSeat, undo },
        note: "警徽撕毁，本局无警长",
      });
    } else {
      if (!Number.isInteger(targetSeat)) {
        throw new HttpError(400, "targetSeat required for sheriff badge transfer");
      }
      if (targetSeat === deadSheriffSeat) {
        throw new HttpError(409, "Cannot transfer sheriff badge to the dead sheriff");
      }
      const target = room.players.find((player) => player.seat === targetSeat);
      if (!target) throw new HttpError(404, `Seat ${targetSeat} not found`);
      if (!target.alive) throw new HttpError(409, `Seat ${targetSeat} is not alive`);

      setSheriffState(room, {
        sheriffSeat: targetSeat,
        noSheriff: false,
        electionCompleted: true,
      });
      room.log.push({
        at: new Date(),
        phase: room.status,
        actor: "system",
        targetSeat,
        payload: { action: "transferSheriffBadge", deadSheriffSeat, undo },
        note: `警徽移交给 ${targetSeat} 号`,
      });
    }

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
