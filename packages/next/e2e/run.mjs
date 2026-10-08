// The package inside a real Next.js: `next build`, then `next start`, then requests against
// the App Router, the Pages Router and a Server Component. Next is not a dependency of this
// repository; CI installs it for this run. Without it this is skipped, unless REQUIRE_NEXT
// says it has to run.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dirname;
let bin;
try {
  bin = join(createRequire(join(dir, "x.js")).resolve("next/package.json"), "..", "dist", "bin", "next");
} catch {
  if (process.env.REQUIRE_NEXT) throw new Error("next is not installed, and REQUIRE_NEXT says this has to run");
  console.log("skipped: next is not installed (npm install --no-save next react react-dom)");
  process.exit(0);
}

const next = (args, opts = {}) => spawn(process.execPath, [bin, ...args], { cwd: dir, stdio: opts.stdio ?? "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
const exited = (child) => new Promise((resolve) => child.on("exit", resolve));

rmSync(join(dir, ".next"), { recursive: true, force: true });
assert.equal(await exited(next(["build"])), 0, "next build");

const port = 3000 + Math.floor(Math.random() * 1000);
const server = next(["start", "-p", String(port), "-H", "127.0.0.1"], { stdio: "pipe" });
let log = "";
server.stdout.on("data", (c) => (log += c));
server.stderr.on("data", (c) => (log += c));
const base = `http://127.0.0.1:${port}`;
try {
  for (let i = 0; ; i++) {
    try {
      await fetch(base);
      break;
    } catch {
      if (i > 150) throw new Error(`next start did not come up:\n${log}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const json = { "content-type": "application/json" };
  for (const prefix of ["/app-api", "/api"]) {
    const r = await fetch(`${base}${prefix}/teas/7`);
    assert.equal(r.status, 200, `${prefix}: a route`);
    assert.deepEqual(await r.json(), { id: 7, name: "Sencha" }, `${prefix}: trimmed to its contract`);
    const ok = await fetch(`${base}${prefix}/teas`, { method: "POST", headers: json, body: '{"name":"Mio"}' });
    assert.equal(ok.status, 201, `${prefix}: a body`);
    const bad = await fetch(`${base}${prefix}/teas`, { method: "POST", headers: json, body: '{"name":""}' });
    assert.equal(bad.status, 400, `${prefix}: the contract holds`);
    assert.equal(bad.headers.get("content-type"), "application/problem+json");
  }
  assert.equal((await fetch(`${base}/app-api/docs`)).status, 200, "the docs page");
  assert.match(await (await fetch(base)).text(), /tea 3: Sencha/, "a Server Component asked the API through direct()");
  console.log("next e2e: App Router, Pages Router and direct() answer in a real next start");
} finally {
  server.kill();
}
