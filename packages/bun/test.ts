// @inkanjs/bun under Bun: HTTP through app.fetch, WebSocket routes through app.upgrade, the
// gentle close. It runs with `bun run test.ts` (the bun job in CI); under Node, which has no
// Bun.serve, every case is listed as skipped. A small runner of its own, with node:assert,
// so the file is the same under both.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { inkan, sse, t, type App } from "@vxnsin/inkan";
import type { serve as Serve } from "./index.js";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const quiet = { log: false, gracefulShutdown: false } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cases: { name: string; fn: (serve: typeof Serve) => Promise<void> }[] = [];
const test = (name: string, fn: (serve: typeof Serve) => Promise<void>) => void cases.push({ name, fn });

async function served(serve: typeof Serve, app: App) {
  const s = await serve(app, { port: 0, hostname: "127.0.0.1" });
  return { port: s.port, http: s.url, ws: s.url.replace(/^http/, "ws"), close: () => s.close() };
}

const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("did not open")), { once: true });
  });
const closed = (ws: WebSocket) => new Promise<{ code: number; reason: string }>((r) => ws.addEventListener("close", (e) => r({ code: e.code, reason: e.reason }), { once: true }));
function inbox(ws: WebSocket) {
  const got: unknown[] = [];
  const waiting: ((v: unknown) => void)[] = [];
  ws.addEventListener("message", (e) => {
    let v: unknown = e.data;
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {}
    }
    const w = waiting.shift();
    w ? w(v) : got.push(v);
  });
  return () => (got.length ? Promise.resolve(got.shift()) : new Promise((r) => waiting.push(r)));
}

/** An upgrade written by hand: the status of the answer (0 for none), its head and body. */
function raw(port: number, path: string, extra = "", key = randomBytes(16).toString("base64")): Promise<{ status: number; text: string; destroy: () => void }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n${extra}\r\n`);
    let text = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ status: Number(text.split(" ")[1]) || 0, text, destroy: () => sock.destroy() });
    };
    sock.on("data", (b) => {
      text += b.toString("latin1");
      const end = text.indexOf("\r\n\r\n");
      if (end < 0) return;
      const status = Number(text.split(" ")[1]);
      const length = Number(/content-length: *(\d+)/i.exec(text)?.[1] ?? 0);
      if (status === 101 || text.length >= end + 4 + length) finish();
    });
    sock.on("error", (err) => (done ? undefined : text ? finish() : reject(err)));
    sock.on("close", finish);
  });
}

// ---------- HTTP ----------

test("a route with params, trimmed to its contract; a body checked; 404 and 405 as problems", async (serve) => {
  const app = inkan(quiet)
    .get("/teas/:id", { params: t.object({ id: t.int() }), response: { 200: t.object({ id: t.int(), name: t.string() }) } }, ({ params }) => ({
      id: params.id,
      name: "Sencha",
      secret: "kept back",
    }))
    .post("/teas", { body: t.object({ name: t.string().min(1) }), response: { 201: t.object({ name: t.string() }) } }, ({ body, reply }) => reply(201, body));
  const s = await served(serve, app);
  try {
    const a = await fetch(`${s.http}/teas/7`);
    assert.equal(a.status, 200);
    assert.deepEqual(await a.json(), { id: 7, name: "Sencha" });
    assert.ok(a.headers.get("x-request-id"));
    const b = await fetch(`${s.http}/teas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Gyokuro" }) });
    assert.equal(b.status, 201);
    const bad = await fetch(`${s.http}/teas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "" }) });
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get("content-type") ?? "", /problem\+json/);
    assert.equal((await fetch(`${s.http}/nowhere`)).status, 404);
    assert.equal((await fetch(`${s.http}/teas/7`, { method: "DELETE" })).status, 405);
  } finally {
    await s.close();
  }
});

test("the body limit holds; cookies arrive as Set-Cookie headers of their own", async (serve) => {
  const app = inkan({ ...quiet, bodyLimit: 100 })
    .post("/in", ({ body }) => ({ got: body }))
    .get("/login", (ctx) => {
      ctx.setCookie("sid", "abc", { httpOnly: true, path: "/" });
      ctx.setCookie("theme", "dark");
      return { ok: true };
    });
  const s = await served(serve, app);
  try {
    const big = await fetch(`${s.http}/in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x: "y".repeat(500) }) });
    assert.equal(big.status, 413);
    const set = (await fetch(`${s.http}/login`)).headers.getSetCookie();
    assert.equal(set.length, 2);
    assert.match(set[0]!, /^sid=abc/);
  } finally {
    await s.close();
  }
});

