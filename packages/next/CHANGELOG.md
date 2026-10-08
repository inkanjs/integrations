# Changelog

## 0.2.0

- `pages(app)`: the app as a Pages Router API route, `export default pages(app)` in
  `pages/api/[...path].ts`. With Next's body parser off the app reads the body itself; left
  on, the body Next parsed is written back, so the contract still sees it.
- `direct(app)`: the typed client for Server Components and Server Actions. It calls the
  app in the same process, without a port or the network, with the same contracts, hooks
  and problems; `headers` hands along a cookie or a token.
- Tested inside a real Next.js in CI: `next build`, `next start`, then requests against the
  App Router, the Pages Router and a Server Component.

## 0.1.0

- `handlers(app)`: every method of an App Router route file, all of them `app.fetch`.
