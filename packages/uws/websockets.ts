// WebSocket routes (app.ws) on uWebSockets.js: the same handshake, refusals, message contract,
// limits and close codes as app.listen(), with Node's own WebSocket as the client, and a
// client that writes frames by hand where the platform one cannot say what is needed.
// test.ts runs them when uWebSockets.js is installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { inkan, t, type App } from "@vxnsin/inkan";
import type { serve as Serve } from "./index.js";

const quiet = { log: false, gracefulShutdown: false } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const Say = t.discriminated("type", {
  say: t.object({ type: t.literal("say"), text: t.string().max(20) }),
  leave: t.object({ type: t.literal("leave") }),
});
const Said = t.object({ type: t.enum(["said", "joined"]), text: t.string(), from: t.string() });

const chat = () =>
  inkan(quiet).ws(
    "/rooms/:room",
    { params: t.object({ room: t.string() }), query: t.object({ name: t.string() }), message: Say, send: Said },
    (socket, ctx) => {
      void socket.send({ type: "joined", text: ctx.params.room, from: ctx.query.name, secret: "kept back" } as never);
      socket.on("message", (m) => {
        if (m.type === "leave") return socket.close(4000, "bye");
        void socket.send({ type: "said", text: m.text, from: ctx.query.name });
      });
    },
  );

const parsed = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
/** The next messages of a platform WebSocket, parsed when they are JSON. */
function inbox(ws: WebSocket) {
  const got: unknown[] = [];
  const waiting: ((v: unknown) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const v = typeof e.data === "string" ? parsed(e.data) : e.data;
    const w = waiting.shift();
    w ? w(v) : got.push(v);
  });
  return () => (got.length ? Promise.resolve(got.shift()) : new Promise((r) => waiting.push(r)));
}
const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("did not open")), { once: true });
  });
const closed = (ws: WebSocket) => new Promise<{ code: number; reason: string }>((r) => ws.addEventListener("close", (e) => r({ code: e.code, reason: e.reason }), { once: true }));

type Frame = { op: number; payload: Buffer };
type Raw = { status: number; head: string; text: string; sock: Socket; next: (ms?: number) => Promise<Frame | null> };

