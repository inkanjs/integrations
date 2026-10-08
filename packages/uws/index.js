// An inkan app on uWebSockets.js instead of node:http. Everything goes through
// app.exchange(), the one door inkan has for any server: the contracts, hooks, problems
// and streams are the app's, this file only moves bytes between the socket and the app.
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
  server.any("/*", (res, req) => {
    // the request is only readable now, before the first await
    const method = req.getCaseSensitiveMethod().toUpperCase();
    const query = req.getQuery();
    const url = req.getUrl() + (query ? `?${query}` : "");
    const headers = {};
    req.forEach((name, value) => (headers[name] = name in headers ? `${headers[name]}, ${value}` : value));
    const remote = text(res.getRemoteAddressAsText());

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
      if (open > 0) {
        await new Promise((resolve) => {
          idle = resolve;
          setTimeout(resolve, drain).unref();
        });
      }
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

/** One line in the app's log, in its format: what app.listen() would say, said here. */
function say(app, msg, url) {
  const { log, logger } = app.options;
  if (!log || logger) return;
  if (log === "json") console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...(url && { url, server: "uWebSockets.js" }) }));
  else console.log(url ? `  印 ${msg} on ${url} (uWebSockets.js)` : `\n  ${msg}`);
}
