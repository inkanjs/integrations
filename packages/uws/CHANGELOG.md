# Changelog

## 0.3.0 (not released yet)

- A route's own `bodyLimit` holds, through `app.bodyFor()` (inkan 0.5 and later): 413 past
  it, declared or chunked, in the problem shape inkan answers with.
- A `t.stream()` route gets its body unread, as it arrives, instead of buffered; the socket
  is paused while the handler falls behind.
- Cookies on the answer (inkan 0.6 and later) go out as one `Set-Cookie` header each.

## 0.2.0

- `close()` closes gently: it stops taking requests, lets the open ones finish, ends the
  event streams, then runs the onClose hooks. `drain` says how long it waits.
- SIGINT and SIGTERM close and exit, as `app.listen()` does; a second one exits at once.
  On by default when the app has `gracefulShutdown`, or set `signals`.
- `tls: { key, cert }`: HTTPS, on uWebSockets.js's own TLS.
- `server.url`, and a line in the app's log when it listens.

## 0.1.0

- `serve(app)`: an inkan app on uWebSockets.js, through `app.exchange()`.
