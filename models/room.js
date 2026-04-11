// backend/models/room.js
import mongoose from "mongoose";

const { Schema, SchemaTypes } = mongoose;

const PlayerSchema = new Schema(
  {
    // Display name shown in the lobby / table
    nickname: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 40,
    },
    // Optional seat index, 1-based
    seat: { type: Number, min: 1, required: true },
    // Final assigned role after dealing
    role: { type: String, default: null },
    // Alive state
    alive: { type: Boolean, default: true },
    // Guard flag (night protection), transient but persisted for simplicity
    _guarded: { type: Boolean, default: false },
    // Link to user account (optional)
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

const EventSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    phase: { type: String, default: "init" },
    actor: { type: String },
    targetSeat: { type: Number, default: null },
    payload: { type: SchemaTypes.Mixed, default: {} },
    note: { type: String, default: "" },
  },
  { _id: true }
);

const RoomSchema = new Schema(
  {
    // Basic
    name: { type: String, default: "" },
    rules: { type: SchemaTypes.Mixed, default: {} },
    maxSeats: { type: Number, required: true, min: 1, max: 50 },
    lobbyLocked: { type: Boolean, default: false },
    status: { type: String, enum: ["init", "night", "day", "vote", "end"], default: "init" },

    // Config summary
    configType: { type: String, enum: ["classic", "custom"], required: true },
    playerCount: { type: Number, required: true, min: 1, max: 50 },
    presetKey: { type: String, default: null },

    // Roles configuration (prefer rolesConfig for this project)
    roles: {
      type: Map,
      of: Number,
      default: {},
      validate: {
        validator(v) {
          return Array.from(v.values()).every((n) => Number.isInteger(n) && n >= 0);
        },
        message: "All role counts must be non-negative integers.",
      },
    },
    rolesConfig: {
      type: Map,
      of: Number,
      default: {},
    },

    // Players and log
    players: { type: [PlayerSchema], default: [] },
    log: { type: [EventSchema], default: [] },

    // Computed meta snapshot stored on read
    meta: { type: SchemaTypes.Mixed, default: {} },
  },
  { timestamps: true }
);

export default mongoose.model("Room", RoomSchema);
