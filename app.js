import dotenv from "dotenv";
import express from "express";
import mongoose from "mongoose";
import roomsRouter from "./routes/rooms.js";

import { registerRole } from "./engine/registry.js";
import { Werewolf } from "./roles/Werewolf.js";
import { Seer } from "./roles/Seer.js";
import { Witch } from "./roles/Witch.js";
import { Guard } from "./roles/Guard.js";
import { Villager } from "./roles/Villager.js";

registerRole(Werewolf);
registerRole(Seer);
registerRole(Witch);
registerRole(Guard);
registerRole(Villager);

// Load local .env for development. Existing process.env values still win in production.
dotenv.config();

function parseAllowedOrigins(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function createOriginMatcher(entries) {
  const exact = new Set();
  const wildcardPatterns = [];

  for (const entry of entries) {
    if (entry.includes("*")) {
      const escaped = entry
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      wildcardPatterns.push(new RegExp(`^${escaped}$`));
      continue;
    }
    exact.add(entry);
  }

  return (origin) => exact.has(origin) || wildcardPatterns.some((pattern) => pattern.test(origin));
}

const app = express();
app.use(express.json());

// Prefer multi-origin envs; keep CORS_ORIGIN as a backward-compatible single-origin fallback.
const configuredOriginSource = process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGINS || process.env.CORS_ORIGIN;
const configuredOrigins = parseAllowedOrigins(configuredOriginSource);
const isOriginAllowed = createOriginMatcher(configuredOrigins);

app.use((req, res, next) => {
  res.setHeader("Vary", "Origin");

  const requestOrigin = req.headers.origin;
  if (requestOrigin && isOriginAllowed(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
  }

  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "godsbooklet-backend" });
});

app.use("/rooms", roomsRouter);

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  console.error("Request failed:", err);
  res.status(status).json({ error: err.message || "Server Error" });
});

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

async function start() {
  try {
    if (!MONGO_URI) {
      throw new Error("Missing MONGO_URI");
    }

    console.log(`Starting API on port ${PORT}`);
    console.log("Mongo config mode: MONGO_URI");
    console.log(
      configuredOrigins.length
        ? `CORS allowed origins: ${configuredOrigins.join(", ")}`
        : "CORS allowed origins: none configured"
    );

    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
    });
    console.log("MongoDB connected");

    app.listen(PORT, () => {
      console.log(`API listening on port ${PORT}`);
    });
  } catch (e) {
    console.error("Startup failed:", e);
    process.exit(1);
  }
}

start();
