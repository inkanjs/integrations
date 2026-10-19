// An inkan app on uWebSockets.js instead of node:http. Everything goes through
// app.exchange(), the one door inkan has for any server: the contracts, hooks, problems
// and streams are the app's, this file only moves bytes between the socket and the app.
// WebSockets go through the other door, app.upgradeListener: the app decides the upgrade
// and runs the socket, uWS's own websockets carry it (see Pipe below).
//
//   import { serve } from "@inkanjs/uws";
//   const server = await serve(app, { port: 3000 });
//   await server.close();

import { STATUS_CODES } from "node:http";
import { createRequire } from "node:module";
import { Duplex } from "node:stream";

// uWebSockets.js 20.71 ships an ESM wrapper that imports a file it does not have; its CommonJS entry works
const uWS = createRequire(import.meta.url)("uWebSockets.js");

const text = (ab) => Buffer.from(ab).toString();

/**
 * Serves `app` on uWebSockets.js. Resolves once it listens, after the app's plugins and its
 * onListen hooks; `close()` stops taking requests, lets the open ones finish and runs the
 * onClose hooks.
 */
export async function serve(app, options = {}) {
  const { port = Number(process.env.PORT ?? 3000), host = "0.0.0.0", tls, drain = 10_000 } = options;
  const signals = options.signals ?? app.options.gracefulShutdown;
  await app.ready();
  // how a request's body is read: the route's own limit, and whether it takes the body unread
  // (inkan 0.5 and later; before that, the app's limit for every route)
  const bodyFor = app.bodyFor ? (method, url) => app.bodyFor(method, url) : () => ({ limit: app.options.bodyLimit, stream: false });

  // what is still being answered: close() waits for the requests, and ends the streams,
  // which would otherwise keep it waiting for as long as a client stays
  let open = 0;
  const streams = new Set();
  let idle;
  const finished = () => {
    if (--open === 0) idle?.();
  };

  const server = tls ? uWS.SSLApp({ key_file_name: tls.key, cert_file_name: tls.cert, passphrase: tls.passphrase }) : uWS.App();
  // the open WebSockets and the handshakes on their way: close() ends them with 1001
  const pipes = new Set();
  const sockets = websockets(app, server, pipes, Boolean(tls));
  server.any("/*", (res, req) => {
    // the request is only readable now, before the first await
    const method = req.getCaseSensitiveMethod().toUpperCase();
    const query = req.getQuery();
    const url = req.getUrl() + (query ? `?${query}` : "");
    const headers = {};
    req.forEach((name, value) => (headers[name] = name in headers ? `${headers[name]}, ${value}` : value));
    const remote = text(res.getRemoteAddressAsText());
    // an upgrade uWS did not take (not a GET, a key that is not 24 characters) is still the
    // app's to refuse, as with app.listen()
    if (sockets && headers.upgrade !== undefined && /\bupgrade\b/i.test(headers.connection ?? "")) return sockets.refuse(res, method, url, headers, remote);

    open++;
    let gone = false;
    let over = false;
    let answer;
    // a body handed over unread: who waits for its next chunk, whether the socket is paused, whether the rest is let go
    let wake;
    let paused = false;
    let dropped = false;
    const end = () => {
      if (over) return;
      over = true;
      finished();
    };
    res.onAborted(() => {
      gone = true;
      answer?.abort?.abort(); // the client went away: tell the source, so it stops producing
      wake?.(); // and a handler still reading the body, so it stops waiting
      if (!answer?.stream) end(); // a stream ends itself once the source has stopped
    });

    const hasBody = method !== "GET" && method !== "HEAD" && (headers["content-length"] !== undefined || headers["transfer-encoding"] !== undefined);
    if (!hasBody) return void exchange(undefined);
    const { limit, stream: unread } = bodyFor(method, url);
    if (Number(headers["content-length"] ?? 0) > limit) return tooLarge();
    if (unread) return void exchange(undefined, bodyStream());
    const chunks = [];
    let size = 0;
    res.onData((ab, last) => {
      if (size > limit) return; // already answered 413; the rest is let go
      size += ab.byteLength;
      if (size > limit) return tooLarge();
      chunks.push(Buffer.from(new Uint8Array(ab))); // a copy: uWS takes the memory back after this call
      if (last) exchange(Buffer.concat(chunks));
    });

    // The body as it arrives, for a route that takes it unread (t.stream()): inkan reads it
    // chunk by chunk and holds it to the route's limit. When the handler falls behind, the
    // socket is paused until it catches up; what it leaves unread is let go.
    function bodyStream() {
      const queue = [];
      let ended = false;
      const pause = (yes) => {
        if (paused === yes || gone || over) return;
        paused = yes;
        yes ? res.pause() : res.resume();
      };
      res.onData((ab, last) => {
        if (last) ended = true;
        if (dropped) return;
        if (ab.byteLength) queue.push(Buffer.from(new Uint8Array(ab))); // a copy: uWS takes the memory back after this call
        if (queue.length >= 16) pause(true);
        wake?.();
      });
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (;;) {
              if (queue.length) {
                const chunk = queue.shift();
                if (queue.length < 4) pause(false);
                yield chunk;
              } else if (ended) return;
              else if (gone) throw new Error("the client went away before the body was whole");
              else await new Promise((resolve) => (wake = resolve));
            }
          } finally {
            letGo();
          }
        },
      };
    }
    // nobody reads the rest of the body: drop it as it comes, and keep the socket reading
    function letGo() {
      dropped = true;
      wake = undefined;
      if (paused && !gone && !over) {
        paused = false;
        res.resume();
      }
    }

    function tooLarge() {
      if (gone) return;
      gone = true;
      const body = JSON.stringify({ type: "body-too-large", title: STATUS_CODES[413], status: 413, detail: `Request bodies may be at most ${limit} bytes`, instance: url });
      res.cork(() => res.writeStatus("413 Payload Too Large").writeHeader("content-type", "application/problem+json").end(body, true));
      end();
    }

    async function exchange(body, stream) {
      try {
        answer = await app.exchange({ method, url, headers, body, stream, remote });
      } catch (err) {
        console.error(err);
        answer = { status: 500, headers: { "content-type": "application/problem+json" }, body: JSON.stringify({ type: "internal", title: STATUS_CODES[500], status: 500 }) };
      }
      if (gone) return void answer.abort?.abort();
      letGo();
      if (answer.stream) return void streamOut(answer);
      res.cork(() => {
        head(answer);
        const length = answer.headers["content-length"];
        // a HEAD keeps the length of the GET it stands for, without the body
        if (answer.body === undefined && length !== undefined && method === "HEAD") res.endWithoutBody(Number(length));
        else res.end(answer.body ?? "");
      });
      answer.done?.();
      end();
    }

    function head(a) {
      res.writeStatus(`${a.status} ${STATUS_CODES[a.status] ?? ""}`);
      // uWS writes the length itself, and the connection is its business
      for (const [k, v] of Object.entries(a.headers)) if (k !== "content-length" && k !== "connection") res.writeHeader(k, v);
      // one Set-Cookie per cookie, never joined into one (inkan 0.6 and later)
      for (const cookie of a.cookies ?? []) res.writeHeader("set-cookie", cookie);
    }

    async function streamOut(a) {
      let stopped = false;
      const stop = () => {
        stopped = true;
        a.abort?.abort();
      };
      streams.add(stop);
      res.cork(() => head(a));
      try {
        for await (const chunk of a.stream) {
          if (gone || stopped) break;
          let ok;
          res.cork(() => (ok = res.write(chunk)));
          if (!ok) await new Promise((resolve) => res.onWritable(() => (resolve(), true)));
        }
      } catch (err) {
        if (!gone && !stopped) console.error(err);
      }
      streams.delete(stop);
      if (!gone) res.cork(() => res.end()); // also when close() stopped it: the client gets a clean end
      a.done?.();
      end();
    }
  });

  const token = await new Promise((resolve, reject) =>
    server.listen(host, port, (t) => (t ? resolve(t) : reject(new Error(`uWebSockets.js could not listen on ${host}:${port}`)))),
  );
  const actual = uWS.us_socket_local_port(token);
  const url = `${tls ? "https" : "http"}://${host === "0.0.0.0" || host === "::" ? "localhost" : host}:${actual}`;
  await app.started();
  say(app, "listening", url);

  let closing;
  const close = () =>
    (closing ??= (async () => {
      uWS.us_listen_socket_close(token);
      for (const stop of streams) stop();
      // the WebSockets close with 1001, as with app.listen(); on uWS they are gone at once
      const waits = [...pipes].map((p) => p.shutdown());
      if (open > 0) waits.push(new Promise((resolve) => (idle = resolve)));
      if (waits.length) await Promise.race([Promise.all(waits), new Promise((resolve) => setTimeout(resolve, drain).unref())]);
      server.close?.(); // whatever is left after the wait, idle keep-alive sockets too
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await app.stopped();
    })());

  let signalled = false;
  function onSignal(signal) {
    if (signalled) process.exit(1); // a second ctrl+c means now
    signalled = true;
    say(app, `${signal}: finishing open requests…`);
    close().then(
      () => process.exit(0),
      (err) => (console.error(err), process.exit(1)),
    );
  }
  if (signals) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  return {
    /** The port it listens on, also when it was asked for 0. */
    port: actual,
    /** Where it listens, as a URL. */
    url,
    /** Stops taking requests, lets the open ones finish (ends the streams), then runs the onClose hooks. */
    close,
  };
}

