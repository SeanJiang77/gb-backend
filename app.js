import "dotenv/config";
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

const app = express();
app.use(express.json());

const allowedOrigin = process.env.CORS_ORIGIN || "*";
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
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