# Changelog

## 0.1.0 (unreleased)

- `serve(app, { port, hostname, tls, signals, drain })`: an inkan app on `Bun.serve`. HTTP
  through `app.fetch()`, with the client's address from `server.requestIP()`.
- WebSocket routes (`app.ws()`) on Bun's websockets through `app.upgrade()`: the app decides
  the upgrade and runs the socket (contracts, `maxMessage`, close codes, heartbeat,
  backpressure); Bun carries the frames.
- `close()` closes gently: it stops taking requests, closes the WebSockets with 1001, lets the
  open requests finish, then runs the onClose hooks. SIGINT and SIGTERM close and exit when
  the app has `gracefulShutdown`, or with `signals`.
- Needs inkan 0.9 (peer `>=0.9.0 <1.0.0`) and Bun 1.1 or later.