// ---------- WebSockets ----------

const TEXT = 0x1;
const BINARY = 0x2;
const CLOSE = 0x8;
const PING = 0x9;
const PONG = 0xa;
/** Bytes uWS may hold for a socket before the app's next frame waits for its drain. */
const HIGH = 64 * 1024;
const SHUTDOWN = "the server is shutting down";
const SWITCHING = Buffer.from("HTTP/1.1 101 ");
/** The close codes a close frame may carry (RFC 6455 7.4); what else uWS reports (1006) is a connection that just went. */
const validCode = (c) => (c >= 1000 && c <= 1014 && c !== 1004 && c !== 1005 && c !== 1006) || (c >= 3000 && c <= 4999);

/**
 * The app's WebSocket routes on uWS's websockets, when it has any. The app decides every
 * upgrade itself, through app.upgradeListener: the route, the origin, maxConnections, the
 * hooks, the security and the input checks, the handshake timeout. uWS does the wire: the
 * handshake, framing, masking, UTF-8, fragments, pongs, and the cap on a message's size.
 */
function websockets(app, server, pipes, secure) {
  const routes = app.routes().filter((r) => r.method === "WS");
  if (!routes.length) return; // as app.listen(): an app without WebSocket routes answers upgrades as plain requests
  const listener = app.upgradeListener;
  const largest = Math.max(...routes.map((r) => r.spec.maxMessage ?? 1024 * 1024));

  function start(res, method, url, headers, remote, context) {
    const pipe = new Pipe(res, headers, context, () => pipes.delete(pipe));
    pipes.add(pipe);
    res.onAborted(() => pipe.aborted());
    // what the app reads of a Node request; ctx.req is this
    const req = { method, url, headers, httpVersion: "1.1", httpVersionMajor: 1, httpVersionMinor: 1, socket: { remoteAddress: remote, encrypted: secure } };
    listener(req, pipe, Buffer.alloc(0));
  }

  server.ws("/*", {
    // each route holds its own maxMessage in the app; uWS cuts off, with 1009, what no route would take
    maxPayloadLength: largest,
    // the app's heartbeat (per route) pings; uWS neither pings nor times out on its own
    idleTimeout: 0,
    sendPingsAutomatically: false,
    // nothing is dropped: past HIGH the app's next frame waits for the drain
    maxBackpressure: HIGH + largest + 1024 * 1024,
    closeOnBackpressureLimit: false,
    upgrade(res, req, context) {
      const query = req.getQuery();
      const url = req.getUrl() + (query ? `?${query}` : "");
      const headers = {};
      req.forEach((name, value) => (headers[name] = name in headers ? `${headers[name]}, ${value}` : value));
      start(res, "GET", url, headers, text(res.getRemoteAddressAsText()), context);
    },
    open: (ws) => ws.getUserData().pipe.opened(ws),
    message: (ws, data, binary) => ws.getUserData().pipe.in(binary ? BINARY : TEXT, data),
    pong: (ws, data) => ws.getUserData().pipe.in(PONG, data),
    drain: (ws) => ws.getUserData().pipe.drained(),
    close: (ws, code, message) => ws.getUserData().pipe.ended(code, text(message)),
  });

  return {
    /** An upgrade uWS passed on to the HTTP routes (its key is not 24 characters): the app answers it, never with a 101. */
    refuse: (res, method, url, headers, remote) => start(res, method, url, headers, remote, undefined),
  };
}

