// An inkan app on Bun.serve. HTTP goes through app.fetch(), Request in and Response out;
// WebSockets go through app.upgrade(): the app decides the upgrade and runs the socket,
// Bun's own websockets carry it. The contracts, hooks, problems and streams are the app's,
// this file only connects Bun's callbacks to them.
//
//   import { serve } from "@inkanjs/bun";
//   const server = await serve(app, { port: 3000 });
//   await server.close();

const SHUTDOWN = "the server is shutting down";

/**
 * Serves `app` on Bun.serve. Resolves once it listens, after the app's plugins and its
 * onListen hooks; `close()` stops taking requests, closes the WebSockets with 1001, lets the
 * open requests finish and runs the onClose hooks.
 */
export async function serve(app, options = {}) {
  const Bun = globalThis.Bun;
  if (!Bun) throw new Error("@inkanjs/bun runs under Bun: start the server with `bun`, or use app.listen() on Node");
  const { port = Number(process.env.PORT ?? 3000), hostname = "0.0.0.0", tls, drain = 10_000 } = options;
  const signals = options.signals ?? app.options.gracefulShutdown;
  await app.ready();
  const secure = Boolean(tls);

  const routes = app.routes().filter((r) => r.method === "WS");
  // as app.listen(): an app without WebSocket routes answers upgrades as plain requests
  const sockets = routes.length ? websockets(app, routes, secure) : undefined;

  const server = Bun.serve({
    port,
    hostname,
    ...(tls && { tls }),
    fetch(req, srv) {
      const remote = srv.requestIP(req)?.address;
      if (sockets && req.headers.has("upgrade") && /\bupgrade\b/i.test(req.headers.get("connection") ?? "")) return sockets.upgrade(req, srv, remote);
      return app.fetch(req, { remote });
    },
    ...(sockets && { websocket: sockets.handlers }),
  });

  const actual = server.port;
  const url = `${secure ? "https" : "http"}://${hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname}:${actual}`;
  await app.started();
  say(app, "listening", url);

  let closing;
  const close = () =>
    (closing ??= (async () => {
      // the WebSockets close with 1001, as with app.listen(); the open requests may finish
      const gone = sockets?.shutdown();
      const stopped = Promise.all([server.stop(), gone]);
      await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, drain).unref?.())]);
      server.stop(true); // whatever is left after the wait
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
    /** Bun's server, for what this does not cover (publish, subscribe, reload). */
    server,
    /** Stops taking requests, closes the WebSockets with 1001, lets the open requests finish, then runs the onClose hooks. */
    close,
  };
}

/**
 * The app's WebSocket routes on Bun's websockets. The app decides every upgrade itself,
 * through app.upgrade(): the route, the origin, maxConnections, the hooks, the security and
 * the input checks, the handshake timeout. It runs the socket too, on the transport this
 * hands it: the contracts, the limits, the close codes, the heartbeat. Bun does the wire.
 */
function websockets(app, routes, secure) {
  const largest = Math.max(...routes.map((r) => r.spec.maxMessage ?? app.options.ws?.maxMessage ?? 1024 * 1024));
  const open = new Set();
  let closing = false;
  let empty;

  async function upgrade(req, srv, remote) {
    const at = new URL(req.url);
    const headers = {};
    req.headers.forEach((value, name) => (headers[name] = value)); // names come lower-cased
    const r = await app.upgrade({ method: req.method, url: at.pathname + at.search, headers, remote, secure });
    if (r.status !== 101) {
      if (!r.response) return cut(); // no answer in time: the connection just ends
      const a = r.response;
      const h = new Headers(a.headers);
      for (const cookie of a.cookies ?? []) h.append("set-cookie", cookie); // one Set-Cookie per cookie
      a.done?.();
      return new Response(a.body ?? null, { status: a.status, headers: h });
    }
    if (closing || req.signal?.aborted) {
      r.cancel();
      return cut();
    }
    const h = new Headers(r.headers);
    for (const cookie of r.cookies) h.append("set-cookie", cookie);
    // Bun writes the 101 with its accept key; no subprotocol and no extension, as with app.listen()
    if (srv.upgrade(req, { headers: h, data: { r } })) return;
    // Bun did not take it (a key it does not accept): the app does not say 101 to those
    r.cancel();
    const body = JSON.stringify({ type: "bad-handshake", title: "Bad Request", status: 400, detail: "Not a WebSocket handshake", instance: at.pathname + at.search });
    return new Response(body, { status: 400, headers: { "content-type": "application/problem+json" } });
  }

  const handlers = {
    // each route holds its own maxMessage in the app; Bun cuts off what no route would take
    maxPayloadLength: largest,
    // the app's heartbeat (per route) pings; Bun neither pings nor times out on its own
    idleTimeout: 0,
    sendPings: false,
    // nothing is dropped: the app waits for the drain, and cuts off a socket that holds too much (1008)
    backpressureLimit: 2 ** 30,
    closeOnBackpressureLimit: false,
    perMessageDeflate: false,
    open(ws) {
      const d = ws.data;
      if (closing) {
        d.r.cancel();
        return void ws.close(1001, SHUTDOWN);
      }
      open.add(ws);
      d.ev = d.r.accept({
        send(data, binary) {
          if (d.gone) return;
          const sent = binary ? ws.sendBinary(data) : ws.sendText(typeof data === "string" ? data : Buffer.from(data).toString());
          return sent > 0; // -1: it waits in Bun, the app's next send waits for the drain
        },
        close(code, reason) {
          if (d.gone) return;
          if (code === 1006) ws.terminate(); // cut off, no close frame
          else ws.close(code, reason);
        },
        ping() {
          if (!d.gone) ws.ping();
        },
        get bufferedAmount() {
          return d.gone || typeof ws.getBufferedAmount !== "function" ? 0 : ws.getBufferedAmount();
        },
      });
      // the handler closed it while it was being accepted, and Bun reported that already
      if (d.ended) d.ev.close(...d.ended);
    },
    message: (ws, message) => ws.data.ev?.message(message, typeof message !== "string"),
    drain: (ws) => ws.data.ev?.drain(),
    pong: (ws) => ws.data.ev?.pong(),
    close(ws, code, reason) {
      const d = ws.data;
      d.gone = true;
      open.delete(ws);
      if (d.ev) d.ev.close(code, reason ?? "");
      else d.ended = [code, reason ?? ""];
      if (!open.size) empty?.();
    },
  };

  return {
    upgrade,
    handlers,
    /** For close(): the open sockets end with 1001. Resolves once Bun reported them all closed. */
    shutdown() {
      closing = true;
      if (!open.size) return;
      const done = new Promise((resolve) => (empty = resolve));
      for (const ws of open) ws.close(1001, SHUTDOWN);
      return done;
    },
  };
}

/** A response whose body fails at once: Bun drops the connection without an answer. */
function cut() {
  return new Response(
    new ReadableStream({
      start(c) {
        c.error(new Error("the handshake got no answer in time"));
      },
    }),
  );
}

/** One line in the app's log, in its format: what app.listen() would say, said here. */
function say(app, msg, url) {
  const { log, logger } = app.options;
  if (!log || logger) return;
  if (log === "json") console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...(url && { url, server: "Bun" }) }));
  else console.log(url ? `  印 ${msg} on ${url} (Bun)` : `\n  ${msg}`);
}
