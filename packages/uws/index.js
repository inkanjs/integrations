// An inkan app on uWebSockets.js instead of node:http. Everything goes through
// app.exchange(), the one door inkan has for any server: the contracts, hooks, problems
// and streams are the app's, this file only moves bytes between the socket and the app.
// WebSockets go through the other door, app.upgrade(): the app decides the upgrade and runs
// the socket, uWS's own websockets carry it.
//
//   import { serve } from "@inkanjs/uws";
//   const server = await serve(app, { port: 3000 });
//   await server.close();

import { STATUS_CODES } from "node:http";
import { createRequire } from "node:module";

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
  const sockets = websockets(app, server, Boolean(tls));
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
    if (sockets && headers.upgrade !== undefined && /\bupgrade\b/i.test(headers.connection ?? "")) return sockets.refuse(res, { method, url, headers, remote, secure: Boolean(tls) });

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
        answer = await app.exchange({ method, url, headers, body, stream, remote, secure: Boolean(tls) });
      } catch (err) {
        console.error(err);
        answer = { status: 500, headers: { "content-type": "application/problem+json" }, body: JSON.stringify({ type: "internal", title: STATUS_CODES[500], status: 500 }) };
      }
      if (gone) return void answer.abort?.abort();
      letGo();
      if (answer.stream) return void streamOut(answer);
      res.cork(() => {
        head(res, answer);
        const length = answer.headers["content-length"];
        // a HEAD keeps the length of the GET it stands for, without the body
        if (answer.body === undefined && length !== undefined && method === "HEAD") res.endWithoutBody(Number(length));
        else res.end(answer.body ?? "");
      });
      answer.done?.();
      end();
    }

    async function streamOut(a) {
      let stopped = false;
      const stop = () => {
        stopped = true;
        a.abort?.abort();
      };
      streams.add(stop);
      res.cork(() => head(res, a));
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
      sockets?.shutdown();
      if (open > 0) await Promise.race([new Promise((resolve) => (idle = resolve)), new Promise((resolve) => setTimeout(resolve, drain).unref())]);
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

/** Bytes uWS may hold for a socket before the app's next send waits for its drain. */
const HIGH = 64 * 1024;
const SHUTDOWN = "the server is shutting down";

/**
 * The app's WebSocket routes on uWS's websockets, when it has any. The app decides every
 * upgrade itself, through app.upgrade(): the route, the origin, maxConnections, the hooks,
 * the security and the input checks, the handshake timeout. It runs the socket too, on the
 * transport this hands it: the contracts, the limits, the close codes, the heartbeat. uWS
 * does the wire: the handshake, framing, masking, fragments, pongs, the cap on a message's size.
 */
function websockets(app, server, secure) {
  const routes = app.routes().filter((r) => r.method === "WS");
  if (!routes.length) return; // as app.listen(): an app without WebSocket routes answers upgrades as plain requests
  const largest = Math.max(...routes.map((r) => r.spec.maxMessage ?? app.options.ws?.maxMessage ?? 1024 * 1024));
  /** The open sockets: close() ends them with 1001. */
  const open = new Set();
  let closing = false;

  async function decide(res, request, context) {
    let gone = false;
    res.onAborted(() => (gone = true));
    const r = await app.upgrade(request);
    if (gone || closing) {
      // the client went away before the answer, or the server is closing: nothing opens
      if (r.status === 101) r.cancel();
      if (!gone) res.close();
      return;
    }
    if (r.status !== 101) {
      if (!r.response) return void res.close(); // no answer in time: the connection just ends
      const a = r.response;
      res.cork(() => {
        head(res, a);
        res.end(a.body ?? "", true);
      });
      return void a.done?.();
    }
    // an upgrade uWS did not take has nothing to upgrade with; the app does not say 101 to those
    if (!context) return void (r.cancel(), res.close());
    res.cork(() => {
      res.writeStatus("101 Switching Protocols");
      for (const [k, v] of Object.entries(r.headers)) res.writeHeader(k, v);
      for (const cookie of r.cookies) res.writeHeader("set-cookie", cookie);
      // no subprotocol and no extension, as with app.listen(): the frames go as they are
      res.upgrade({ r }, request.headers["sec-websocket-key"], "", "", context);
    });
  }

  server.ws("/*", {
    // each route holds its own maxMessage in the app; uWS cuts off what no route would take
    maxPayloadLength: largest,
    // the app's heartbeat (per route) pings; uWS neither pings nor times out on its own
    idleTimeout: 0,
    sendPingsAutomatically: false,
    // nothing is dropped: past HIGH the app waits for the drain, and it cuts off a socket that holds too much (1008)
    maxBackpressure: 2 ** 30,
    closeOnBackpressureLimit: false,
    upgrade(res, req, context) {
      // the request is only readable now, before the first await
      const query = req.getQuery();
      const url = req.getUrl() + (query ? `?${query}` : "");
      const headers = {};
      req.forEach((name, value) => (headers[name] = name in headers ? `${headers[name]}, ${value}` : value));
      void decide(res, { method: "GET", url, headers, remote: text(res.getRemoteAddressAsText()), secure }, context);
    },
    open(ws) {
      const ud = ws.getUserData();
      if (closing) {
        ud.r.cancel();
        return void ws.end(1001, SHUTDOWN);
      }
      open.add(ws);
      ud.ev = ud.r.accept({
        // corked: a send from outside a uWS callback (after a handler's await) is otherwise not flushed
        send(data, binary) {
          if (ud.gone) return;
          let sent;
          ws.cork(() => (sent = ws.send(data, binary)));
          return sent === 1 || ws.getBufferedAmount() <= HIGH;
        },
        close(code, reason) {
          if (ud.gone) return;
          if (code === 1006) ws.close(); // cut off, no close frame
          else ws.cork(() => ws.end(code, reason));
        },
        ping() {
          if (!ud.gone) ws.cork(() => ws.ping());
        },
        get bufferedAmount() {
          return ud.gone ? 0 : ws.getBufferedAmount();
        },
      });
      // the handler closed it while it was being accepted: uWS reported that before there was anybody to tell
      if (ud.ended) ud.ev.close(...ud.ended);
    },
    message: (ws, data, binary) => ws.getUserData().ev?.message(data, binary),
    pong: (ws) => ws.getUserData().ev?.pong(),
    drain(ws) {
      const ud = ws.getUserData();
      // not from inside the drain handler: what uWS (20.71) is handed there can stay buffered for good
      if (ud.ev) setImmediate(() => ud.gone || ud.ev.drain());
    },
    close(ws, code, message) {
      const ud = ws.getUserData();
      ud.gone = true;
      open.delete(ws);
      const reason = text(message);
      if (ud.ev) ud.ev.close(code, reason);
      else ud.ended = [code, reason];
    },
  });

  return {
    /** An upgrade uWS passed on to the HTTP routes (not a GET, a key that is not 24 characters): the app answers it, never with a 101. */
    refuse: (res, request) => void decide(res, request, undefined),
    /** For close(): the open sockets end with 1001; a handshake still on its way is cut once it is answered. */
    shutdown() {
      closing = true;
      for (const ws of open) ws.end(1001, SHUTDOWN);
    },
  };
}

/** The status line and the headers of an answer; uWS writes the length itself, and the connection is its business. */
function head(res, a) {
  res.writeStatus(`${a.status} ${STATUS_CODES[a.status] ?? ""}`);
  for (const [k, v] of Object.entries(a.headers)) if (k !== "content-length" && k !== "connection") res.writeHeader(k, v);
  // one Set-Cookie per cookie, never joined into one (inkan 0.6 and later)
  for (const cookie of a.cookies ?? []) res.writeHeader("set-cookie", cookie);
}

/** One line in the app's log, in its format: what app.listen() would say, said here. */
function say(app, msg, url) {
  const { log, logger } = app.options;
  if (!log || logger) return;
  if (log === "json") console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...(url && { url, server: "uWebSockets.js" }) }));
  else console.log(url ? `  印 ${msg} on ${url} (uWebSockets.js)` : `\n  ${msg}`);
}
