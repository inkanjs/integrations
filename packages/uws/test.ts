// The same requests every way of serving inkan has to answer alike, on uWebSockets.js, and
// what only this adapter does: closing gently, and HTTPS. uWebSockets.js is installed on
// purpose, from GitHub (see README); without it this test is skipped, unless REQUIRE_UWS
// says it has to run, as it does in CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inkan, sse } from "@vxnsin/inkan";
import { conformance } from "./conformance.ts";

let installed = true;
try {
  createRequire(import.meta.url).resolve("uWebSockets.js");
} catch {
  installed = false;
}

if (installed) {
  const { serve } = await import("./index.js");
  conformance("uWebSockets.js (@inkanjs/uws)", async (app) => {
    const server = await serve(app, { port: 0, host: "127.0.0.1" });
    return { url: server.url, close: () => server.close() };
  });

  test("close() lets an open request finish, ends the streams, then runs onClose", { timeout: 20_000 }, async () => {
    const events: string[] = [];
    const app = inkan({ log: false, gracefulShutdown: false })
      .get("/slow", async () => {
        await new Promise((r) => setTimeout(r, 300));
        events.push("answered");
        return { slow: true };
      })
      .get("/ticks", () =>
        sse(async function* () {
          for (let i = 0; ; i++) {
            yield { data: i };
            await new Promise((r) => setTimeout(r, 20));
          }
        }),
      )
      .onClose(() => void events.push("onClose"));
    const server = await serve(app, { port: 0, host: "127.0.0.1" });
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const ticks = await fetch(`${server.url}/ticks`);
    const reader = ticks.body!.getReader();
    await reader.read();
    const slow = fetch(`${server.url}/slow`);
    await new Promise((r) => setTimeout(r, 50)); // the slow request is in

    const started = Date.now();
    await server.close();
    events.push("closed");
    assert.ok(Date.now() - started < 5_000, "it did not wait for the endless stream");
    assert.deepEqual(await (await slow).json(), { slow: true });
    while (!(await reader.read()).done); // the stream got a clean end
    assert.deepEqual(events, ["answered", "onClose", "closed"]);
    await assert.rejects(fetch(`${server.url}/slow`), "and no longer takes requests");
  });

  test("SIGTERM closes it and exits", { timeout: 20_000, skip: process.platform === "win32" && "Windows has no SIGTERM to send" }, async () => {
    const script = `
      import { inkan } from "@vxnsin/inkan";
      import { serve } from ${JSON.stringify(new URL("./index.js", import.meta.url).href)};
      const app = inkan({ log: false }).get("/", () => ({})).onClose(() => console.log("onClose"));
      const server = await serve(app, { port: 0, host: "127.0.0.1" });
      console.log("ready");`;
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: import.meta.dirname });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    while (!out.includes("ready")) await new Promise((r) => setTimeout(r, 20));
    child.kill("SIGTERM");
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 0);
    assert.match(out, /onClose/);
  });

  test("tls serves HTTPS", { timeout: 20_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "inkan-uws-"));
    const key = join(dir, "key.pem");
    const cert = join(dir, "cert.pem");
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    } catch {
      rmSync(dir, { recursive: true, force: true });
      return t.skip("openssl is not here to make a certificate");
    }
    const app = inkan({ log: false, gracefulShutdown: false }).get("/hello", () => ({ hello: "tls" }));
    const server = await serve(app, { port: 0, host: "127.0.0.1", tls: { key, cert } });
    try {
      assert.match(server.url, /^https:/);
      const body = await new Promise<string>((resolve, reject) =>
        get(`${server.url}/hello`, { rejectUnauthorized: false }, (res) => {
          let s = "";
          res.on("data", (c) => (s += c));
          res.on("end", () => resolve(s));
        }).on("error", reject),
      );
      assert.deepEqual(JSON.parse(body), { hello: "tls" });
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
} else if (process.env.REQUIRE_UWS) {
  throw new Error("uWebSockets.js is not installed, and REQUIRE_UWS says this test has to run");
} else {
  test("uWebSockets.js (@inkanjs/uws)", { skip: "uWebSockets.js is not installed: see packages/uws/README.md" }, () => {});
}