test("an event stream arrives piece by piece; onListen and onClose run", async (serve) => {
  const events: string[] = [];
  const app = inkan(quiet)
    .get("/ticks", () =>
      sse(async function* () {
        for (let i = 0; ; i++) {
          yield { event: "tick", data: i };
          await sleep(5);
        }
      }),
    )
    .onListen(() => void events.push("listen"))
    .onClose(() => void events.push("close"));
  const s = await served(serve, app);
  try {
    const stop = new AbortController();
    const r = await fetch(`${s.http}/ticks`, { signal: stop.signal });
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = r.body!.getReader();
    let text = "";
    while (!text.includes("data: 2")) text += new TextDecoder().decode((await reader.read()).value);
    stop.abort();
    assert.deepEqual(events, ["listen"]);
  } finally {
    await s.close();
  }
  assert.deepEqual(events, ["listen", "close"]);
});

// ---------- WebSockets ----------

const Say = t.discriminated("type", {
  say: t.object({ type: t.literal("say"), text: t.string().max(20) }),
  leave: t.object({ type: t.literal("leave") }),
});
const Said = t.object({ type: t.enum(["said", "joined"]), text: t.string(), from: t.string() });
const chat = () =>
  inkan(quiet).ws("/rooms/:room", { params: t.object({ room: t.string() }), query: t.object({ name: t.string() }), message: Say, send: Said }, (socket, ctx) => {
    void socket.send({ type: "joined", text: ctx.params.room, from: ctx.query.name, secret: "kept back" } as never);
    socket.on("message", (m) => {
      if (m.type === "leave") return socket.close(4000, "bye");
      void socket.send({ type: "said", text: m.text, from: ctx.query.name });
    });
  });

test("ws: handshake and echo, typed both ways, trimmed to `send`; the server's close code reaches the client", async (serve) => {
  const s = await served(serve, chat());
  try {
    const ws = new WebSocket(`${s.ws}/rooms/tea?name=ana`);
    const next = inbox(ws);
    await opened(ws);
    assert.deepEqual(await next(), { type: "joined", text: "tea", from: "ana" });
    ws.send(JSON.stringify({ type: "say", text: "hello" }));
    assert.deepEqual(await next(), { type: "said", text: "hello", from: "ana" });
    const end = closed(ws);
    ws.send(JSON.stringify({ type: "leave" }));
    assert.deepEqual(await end, { code: 4000, reason: "bye" });
  } finally {
    await s.close();
  }
});

test("ws: the 101 carries the answer's own headers; a message that breaks the contract closes with 1007, binary with 1003", async (serve) => {
  const s = await served(serve, chat());
  try {
    const r = await raw(s.port, "/rooms/a?name=x", "x-request-id: abc-123\r\n");
    assert.equal(r.status, 101);
    assert.match(r.text, /sec-websocket-accept: [A-Za-z0-9+/=]{28}/i);
    assert.match(r.text, /x-request-id: abc-123/i);
    r.destroy();

    const a = new WebSocket(`${s.ws}/rooms/a?name=x`);
    await opened(a);
    const endA = closed(a);
    a.send("not json");
    assert.deepEqual(await endA, { code: 1007, reason: "the message is not JSON" });
    const b = new WebSocket(`${s.ws}/rooms/a?name=x`);
    await opened(b);
    const endB = closed(b);
    b.send(new Uint8Array([1, 2, 3]));
    assert.deepEqual(await endB, { code: 1003, reason: "messages are JSON text, not binary" });
  } finally {
    await s.close();
  }
});

