import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const baseUrl = process.env.BACKEND_BASE_URL || "http://localhost:3000";
const timeoutMs = Number.parseInt(process.env.FLOW_SERVER_TIMEOUT_MS || "30000", 10);
const stdoutPath = join(rootDir, "verify-server.out.log");
const stderrPath = join(rootDir, "verify-server.err.log");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isBackendReady() {
  try {
    const response = await fetch(new URL("/", baseUrl));
    if (!response.ok) return false;
    const data = await response.json();
    return data?.ok === true;
  } catch {
    return false;
  }
}

function pipeLog(path, label) {
  if (!existsSync(path)) {
    console.error(`[verify] ${label}: <missing>`);
    return;
  }

  console.error(`\n[verify] ${label}:`);
  createReadStream(path).pipe(process.stderr);
}

async function waitForBackend(child) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isBackendReady()) return true;
    if (child?.exitCode != null) return false;
    await sleep(1000);
  }

  return false;
}

function startBackend() {
  const stdout = createWriteStream(stdoutPath, { flags: "w" });
  const stderr = createWriteStream(stderrPath, { flags: "w" });
  const child = spawn(process.execPath, ["app.js"], {
    cwd: rootDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  return child;
}

async function stopBackend(child) {
  if (!child || child.exitCode != null) return;

  child.kill();
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(5000).then(() => false),
  ]);

  if (!exited && child.exitCode == null) {
    child.kill("SIGKILL");
  }
}

function runFlowTest() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["./scripts/happy-path-flow.js"], {
      cwd: rootDir,
      env: { ...process.env, BACKEND_BASE_URL: baseUrl },
      stdio: "inherit",
      windowsHide: true,
    });

    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  let spawnedBackend = null;

  try {
    if (await isBackendReady()) {
      console.log(`[verify] Backend already reachable at ${baseUrl}`);
    } else {
      console.log(`[verify] Starting backend in background at ${baseUrl}`);
      spawnedBackend = startBackend();

      const ready = await waitForBackend(spawnedBackend);
      if (!ready) {
        console.error(`[verify] Backend was not reachable within ${timeoutMs}ms`);
        pipeLog(stdoutPath, "verify-server.out.log");
        pipeLog(stderrPath, "verify-server.err.log");
        process.exitCode = 1;
        return;
      }
    }

    const flowExitCode = await runFlowTest();
    process.exitCode = flowExitCode;
  } finally {
    await stopBackend(spawnedBackend);
  }
}

main().catch(async (error) => {
  console.error(`[verify] ${error.message}`);
  process.exitCode = 1;
});