/**
 * The socket the app gets for an upgrade, in place of the TCP socket Node would hand over.
 * What the app writes is read back: an HTTP answer (a refusal, written as it is), or the
 * 101, after which every frame goes out as a uWS send, ping or end. What the client sends
 * comes in as frames again, whole and checked by uWS already, so the app reads them as it
 * reads any socket: the message contract, 1007, 1003, the listeners, ctx.signal.
 */
class Pipe extends Duplex {
  /** handshake: the answer is being written; upgrading: the 101 went, uWS has not opened yet; open; gone */
  state = "handshake";
  out = Buffer.alloc(0);
  /** The app's write that waits for uWS to drain. */
  waiting;
  /** Whether the app sent its close frame. */
  sentClose = false;

  constructor(res, headers, context, forget) {
    super();
    this.res = res;
    this.headers = headers;
    this.context = context;
    this.once("close", forget);
  }

  _read() {}

  _write(chunk, _enc, cb) {
    this.take(chunk, cb);
  }

  _writev(chunks, cb) {
    this.take(chunks.length === 1 ? chunks[0].chunk : Buffer.concat(chunks.map((c) => c.chunk)), cb);
  }

  take(chunk, cb) {
    if (this.state === "gone") return cb();
    this.out = this.out.length ? Buffer.concat([this.out, chunk]) : chunk;
    if (this.state === "handshake") {
      // the 101 comes as one write; any other answer comes whole with the end of the socket (_final)
      const end = this.out.indexOf("\r\n\r\n");
      if (end < 0 || !this.out.subarray(0, SWITCHING.length).equals(SWITCHING)) return cb();
      const head = this.out.subarray(0, end).toString("latin1");
      this.out = this.out.subarray(end + 4);
      this.switch(head);
    }
    if (this.state !== "open") return cb(); // frames before uWS opened wait in `out`
    this.frames();
    if (this.ws && this.ws.getBufferedAmount() > HIGH) this.waiting = cb;
    else cb();
  }