test("ws: origin, security, input, path and maxConnections answer the upgrade before any socket", async (serve) => {
  let hooks = 0;
  const app = inkan(quiet)
    .ws("/secure", { security: "bearer" }, (socket) => void socket.sendRaw("in"))
    .ws("/q", { query: t.object({ n: t.int() }) }, () => {})
    .ws("/one", { maxConnections: 1 }, () => {})
    .get("/plain", () => ({ ok: true }));
  app.onRequest(() => void hooks++);
  const s = await served(serve, app);
  try {
    const evil = await raw(s.port, "/q?n=1", "Origin: http://evil.example\r\n");
    assert.equal(evil.status, 403);
    assert.match(evil.text, /"type":"origin-not-allowed"/);
    assert.equal(hooks, 0, "no hook ran");
    assert.equal((await raw(s.port, "/secure")).status, 401);
    assert.equal((await raw(s.port, "/q?n=abc")).status, 400);
    assert.equal((await raw(s.port, "/nowhere")).status, 404);
    assert.equal((await raw(s.port, "/q?n=1", "", "short")).status, 400, "a key that is no key");
    assert.equal((await fetch(`${s.http}/q?n=1`)).status, 426, "a plain request to a WebSocket path");
    assert.equal((await fetch(`${s.http}/plain`)).status, 200);

    const first = await raw(s.port, "/one");
    assert.equal(first.status, 101);
    assert.equal((await raw(s.port, "/one")).status, 503);
    first.destroy();
    await sleep(100);
    const third = await raw(s.port, "/one");
    assert.equal(third.status, 101, "the slot is free again");
    third.destroy();

    const ws = new WebSocket(`${s.ws}/secure`, { headers: { authorization: "Bearer t" } } as never);
    const next = inbox(ws);
    await opened(ws);
    assert.equal(await next(), "in");
    ws.close();
  } finally {
    await s.close();
  }
});

test("ws: a handshake that never gets its answer gets no 101", async (serve) => {
  const app = inkan(quiet).ws("/slow", { handshakeTimeout: 100 }, () => {});
  app.onRequest(() => new Promise<void>(() => {}));
  const s = await served(serve, app);
  try {
    const started = Date.now();
    const r = await raw(s.port, "/slow");
    assert.notEqual(r.status, 101);
    assert.ok(Date.now() - started < 2000);
    r.destroy();
  } finally {
    await s.close();
  }
});

test("ws: maxMessage closes with 1009 per route; text a string, binary a Buffer", async (serve) => {
  const got: unknown[] = [];
  const app = inkan(quiet)
    .ws("/small", { maxMessage: 16 }, (socket) => void socket.on("message", (m) => void socket.sendRaw(m as string)))
    .ws("/raw", { maxMessage: 300_000 }, (socket) =>
      socket.on("message", (m) => {
        got.push(Buffer.isBuffer(m) ? ["buffer", m.length] : ["string", (m as string).length]);
        void socket.sendRaw(m as string | Buffer);
      }),
    );
  const s = await served(serve, app);
  try {
    const a = new WebSocket(`${s.ws}/small`);
    const next = inbox(a);
    await opened(a);
    a.send("x".repeat(16));
    assert.equal(await next(), "x".repeat(16));
    const endA = closed(a);
    a.send("x".repeat(17));
    assert.deepEqual(await endA, { code: 1009, reason: "messages may have at most 16 bytes" });

    const b = new WebSocket(`${s.ws}/raw`);
    b.binaryType = "arraybuffer";
    const nextB = inbox(b);
    await opened(b);
    b.send("hi");
    assert.equal(await nextB(), "hi");
    const big = randomBytes(200_000);
    b.send(big);
    assert.ok(Buffer.from((await nextB()) as ArrayBuffer).equals(big));
    assert.deepEqual(got, [["string", 2], ["buffer", 200_000]]);
    b.close();
  } finally {
    await s.close();
  }
});

