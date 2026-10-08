# Changelog

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