  _final(cb) {
    if (this.state === "handshake") {
      this.answer();
      setImmediate(() => this.destroy()); // the app is done with it: there is nothing more to read
    }
    cb();
  }

  _destroy(err, cb) {
    const was = this.state;
    const { res, ws } = this;
    this.state = "gone";
    this.res = undefined;
    this.ws = undefined;
    if (was === "handshake") res?.close(); // the handshake timed out: cut the connection
    else ws?.close(); // no close frame: the app cut it off (no pong in time, too much waiting)
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
    cb(err);
  }

  /** The client went away before the handshake was answered. */
  aborted() {
    if (this.state !== "handshake") return;
    this.res = undefined;
    this.destroy();
  }

  /** An answer that is not a 101: written as the app wrote it, then the connection ends. */
  answer() {
    const res = this.res;
    this.res = undefined;
    this.state = "gone";
    if (!res) return;
    const end = this.out.indexOf("\r\n\r\n");
    const lines = this.out.subarray(0, end < 0 ? this.out.length : end).toString("latin1").split("\r\n");
    const body = end < 0 ? "" : this.out.subarray(end + 4);
    const status = lines.shift().slice("HTTP/1.1 ".length);
    res.cork(() => {
      res.writeStatus(status);
      for (const line of lines) {
        const at = line.indexOf(":");
        const name = line.slice(0, at).toLowerCase();
        if (name === "content-length" || name === "connection") continue; // uWS writes those
        res.writeHeader(name, line.slice(at + 1).trim());
      }
      res.end(body, true);
    });
  }

  /** The 101: uWS writes it, with its own accept key and the answer's own headers (request id, cookies). */
  switch(head) {
    const res = this.res;
    this.res = undefined;
    if (!res || !this.context) return void this.destroy(); // nothing to upgrade with: the app never says 101 to those
    this.state = "upgrading";
    res.cork(() => {
      res.writeStatus("101 Switching Protocols");
      for (const line of head.split("\r\n").slice(1)) {
        const at = line.indexOf(":");
        const name = line.slice(0, at).toLowerCase();
        if (name === "upgrade" || name === "connection" || name === "sec-websocket-accept") continue;
        res.writeHeader(name, line.slice(at + 1).trim());
      }
      // no subprotocol and no extension, as with app.listen(): the frames go as they are
      res.upgrade({ pipe: this }, this.headers["sec-websocket-key"], "", "", this.context);
    });
  }

