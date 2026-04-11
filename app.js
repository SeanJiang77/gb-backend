import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import roomsRouter from "./routes/rooms.js";

import { registerRole } from "./engine/registry.js";
import { Werewolf }  from "./roles/Werewolf.js";
import { Seer }      from "./roles/Seer.js";
import { Witch }     from "./roles/Witch.js";
import { Guard }     from "./roles/Guard.js";
import { Villager }  from "./roles/Villager.js";

registerRole(Werewolf);
registerRole(Seer);
registerRole(Witch);
registerRole(Guard);
registerRole(Villager);

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/rooms", roomsRouter);

// 错误处理
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Server Error" });
});

function buildMongoUri(env) {
  if (env.MONGO_URI) return env.MONGO_URI;

  const {
    MONGO_SCHEME = "mongodb+srv",
    MONGO_USER,
    MONGO_PASS,
    MONGO_HOST,
    MONGO_DB = "godsbooklet",
    MONGO_OPTIONS = "retryWrites=true&w=majority&appName=GodsBooklet",
  } = env;

  if (!MONGO_USER || !MONGO_PASS || !MONGO_HOST) {
    return "mongodb://127.0.0.1:27017/godsbooklet";
  }

  const encodedUser = encodeURIComponent(MONGO_USER);
  const encodedPass = encodeURIComponent(MONGO_PASS);
  const query = MONGO_OPTIONS ? `?${MONGO_OPTIONS}` : "";

  return `${MONGO_SCHEME}://${encodedUser}:${encodedPass}@${MONGO_HOST}/${MONGO_DB}${query}`;
}

// 从 .env 读取
const { PORT = 3000 } = process.env;
const MONGO_URI = buildMongoUri(process.env);

console.log("Mongo URI loaded from environment");

mongoose
  .connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API listening on http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error("Mongo connection failed:", e);
    process.exit(1);
  });
  