/** An upgrade written by hand: the answer's head (and body, for a refusal), then the frames that come. */
function raw(port: number, path: string, extra = "", key = randomBytes(16).toString("base64")): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n${extra}\r\n`);
    let buf = Buffer.alloc(0);
    let head: string | undefined;
    let text = "";
    const frames: (Frame | null)[] = [];
    const waiting: ((f: Frame | null) => void)[] = [];
    const push = (f: Frame | null) => {
      const w = waiting.shift();
      w ? w(f) : frames.push(f);
    };
    sock.on("error", reject);
    sock.on("close", () => {
      if (head === undefined) resolve({ status: Number(text.split(" ")[1]) || 0, head: text, text, sock, next });
      push(null);
    });
    sock.on("data", (b: Buffer) => {
      text += b.toString();
      buf = Buffer.concat([buf, b]);
      if (head === undefined) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const status = Number(buf.subarray(0, end).toString().split(" ")[1]);
        if (status !== 101) return; // a refusal: the whole answer, once the server hangs up
        head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        resolve({ status, head, text, sock, next });
      }
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1]! & 0x7f;
        let at = 2;
        if (len === 126) (len = buf.readUInt16BE(2)), (at = 4);
        else if (len === 127) (len = Number(buf.readBigUInt64BE(2))), (at = 10);
        if (buf.length < at + len) return;
        push({ op: buf[0]! & 0x0f, payload: Buffer.from(buf.subarray(at, at + len)) });
        buf = buf.subarray(at + len);
      }
    });
    function next(ms = 2000): Promise<Frame | null> {
      if (frames.length) return Promise.resolve(frames.shift()!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no frame came")), ms);
        waiting.push((f) => (clearTimeout(timer), resolve(f)));
      });
    }
  });
}

export function websockets(serve: typeof Serve) {
  async function served(app: App) {
    const server = await serve(app, { port: 0, host: "127.0.0.1" });
    return { port: server.port, url: server.url.replace(/^http/, "ws"), http: server.url, close: () => server.close() };
  }

  test("uws ws: handshake and echo, typed both ways, trimmed to `send`; the server's close code reaches the client", async () => {
    const s = await served(chat());
    try {
      const ws = new WebSocket(`${s.url}/rooms/tea?name=ana`);
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

  test("uws ws: the 101 carries the accept key and the answer's own headers", async () => {
    const s = await served(chat());
    try {
      const r = await raw(s.port, "/rooms/a?name=x", "x-request-id: abc-123\r\n");
      assert.equal(r.status, 101);
      assert.match(r.head, /sec-websocket-accept: [A-Za-z0-9+/=]{28}/i);
      assert.match(r.head, /x-request-id: abc-123/i);
      r.sock.destroy();
    } finally {
      await s.close();
    }
  });

  test("uws ws: a message that breaks the contract or is not JSON closes with 1007; binary on a contract route with 1003", async () => {
    const s = await served(chat());
    try {
      const a = new WebSocket(`${s.url}/rooms/a?name=x`);
      await opened(a);
      const endA = closed(a);
      a.send(JSON.stringify({ type: "say", text: "x".repeat(30) }));
      const ca = await endA;
      assert.equal(ca.code, 1007);
      assert.match(ca.reason, /text/);
      assert.doesNotMatch(ca.reason, /xxxx/, "the reason echoes no input");

      const b = new WebSocket(`${s.url}/rooms/a?name=x`);
      await opened(b);
      const endB = closed(b);
      b.send("not json");
      assert.deepEqual(await endB, { code: 1007, reason: "the message is not JSON" });

      const c = new WebSocket(`${s.url}/rooms/a?name=x`);
      await opened(c);
      const endC = closed(c);
      c.send(new Uint8Array([1, 2, 3]));
      assert.deepEqual(await endC, { code: 1003, reason: "messages are JSON text, not binary" });
    } finally {
      await s.close();
    }
  });

  test("uws ws: origin, security, input and path answer the upgrade with their status before any socket", async () => {
    let hooks = 0;
    const app = inkan(quiet)
      .ws("/secure", { security: "bearer" }, (socket) => void socket.sendRaw("in"))
      .ws("/q", { query: t.object({ n: t.int() }) }, () => {})
      .ws("/listed", { origins: ["https://good.example"] }, () => {})
      .ws("/one", { maxConnections: 1 }, () => {})
      .get("/plain", () => ({ ok: true }));
    app.onRequest(() => void hooks++);
    const s = await served(app);
    try {
      const evil = await raw(s.port, "/q?n=1", "Origin: http://evil.example\r\nCookie: sid=abc\r\n");
      assert.equal(evil.status, 403);
      assert.match(evil.text, /"type":"origin-not-allowed"/);
      assert.equal(hooks, 0, "no hook ran");
      const own = await raw(s.port, "/q?n=1", "Origin: http://x\r\n");
      assert.equal(own.status, 101, "the own origin, by the Host header");
      own.sock.destroy();
      const listed = await raw(s.port, "/listed", "Origin: https://good.example\r\n");
      assert.equal(listed.status, 101);
      listed.sock.destroy();

      const no = await raw(s.port, "/secure");
      assert.equal(no.status, 401);
      assert.match(no.text, /"type":"unauthorized"/);
      assert.match(no.text, /www-authenticate: Bearer/i);
      assert.equal((await raw(s.port, "/q?n=abc")).status, 400);
      assert.equal((await raw(s.port, "/nowhere")).status, 404);
      assert.equal((await raw(s.port, "/plain")).status, 404, "an HTTP route is no WebSocket");
      assert.equal((await raw(s.port, "/q?n=1", "", "short")).status, 400, "a key uWS does not take is the app's to refuse");
      assert.equal((await raw(s.port, "/q?n=1", "", "AAAAAAAAAAAAAAAAAAAAAB==")).status, 400, "not canonical base64");
      assert.equal((await fetch(`${s.http}/q?n=1`)).status, 426, "a plain request to a WebSocket path");
      assert.equal((await fetch(`${s.http}/plain`)).status, 200, "and the HTTP routes beside them are untouched");

      const first = await raw(s.port, "/one");
      assert.equal(first.status, 101);
      const second = await raw(s.port, "/one");
      assert.equal(second.status, 503);
      first.sock.destroy();
      await sleep(50);
      const third = await raw(s.port, "/one");
      assert.equal(third.status, 101, "the slot is free again");
      third.sock.destroy();

      // Node's WebSocket takes headers: the bearer token goes with the upgrade
      const ws = new WebSocket(`${s.url}/secure`, { headers: { authorization: "Bearer t" } } as never);
      const next = inbox(ws);
      await opened(ws);
      assert.equal(await next(), "in");
      ws.close();
    } finally {
      await s.close();
    }
  });

  test("uws ws: a handshake that never gets its answer is cut off", async () => {
    const app = inkan(quiet).ws("/slow", { handshakeTimeout: 100 }, () => {});
    app.onRequest(() => new Promise<void>(() => {}));
    const s = await served(app);
    try {
      const started = Date.now();
      const r = await raw(s.port, "/slow");
      assert.equal(r.status, 0, "no answer, the connection just ends");
      assert.ok(Date.now() - started < 2000);
    } finally {
      await s.close();
    }
  });

  test("uws ws: maxMessage closes with 1009 per route; past the largest route's, uWS cuts the connection (1006)", async () => {
    const echo = (socket: { on: (e: "message", fn: (m: string | Buffer) => void) => unknown; sendRaw: (m: string | Buffer) => Promise<void> }) =>
      void socket.on("message", (m) => void socket.sendRaw(m));
    const app = inkan(quiet)
      .ws("/small", { maxMessage: 16 }, echo)
      .ws("/roomy", { maxMessage: 1000 }, echo);
    const s = await served(app);
    try {
      const a = new WebSocket(`${s.url}/small`);
      const next = inbox(a);
      await opened(a);
      a.send("x".repeat(16));
      assert.equal(await next(), "x".repeat(16), "the limit itself is fine");
      const endA = closed(a);
      a.send("x".repeat(17));
      assert.deepEqual(await endA, { code: 1009, reason: "messages may have at most 16 bytes" });

      const b = new WebSocket(`${s.url}/small`);
      await opened(b);
      const endB = closed(b);
      b.send("x".repeat(5000));
      assert.equal((await endB).code, 1006, "uWS closes without a close frame");
    } finally {
      await s.close();
    }
  });

  test("uws ws: without a contract text is a string and binary a Buffer; large messages both ways", async () => {
    const got: unknown[] = [];
    const app = inkan(quiet).ws("/raw", {}, (socket) =>
      socket.on("message", (m) => {
        got.push(Buffer.isBuffer(m) ? ["buffer", m.length] : ["string", (m as string).length]);
        void socket.sendRaw(m);
      }),
    );
    const s = await served(app);
    try {
      const ws = new WebSocket(`${s.url}/raw`);
      ws.binaryType = "arraybuffer";
      const next = inbox(ws);
      await opened(ws);
      ws.send("hi");
      assert.equal(await next(), "hi");
      const big = randomBytes(200_000);
      ws.send(big);
      const back = (await next()) as ArrayBuffer;
      assert.ok(Buffer.from(back).equals(big));
      ws.send("é".repeat(100_000));
      assert.equal(await next(), "é".repeat(100_000));
      assert.deepEqual(got, [["string", 2], ["buffer", 200_000], ["string", 100_000]]);
      ws.close();
    } finally {
      await s.close();
    }
  });

  test("uws ws: send resolves once the socket can take more, and bufferedAmount says how much waits", async () => {
    let done = false;
    let buffered = -1;
    const app = inkan(quiet).ws("/flood", {}, async (socket) => {
      const chunk = "z".repeat(64 * 1024);
      for (let i = 0; i < 64; i++) await socket.sendRaw(chunk);
      buffered = socket.bufferedAmount;
      done = true;
    });
    const s = await served(app);
    try {
      const ws = new WebSocket(`${s.url}/flood`);
      let count = 0;
      ws.addEventListener("message", () => count++);
      await opened(ws);
      while (count < 64) await sleep(10);
      for (let i = 0; i < 50 && !done; i++) await sleep(10);
      assert.equal(done, true);
      assert.equal(typeof buffered, "number");
      ws.close();
    } finally {
      await s.close();
    }
  });

  test("uws ws: a handler that writes past the buffer limit without waiting is cut off with 1008", async () => {
    let code: number | undefined;
    const app = inkan(quiet).ws("/flood", { heartbeat: false }, (socket) => {
      socket.on("close", (c) => (code = c));
      const chunk = Buffer.alloc(64 * 1024);
      for (let i = 0; i < 400; i++) void socket.sendRaw(chunk);
    });
    const s = await served(app);
    try {
      const r = await raw(s.port, "/flood");
      r.sock.pause();
      for (let i = 0; i < 100 && code === undefined; i++) await sleep(20);
      assert.equal(code, 1008);
      r.sock.destroy();
    } finally {
      await s.close();
    }
  });

  test("uws ws: the client's close code reaches the handler; ctx.signal aborts; late listeners and the iterator get every message", async () => {
    let got: [number, string] | undefined;
    let aborted = false;
    const app = inkan(quiet)
      .ws("/hear", {}, (socket) => socket.on("close", (code, reason) => (got = [code, reason])))
      .ws("/late", { message: t.object({ n: t.int() }), send: t.object({ sum: t.int() }) }, async (socket, ctx) => {
        ctx.signal.addEventListener("abort", () => (aborted = true));
        await sleep(50); // the client sends before anybody listens
        let sum = 0;
        for await (const m of socket) {
          sum += m.n;
          if (sum >= 6) await socket.send({ sum });
        }
      });
    const s = await served(app);
    try {
      const a = new WebSocket(`${s.url}/hear`);
      await opened(a);
      a.close(4002, "bye");
      await closed(a);
      for (let i = 0; i < 50 && !got; i++) await sleep(10);
      assert.deepEqual(got, [4002, "bye"]);

      const b = new WebSocket(`${s.url}/late`);
      const next = inbox(b);
      await opened(b);
      for (const n of [1, 2, 3]) b.send(JSON.stringify({ n }));
      assert.deepEqual(await next(), { sum: 6 });
      b.close(1000);
      await closed(b);
      for (let i = 0; i < 50 && !aborted; i++) await sleep(10);
      assert.equal(aborted, true);
    } finally {
      await s.close();
    }
  });

  test("uws ws: in development a message that breaks `send` throws: reported, and the socket closes with 1011", async () => {
    const errors: unknown[] = [];
    const app = inkan({ ...quiet, onError: (e) => void errors.push(e) }).ws("/bad", { send: t.object({ n: t.int() }) }, (socket) => {
      void socket.send({ n: "one" } as never);
    });
    const s = await served(app);
    try {
      const ws = new WebSocket(`${s.url}/bad`);
      assert.equal((await closed(ws)).code, 1011);
      assert.match(String(errors[0]), /WS \/bad sent a message that breaks its contract: n/);
    } finally {
      await s.close();
    }
  });

  test("uws ws: heartbeat: a peer that answers pings stays, one that does not is cut off", { timeout: 15_000 }, async () => {
    const app = inkan(quiet).ws("/hb", { heartbeat: 250 }, (socket) => socket.on("message", (m) => void socket.sendRaw(m)));
    const s = await served(app);
    try {
      const ws = new WebSocket(`${s.url}/hb`); // answers pings by itself
      const next = inbox(ws);
      await opened(ws);
      await sleep(800);
      ws.send('"still here"');
      assert.equal(await next(), "still here");
      ws.close();

      const r = await raw(s.port, "/hb"); // never answers
      assert.equal((await r.next())?.op, 0x9, "the server pings");
      assert.equal(await r.next(), null, "and hangs up without a pong");
    } finally {
      await s.close();
    }
  });

  test("uws ws: close() ends every open socket with 1001, then runs onClose", async () => {
    const events: string[] = [];
    const app = inkan(quiet)
      .ws("/stay", {}, (socket) => socket.on("close", (code) => void events.push(`socket ${code}`)))
      .onClose(() => void events.push("onClose"));
    const s = await served(app);
    const ws = new WebSocket(`${s.url}/stay`);
    await opened(ws);
    const end = closed(ws);
    const started = Date.now();
    await s.close();
    assert.ok(Date.now() - started < 2000, "it does not wait for the drain");
    assert.deepEqual(await end, { code: 1001, reason: "the server is shutting down" });
    assert.deepEqual(events, ["socket 1001", "onClose"]);
  });
}