  opened(ws) {
    if (this.state !== "upgrading") return void ws.close(); // destroyed between the 101 and now
    this.ws = ws;
    this.state = "open";
    this.frames(); // what the handler sent before uWS opened
  }

  /** The app's frames out, as uWS sends. They are never fragmented and never masked. */
  frames() {
    // corked: a send from outside a uWS callback (a handler's await) is otherwise not flushed
    if (this.state === "open" && this.out.length >= 2) this.ws.cork(() => this.unframe());
  }

  unframe() {
    let b = this.out;
    while (b.length >= 2 && this.state === "open") {
      const len7 = b[1] & 0x7f;
      const at = len7 < 126 ? 2 : len7 === 126 ? 4 : 10;
      if (b.length < at) break;
      const len = len7 < 126 ? len7 : len7 === 126 ? b.readUInt16BE(2) : b.readUInt32BE(2) * 2 ** 32 + b.readUInt32BE(6);
      if (b.length < at + len) break;
      this.frame(b[0] & 0x0f, b.subarray(at, at + len));
      b = b.subarray(at + len);
    }
    this.out = this.state === "open" ? b : Buffer.alloc(0);
  }

  frame(op, payload) {
    const ws = this.ws;
    if (op === TEXT || op === BINARY) ws.send(payload, op === BINARY);
    else if (op === PING) ws.ping(payload);
    else if (op === CLOSE) {
      // the app closes: uWS sends the frame and reports the close at once (ended)
      this.sentClose = true;
      if (payload.length >= 2) ws.end(payload.readUInt16BE(0), payload.subarray(2));
      else ws.end();
    }
    // a pong: uWS answers pings itself, so the app is never handed one to answer
  }

  /** A message or a pong from the client: a frame for the app, masked as a client's are (with zeros). */
  in(op, data) {
    if (this.state !== "open") return;
    this.push(clientFrame(op, new Uint8Array(data))); // a copy: uWS takes the memory back after this call
  }

  drained() {
    if (!this.waiting || !this.ws || this.ws.getBufferedAmount() > HIGH) return;
    const cb = this.waiting;
    this.waiting = undefined;
    // not from inside the drain handler: what uWS (20.71) is handed there can stay buffered for good
    setImmediate(cb);
  }

  /** Closed on uWS: by the client, by uWS (a message too large), or after an end() of the app's or of close(). */
  ended(code, reason) {
    if (this.state === "gone") return;
    this.state = "gone";
    this.ws = undefined;
    if (!this.sentClose) {
      // the app learns it as from a close frame; a connection that just went (1006) has none
      if (validCode(code)) {
        const r = Buffer.from(reason);
        const payload = Buffer.allocUnsafe(2 + r.length);
        payload.writeUInt16BE(code, 0);
        r.copy(payload, 2);
        this.push(clientFrame(CLOSE, payload));
      } else if (code === 1005) this.push(clientFrame(CLOSE, new Uint8Array(0)));
    }
    this.push(null);
    setImmediate(() => this.destroy());
  }

  /** For close(): an open socket ends with 1001, a handshake on its way is cut. Resolves once it is gone. */
  shutdown() {
    const gone = this.destroyed ? Promise.resolve() : new Promise((resolve) => this.once("close", resolve));
    if (this.state === "open") this.ws.end(1001, SHUTDOWN);
    else this.destroy();
    return gone;
  }
}

/** A frame as a client sends it: one, final, masked with zeros so the bytes stay as they are. */
function clientFrame(op, data) {
  const len = data.byteLength;
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const f = Buffer.allocUnsafe(6 + ext + len);
  f[0] = 0x80 | op;
  if (len < 126) f[1] = 0x80 | len;
  else if (len < 65536) {
    f[1] = 0x80 | 126;
    f.writeUInt16BE(len, 2);
  } else {
    f[1] = 0x80 | 127;
    f.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    f.writeUInt32BE(len >>> 0, 6);
  }
  f.fill(0, 2 + ext, 6 + ext);
  f.set(data, 6 + ext);
  return f;
}

/** One line in the app's log, in its format: what app.listen() would say, said here. */
function say(app, msg, url) {
  const { log, logger } = app.options;
  if (!log || logger) return;
  if (log === "json") console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...(url && { url, server: "uWebSockets.js" }) }));
  else console.log(url ? `  印 ${msg} on ${url} (uWebSockets.js)` : `\n  ${msg}`);
}
