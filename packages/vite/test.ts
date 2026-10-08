import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "vite";
import inkan from "./index.js";

// a copy of the fixture next to this file, so "@vxnsin/inkan" resolves from node_modules
const root = mkdtempSync(join(import.meta.dirname, ".tmp-"));
cpSync(join(import.meta.dirname, "fixture"), root, { recursive: true });

test("the API runs inside vite dev, on Vite's port, and a save reloads it", { timeout: 60_000 }, async () => {
  const server = await createServer({ root, configFile: false, logLevel: "silent", server: { port: 0, host: "127.0.0.1" }, plugins: [inkan({ entry: "app.ts" })] });
  try {
    await server.listen();
    const base = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;

    assert.deepEqual(await (await fetch(`${base}/api/hello`)).json(), { hello: "world" });
    const bad = await fetch(`${base}/api/teas`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":""}' });
    assert.equal(bad.status, 400, "the contract holds under Vite");
    assert.equal((await fetch(`${base}/api/docs`)).status, 200);
    assert.equal((await fetch(`${base}/api/_inkan`)).status, 200, "the inspector answers on localhost");
    assert.match(await (await fetch(`${base}/`)).text(), /the frontend/, "everything else is still Vite's");

    const file = join(root, "app.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace('hello: "world"', 'hello: "again"'));
    let body: unknown;
    for (let i = 0; i < 50; i++) {
      body = await (await fetch(`${base}/api/hello`)).json();
      if ((body as { hello: string }).hello === "again") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(body, { hello: "again" }, "a save gives the next request a fresh app");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an entry that exports no app says so", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(import.meta.dirname, ".tmp-"));
  writeFileSync(join(dir, "app.ts"), "export const nothing = 1;\n");
  const server = await createServer({ root: dir, configFile: false, logLevel: "silent", server: { port: 0, host: "127.0.0.1" }, plugins: [inkan({ entry: "app.ts" })] });
  try {
    await server.listen();
    const base = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
    const r = await fetch(`${base}/api/hello`);
    assert.equal(r.status, 500);
    assert.match(await r.text(), /has to export the app/);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
