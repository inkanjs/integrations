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
import { inkan, sse, t } from "@vxnsin/inkan";
import { conformance } from "./conformance.ts";

/** A request body sent in pieces, chunked, with no length declared. */
function streamOf(pieces: Iterable<string> | AsyncIterable<string>): ReadableStream<Uint8Array> {
  const it = (async function* () {
    yield* pieces;
  })();
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(c) {
      const next = await it.next();
      if (next.done) c.close();
      else c.enqueue(encoder.encode(next.value));
    },
  });
}

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

  test("a route's own bodyLimit holds: 413 past it, declared or chunked", { timeout: 20_000 }, async () => {
    const app = inkan({ log: false, gracefulShutdown: false })
      .post("/small", { bodyLimit: 10 }, ({ body }) => ({ got: body }))
      .post("/any", ({ body }) => ({ got: body }));
    const server = await serve(app, { port: 0, host: "127.0.0.1" });
    try {
      const big = JSON.stringify({ name: "x".repeat(40) });
      const declared = await fetch(`${server.url}/small`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
      assert.equal(declared.status, 413);
      assert.match(declared.headers.get("content-type") ?? "", /application\/problem\+json/);
      assert.deepEqual(await declared.json(), {
        type: "body-too-large",
        title: "Payload Too Large",
        status: 413,
        detail: "Request bodies may be at most 10 bytes",
        instance: "/small",
      });
      const chunked = await fetch(`${server.url}/small`, { method: "POST", headers: { "content-type": "application/json" }, body: streamOf([big.slice(0, 20), big.slice(20)]), duplex: "half" } as RequestInit);
      assert.equal(chunked.status, 413);
      const other = await fetch(`${server.url}/any`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
      assert.equal(other.status, 200, "the app's limit still holds for the other routes");
    } finally {
      await server.close();
    }
  });

  test("a t.stream() route gets its body unread, as it arrives", { timeout: 20_000 }, async () => {
    // the client sends its second piece only once the handler has read the first: an adapter
    // that waited for the whole body would never answer
    let firstRead!: () => void;
    const first = new Promise<void>((resolve) => (firstRead = resolve));
    const app = inkan({ log: false, gracefulShutdown: false, bodyLimit: 10 })
      .post("/upload", { body: t.stream() }, async ({ body }) => {
        assert.ok(!Buffer.isBuffer(body), "not buffered");
        let bytes = 0;
        for await (const chunk of body) {
          bytes += chunk.length;
          firstRead();
        }
        return { bytes };
      })
      .post("/capped", { body: t.stream().max(100) }, async ({ body }) => {
        for await (const _ of body);
        return { read: true };
      });
    const server = await serve(app, { port: 0, host: "127.0.0.1" });
    try {
      async function* pieces() {
        yield "a".repeat(5000);
        await first;
        yield "b".repeat(5000);
      }
      const r = await fetch(`${server.url}/upload`, { method: "POST", body: streamOf(pieces()), duplex: "half" } as RequestInit);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { bytes: 10_000 }, "past the app's limit of 10: a stream has its own");
      const capped = await fetch(`${server.url}/capped`, { method: "POST", body: streamOf(["c".repeat(80), "c".repeat(80)]), duplex: "half" } as RequestInit);
      assert.equal(capped.status, 413, "t.stream().max() holds while it is read");
      const declared = await fetch(`${server.url}/capped`, { method: "POST", body: "c".repeat(200) });
      assert.equal(declared.status, 413, "and a declared length past it is not read at all");
    } finally {
      await server.close();
    }
  });

  // cookies on AdapterResponse came with inkan 0.6.0: an older one has nothing to write
  const probe = await inkan({ log: false })
    .get("/", (ctx) => ((ctx as unknown as { setCookie?: (n: string, v: string) => void }).setCookie?.("a", "1"), {}))
    .exchange({ method: "GET", url: "/", headers: {} });
  const cookies = Array.isArray((probe as { cookies?: string[] }).cookies);
  test("two cookies arrive as two Set-Cookie headers (needs inkan 0.6, skipped before)", { timeout: 20_000, skip: !cookies && "the installed inkan has no cookies on AdapterResponse" }, async () => {
    const app = inkan({ log: false, gracefulShutdown: false }).post("/login", (ctx) => {
      const set = (ctx as unknown as { setCookie: (n: string, v: string, o?: object) => void }).setCookie;
      set("sid", "abc", { httpOnly: true, path: "/" });
      set("theme", "dark");
      return { ok: true };
    });
    const server = await serve(app, { port: 0, host: "127.0.0.1" });
    try {
      const r = await fetch(`${server.url}/login`, { method: "POST" });
      assert.equal(r.status, 200);
      const set = r.headers.getSetCookie();
      assert.equal(set.length, 2);
      assert.match(set[0], /^sid=abc/);
      assert.match(set[0], /HttpOnly/i);
      assert.match(set[1], /^theme=dark/);
    } finally {
      await server.close();
    }
  });
} else if (process.env.REQUIRE_UWS) {
  throw new Error("uWebSockets.js is not installed, and REQUIRE_UWS says this test has to run");
} else {
  test("uWebSockets.js (@inkanjs/uws)", { skip: "uWebSockets.js is not installed: see packages/uws/README.md" }, () => {});
}
