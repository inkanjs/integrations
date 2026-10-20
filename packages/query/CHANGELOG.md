# Changelog

## 0.3.0

- `q.events(path, input)` and `q.ws(path, input)`: live sources for a route that answers
  with `t.events(...)` and for an `app.ws` route, typed from it. A path that is no stream
  or no WebSocket is a type error.
- `@inkanjs/query/react`: `useEvents(source, { enabled, onEvent, retry, retryDelay })` gives
  `{ last, byName, status, error }`, every event typed by its name; `useSocket(source,
  { enabled, onMessage })` gives `{ send, last, status, error, socket }`. Both close on
  unmount and open again when the path or input changes. `react` is an optional peer.
- `follow(source, options)` and `connect(source, options)`: what the hooks run, without
  React, for Vue, Svelte, Solid or a store of your own.
- A stream that does not open is a `ProblemError`, so `isProblem` and `retry()` work on it.
  No reconnect unless `retry` asks for one. Events are not written to the query cache;
  `onEvent` with `setQueryData` does it in a line (see the README).
- Needs `@vxnsin/inkan` 0.7 or later, for `client.events` and `client.ws`.

## 0.2.0

- `queries(client)`: query and mutation options straight from the typed client.
  `q.get(path, input)` keys a query by its path and input, `q.post(path)` and the others
  are mutations that take the input as their variables, `q.key(path)` reaches every query
  of a path for invalidating. A path the API does not have is a type error.
- `isProblem(err, type?)`: tells a ProblemError, and one of a given type, as a type guard.
- `retry(times?)`: for TanStack's `retry`. Tries again for a dropped connection, a 5xx or
  a 429, never for a problem the same request would only get again.

## 0.1.0

- `query`, `mutation`, `unwrap` and `ProblemError`.
