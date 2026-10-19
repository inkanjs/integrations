# @inkanjs/uws

Runs an [inkan](https://github.com/inkanjs/inkan) app on
[uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) instead of `node:http`.
The app does not change: contracts, hooks, plugins, problems, streams and the inspector
all work as they do with `app.listen()`, and so do WebSocket routes (`app.ws()`, inkan 0.8).
This package only moves bytes between the socket and `app.exchange()`, the one door inkan
has for any server, and `app.upgradeListener` for WebSockets.

## Install

uWebSockets.js is not on npm; it comes from its GitHub releases. npm 12 refuses packages
from git unless you say so, which is why it is a peer you install yourself, on purpose:

```sh
npm install @inkanjs/uws
npm install --allow-git=all "uWebSockets.js@github:uNetworking/uWebSockets.js#v20.71.0"
```

## Use

```ts
import { inkan } from "@vxnsin/inkan";
import { serve } from "@inkanjs/uws";

const app = inkan().get("/hello", () => ({ hello: "world" }));
const server = await serve(app, { port: 3000 });
server.url; // "http://localhost:3000"
```

| option | default | |
| --- | --- | --- |
| `port` | `$PORT`, then 3000 | 0 takes any free port; `server.port` says which |
| `host` | `"0.0.0.0"` | |
| `tls` | none | `{ key, cert, passphrase? }`, paths to PEM files: HTTPS, on uWS's own TLS |
| `signals` | the app's `gracefulShutdown` | on SIGINT or SIGTERM, close and exit; a second one exits at once |
| `drain` | 10 000 | how long `close()` waits for open requests, in ms |

## Bodies and cookies

A body is held to its route's own `bodyLimit` (or the app's), with the same 413 problem
`app.listen()` answers, whether the length is declared or the body comes chunked. A
`t.stream()` route gets its body unread, chunk by chunk as it arrives; when the handler
falls behind, the socket is paused until it catches up. Both need inkan 0.5 or later; with
an older one every route has the app's limit. Cookies a handler sets (inkan 0.6 and later)
go out as one `Set-Cookie` header each.

## WebSockets

An app with `app.ws()` routes gets them on uWebSockets.js's own websockets, nothing to set:

```ts
const app = inkan().ws("/rooms/:room", { message: Say, send: Said }, (socket, ctx) => {
  socket.on("message", (m) => void socket.send({ type: "said", text: m.text }));
});
await serve(app, { port: 3000 });
```

The app decides every upgrade, as under `app.listen()`: the route (an unknown path is a 404),
the origin check first (403 `origin-not-allowed`, before any hook), `maxConnections` (503),
then the hooks, the security and the params, query and headers checks (401, 400, …), all
within `handshakeTimeout`. A refusal goes out as the app wrote it; otherwise uWS writes the
101, with the answer's own headers (request id, cookies). The handler and the socket it gets
are the same: messages checked against `message` (not JSON or breaking it: 1007; binary on
such a route: 1003), `send` trimmed to its contract (and checked in development), `send()`
resolving once the socket can take more, `ctx.signal` aborted on close, 1011 when the handler
throws. `close()` ends every open socket with 1001 before the onClose hooks.

uWS does the wire: the handshake, frames, UTF-8, fragments, pongs. The app's frames go out as
uWS sends, pings and ends; what the client sends reaches the app as one frame per message.

Limits, and where they differ from `app.listen()`:

| | |
| --- | --- |
| `maxMessage` | each route's own: past it the socket closes with 1009 and says why. uWS's `maxPayloadLength` is the largest `maxMessage` among the app's routes; a message past that is cut off by uWS before the app sees it, **without a close frame**: the client sees 1006, and so does the handler's close listener (uWebSockets.js 20.71 sends no 1009). uWS puts fragments together, so the 1024-fragment rule is left to its cap on the size |
| `heartbeat` | the route's own, as with `app.listen()`: the app pings through uWS and cuts off a peer that has not answered by the next ping. uWS's `idleTimeout` and automatic pings are off |
| writing | past 64 KiB waiting in uWS, the next frame waits for uWS's drain; past four times `maxMessage` (1 MiB at least) waiting in all, the socket is cut off with 1008, as with `app.listen()`. uWS never drops a message |
| reading | uWS cannot pause one socket: messages a handler has not taken yet wait in memory, the client is not slowed down |
| pings | uWS answers the client's pings itself |
| `ctx.req` | a stand-in for Node's request (method, url, headers, the socket's address), not an `IncomingMessage` |

## Closing

`await server.close()` closes as `app.listen()` does on a ctrl+c: it stops taking requests,
lets the open ones finish, ends the event streams (an endless one would otherwise keep it
waiting for as long as its client stays), closes the WebSockets with 1001, and then runs the
app's onClose hooks. After `drain` milliseconds whatever is left is closed anyway.

## What is the same, what is not

The same set of requests runs against `app.listen()`, `app.fetch()` and this adapter in
CI: routes, bodies and the body limit, problems, HEAD, query and headers, endless event
streams that stop when the client leaves, onListen and onClose. The WebSocket routes run
against the cases inkan tests them with on node:http (websockets.ts). `workers` (the cluster
mode) is for `app.listen()`; run one process per core yourself if you need it here.

Measure before you switch: the bench in the inkan repository has an `inkan-uws` entry
next to `inkan` on node:http.