test("ws: send resolves under backpressure; the client's close code reaches the handler; ctx.signal aborts", async (serve) => {
  let done = false;
  let heard: [number, string] | undefined;
  let aborted = false;
  const app = inkan(quiet)
    .ws("/flood", {}, async (socket) => {
      const chunk = "z".repeat(64 * 1024);
      for (let i = 0; i < 64; i++) await socket.sendRaw(chunk);
      done = true;
    })
    .ws("/hear", {}, (socket, ctx) => {
      ctx.signal.addEventListener("abort", () => (aborted = true));
      socket.on("close", (code, reason) => (heard = [code, reason]));
    });
  const s = await served(serve, app);
  try {
    const f = new WebSocket(`${s.ws}/flood`);
    let count = 0;
    f.addEventListener("message", () => count++);
    await opened(f);
    while (count < 64) await sleep(10);
    for (let i = 0; i < 50 && !done; i++) await sleep(10);
    assert.equal(done, true);
    f.close();

    const h = new WebSocket(`${s.ws}/hear`);
    await opened(h);
    h.close(4002, "bye");
    await closed(h);
    for (let i = 0; i < 50 && !heard; i++) await sleep(10);
    assert.deepEqual(heard, [4002, "bye"]);
    assert.equal(aborted, true);
  } finally {
    await s.close();
  }
});

test("ws: a handler that closes at once; one whose `send` breaks its contract closes with 1011", async (serve) => {
  const errors: unknown[] = [];
  const app = inkan({ ...quiet, onError: (e) => void errors.push(e) })
    .ws("/now", {}, (socket) => socket.close(4001, "at once"))
    .ws("/bad", { send: t.object({ n: t.int() }) }, (socket) => void socket.send({ n: "one" } as never));
  const s = await served(serve, app);
  try {
    assert.deepEqual(await closed(new WebSocket(`${s.ws}/now`)), { code: 4001, reason: "at once" });
    assert.equal((await closed(new WebSocket(`${s.ws}/bad`))).code, 1011);
    assert.match(String(errors[0]), /WS \/bad sent a message that breaks its contract/);
  } finally {
    await s.close();
  }
});

test("ws: heartbeat: a peer that answers pings stays", async (serve) => {
  const app = inkan(quiet).ws("/hb", { heartbeat: 250 }, (socket) => socket.on("message", (m) => void socket.sendRaw(m as string)));
  const s = await served(serve, app);
  try {
    const ws = new WebSocket(`${s.ws}/hb`);
    const next = inbox(ws);
    await opened(ws);
    await sleep(800);
    ws.send('"still here"');
    assert.equal(await next(), "still here");
    ws.close();
  } finally {
    await s.close();
  }
});

test("close() ends every open socket with 1001, then runs onClose", async (serve) => {
  const events: string[] = [];
  const app = inkan(quiet)
    .ws("/stay", {}, (socket) => socket.on("close", (code) => void events.push(`socket ${code}`)))
    .onClose(() => void events.push("onClose"));
  const s = await served(serve, app);
  const ws = new WebSocket(`${s.ws}/stay`);
  await opened(ws);
  const end = closed(ws);
  const started = Date.now();
  await s.close();
  assert.ok(Date.now() - started < 3000, "it does not wait for the drain");
  assert.deepEqual(await end, { code: 1001, reason: "the server is shutting down" });
  assert.deepEqual(events, ["socket 1001", "onClose"]);
});

// ---------- the runner ----------

if (isBun) {
  const { serve } = await import("./index.js");
  let failed = 0;
  for (const c of cases) {
    const started = Date.now();
    try {
      await Promise.race([c.fn(serve), sleep(20_000).then(() => Promise.reject(new Error("timed out after 20 s")))]);
      console.log(`✔ ${c.name} (${Date.now() - started} ms)`);
    } catch (err) {
      failed++;
      console.log(`✖ ${c.name}`);
      console.error(err);
    }
  }
  console.log(`\n${cases.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} else {
  const { test: nodeTest } = await import("node:test");
  for (const c of cases) nodeTest(c.name, { skip: "runs under Bun: bun run test.ts (the bun job in CI)" }, () => {});
}
