import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createLogger, createServer, preview } from "vite";
import inkan from "./index.js";

// a copy of the fixture next to this file, so "@vxnsin/inkan" resolves from node_modules
const root = mkdtempSync(join(import.meta.dirname, ".tmp-"));
cpSync(join(import.meta.dirname, "fixture"), root, { recursive: true });
const events = () => ((globalThis as { inkanEvents?: string[] }).inkanEvents ??= []);

// a logger that keeps what Vite and the plugin print
function keeping() {
  const lines: string[] = [];
  const logger = createLogger("info");
  logger.info = (msg) => void lines.push(msg.replace(/\x1b\[\d+m/g, ""));
  return { logger, lines };
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`waited for ${what}`);
}

test("the API runs inside vite dev, on Vite's port, and a save reloads it", { timeout: 60_000 }, async () => {
  events().length = 0;
  const { logger, lines } = keeping();
  const server = await createServer({ root, configFile: false, customLogger: logger, server: { port: 0, host: "127.0.0.1" }, plugins: [inkan({ entry: "app.ts" })] });
  try {
    await server.listen();
    const base = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;

    assert.deepEqual(await (await fetch(`${base}/api/hello`)).json(), { hello: "world" });
    const bad = await fetch(`${base}/api/teas`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":""}' });
    assert.equal(bad.status, 400, "the contract holds under Vite");
    assert.equal((await fetch(`${base}/api/docs`)).status, 200);
    assert.equal((await fetch(`${base}/api/_inkan`)).status, 200, "the inspector answers on localhost");
    assert.match(await (await fetch(`${base}/`)).text(), /the frontend/, "everything else is still Vite's");
    assert.deepEqual(events(), ["listen world"], "onListen ran once, for the first request");

    server.printUrls();
    await until(() => lines.some((l) => l.includes("API docs:")), "the links");
    assert.ok(lines.some((l) => /API docs:\s+http:\/\/127\.0\.0\.1:\d+\/api\/docs/.test(l)));
    assert.ok(lines.some((l) => /Inspector:\s+http:\/\/127\.0\.0\.1:\d+\/api\/_inkan/.test(l)));

    const file = join(root, "app.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace('"world"', '"again"'));
    await until(async () => ((await (await fetch(`${base}/api/hello`)).json()) as { hello: string }).hello === "again", "a fresh app after the save");
    assert.deepEqual(events(), ["listen world", "close world", "listen again"], "the old app closed, the fresh one started");
  } finally {
    await server.close();
  }
  await until(() => events().at(-1) === "close again", "onClose when Vite stops");
});

test("an entry that exports no app says so, in the answer and in Vite's overlay", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(import.meta.dirname, ".tmp-"));
  writeFileSync(join(dir, "app.ts"), "export const nothing = 1;\n");
  const server = await createServer({ root: dir, configFile: false, logLevel: "silent", server: { port: 0, host: "127.0.0.1" }, plugins: [inkan({ entry: "app.ts" })] });
  const sent: { type: string; err?: { message: string; plugin?: string } }[] = [];
  server.ws.send = ((payload: (typeof sent)[number]) => void sent.push(payload)) as typeof server.ws.send;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
    const r = await fetch(`${base}/api/hello`);
    assert.equal(r.status, 500);
    assert.match(await r.text(), /has to export the app/);
    const overlay = sent.find((p) => p.type === "error");
    assert.ok(overlay, "the overlay heard of it");
    assert.equal(overlay.err?.plugin, "inkan");
    assert.match(overlay.err?.message ?? "", /has to export the app/);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vite preview serves the API next to the built frontend", { timeout: 60_000 }, async () => {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.html"), "<!doctype html><p>the built frontend</p>");
  const server = await preview({ root, configFile: false, logLevel: "silent", preview: { port: 0, host: "127.0.0.1" }, plugins: [inkan({ entry: "app.ts" })] });
  try {
    const base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
    assert.equal(((await (await fetch(`${base}/api/hello`)).json()) as { hello: string }).hello, "again", "the app, loaded by Node itself");
    assert.match(await (await fetch(`${base}/`)).text(), /the built frontend/);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
