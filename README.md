# inkan integrations

[inkan](https://github.com/inkanjs/inkan) where you already are. Each package is installed
on its own; inkan itself keeps no dependencies.

| package | what it does |
| --- | --- |
| [`@inkanjs/next`](packages/next) | An inkan app in Next.js: App Router route handlers, a Pages Router API route, and the typed client for Server Components. |
| [`@inkanjs/vite`](packages/vite) | The API inside `vite dev` and `vite preview`: one port with the frontend, reloaded on every save. Vue, React, Svelte, Solid. |
| [`@inkanjs/query`](packages/query) | The typed client for TanStack Query: keys and data from the contract, problems as errors. |
| [`@inkanjs/uws`](packages/uws) | An inkan app on uWebSockets.js instead of node:http, with HTTPS and a gentle close. |

Nuxt, SvelteKit, Astro and Remix need no package, see the [recipes](recipes): they hand their server routes a web
`Request` and want a `Response`, which is what `app.fetch` does.

Every package is tested against the published `@vxnsin/inkan` in CI, on Node 22, 24 and 26,
and `@inkanjs/next` once more inside a real `next build` and `next start`:

```sh
npm install
npm run typecheck
npm test
```

MIT licensed.

## Releasing a package

A GitHub release with the tag `<package>-v<version>`, as `next-v0.1.0`, publishes that one
package from `packages/<package>`, after its tests: to npmjs.com with provenance, and to
GitHub Packages. Each package keeps a CHANGELOG.md; its section is the release notes.
