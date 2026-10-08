# inkan integrations

[inkan](https://github.com/inkanjs/inkan) where you already are. Each package is installed
on its own; inkan itself keeps no dependencies.

| package | what it does |
| --- | --- |
| [`@inkanjs/next`](packages/next) | An inkan app as Next.js route handlers: one line in `app/api/[...path]/route.ts`. |
| [`@inkanjs/vite`](packages/vite) | The API inside `vite dev`: one port with the frontend, reloaded on every save. Vue, React, Svelte, Solid. |
| [`@inkanjs/query`](packages/query) | The typed client for TanStack Query: data typed from the contract, problems as errors. |
| [`@inkanjs/uws`](packages/uws) | An inkan app on uWebSockets.js instead of node:http. |

Nuxt, SvelteKit, Astro and Remix need no package, see the [recipes](recipes): they hand their server routes a web
`Request` and want a `Response`, which is what `app.fetch` does.

Every package is tested against the published `@vxnsin/inkan` in CI, on Node 22, 24 and 26:

```sh
npm install
npm run typecheck
npm test
```

MIT licensed.

## Releasing a package

A GitHub release with the tag `<package>-v<version>`, as `next-v0.1.0`, publishes that one
package from `packages/<package>`, after its tests: to npmjs.com with provenance, and to
GitHub Packages.
