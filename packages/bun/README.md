# @inkanjs/bun

Runs an [inkan](https://github.com/inkanjs/inkan) app on [Bun](https://bun.sh)'s
`Bun.serve`, WebSocket routes included. The app does not change: contracts, hooks, plugins,
problems, streams and the inspector work as they do with `app.listen()`. HTTP goes through
`app.fetch()`, Request in and Response out; WebSockets go through `app.upgrade()` (inkan
0.9), with Bun's own websockets carrying the frames.

## Install

```sh
bun add @inkanjs/inkan @inkanjs/bun
```

## Use

```ts
import { inkan, t } from "@inkanjs/inkan";
import { serve } from "@inkanjs/bun";

const app = inkan().get("/teas/:id", { params: t.object({ id: t.int() }) }, ({ params }) => ({ id: params.id }));

const server = await serve(app, { port: 3000 });
console.log(server.url);
// later
await server.close();
```

| option | |
| --- | --- |
| `port` | default `$PORT`, then 3000; 0 takes any free port, `server.port` says which |
| `hostname` | default `"0.0.0.0"` |
| `tls` | handed to `Bun.serve` as it is: `{ key: Bun.file("key.pem"), cert: Bun.file("cert.pem") }` |
| `signals` | close and exit on SIGINT and SIGTERM (a second one exits at once); default the app's `gracefulShutdown` |
| `drain` | how long `close()` waits for open requests and sockets, in ms; default 10 000 |

`serve` resolves once Bun listens, after the app's plugins and onListen hooks. The result
has `port`, `url`, `close()` and `server`, Bun's own server, for what this package does not
cover (publish and subscribe, `reload`). Without a WebSocket route `serve` just hands every
request to `app.fetch`, which you can also do yourself:

```ts
Bun.serve({ fetch: (req, server) => app.fetch(req, { remote: server.requestIP(req)?.address }) });
```

What this package adds to that line: the WebSocket routes, the app's onListen and onClose
hooks (`app.started()`, `app.stopped()`), the log line and the gentle close.

## WebSockets

An app with `app.ws()` routes gets them on Bun's websockets, nothing to set. The app decides
every upgrade, as under `app.listen()`: the route (an unknown path is a 404), the origin
check first (403, before any hook), `maxConnections` (503), then the hooks, security and the
params, query and headers checks, all within `handshakeTimeout`. A refusal goes out as the
app's answer; otherwise Bun writes the 101 with the answer's own headers (request id,
cookies). The handler and its socket are the same as on Node: the `message` contract (1007,
1003), `send` trimmed to its contract, `send()` resolving once Bun can take more, `ctx.signal`
aborted on close, 1011 when the handler throws, 1001 from `close()`.

| | |
| --- | --- |
| `maxMessage` | each route's own: past it the socket closes with 1009. Bun's `maxPayloadLength` is the largest `maxMessage` among the app's routes; past that Bun closes the socket itself |
| `heartbeat` | the route's own: the app pings through Bun and cuts off a peer that has not answered by the next ping. Bun's `idleTimeout` and `sendPings` are off |
| writing | a send that Bun has to hold makes the next `send()` wait for Bun's drain; past four times `maxMessage` (1 MiB at least) waiting, the socket is cut off with 1008. Bun drops nothing |
| reading | Bun cannot pause one socket: messages a handler has not taken yet wait in memory |
| `ctx.req` | undefined: there is no Node request. `ctx.ip`, `ctx.headers` and `ctx.secure` say what it would |
| subprotocols, compression | none, as with `app.listen()` |

## Closing

`await server.close()` stops taking requests, closes the WebSockets with 1001, lets the open
requests finish (Bun's `server.stop()`), and then runs the app's onClose hooks. After `drain`
milliseconds whatever is left is closed anyway (`server.stop(true)`); an endless event stream
is one of those, so keep `drain` short if your app has them.

## Tests

`bun run test.ts` in this folder, the `bun` job in CI. Under Node, `npm test` lists the same
cases as skipped: there is no `Bun.serve` to run them on.
