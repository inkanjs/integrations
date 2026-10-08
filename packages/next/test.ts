import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, plugin, routes, t } from "@vxnsin/inkan";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { direct, handlers, pages } from "./index.js";

// The app as it would sit behind app/api/[...path]/route.ts: everything under /api.
const api = plugin((p) => {
  p.get("/teas/:id", { params: t.object({ id: t.int() }), response: { 200: t.object({ id: t.int(), name: t.string() }) } }, ({ params }) => ({
    id: params.id,
    name: "Sencha",
    secret: "kept back",
  }));
  p.post("/teas", { body: t.object({ name: t.string().min(1) }), response: { 201: t.object({ name: t.string() }) } }, ({ body }) => body);
});
const app = inkan({ log: false, docs: "/api/docs", openapi: "/api/openapi.json", inspector: "/api/_inkan" }).register(api, { prefix: "/api" });
const route = handlers(app);
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

test("every method is a route handler, and they are the app", async () => {
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const) assert.equal(typeof route[m], "function");
  const r = await route.GET(req("/api/teas/7"));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { id: 7, name: "Sencha" });
});

test("bodies are checked, problems are problems", async () => {
  const ok = await route.POST(req("/api/teas", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Mio"}' }));
  assert.equal(ok.status, 201);
  const bad = await route.POST(req("/api/teas", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":""}' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("content-type"), "application/problem+json");
});

test("the docs and the document live under /api too", async () => {
  assert.equal((await route.GET(req("/api/docs"))).status, 200);
  const doc = (await (await route.GET(req("/api/openapi.json"))).json()) as { paths: Record<string, unknown> };
  assert.ok(doc.paths["/api/teas/{id}"]);
});

test("the inspector answers under next dev, and stays shut in production", async () => {
  const dev = inkan({ log: false, dev: true, inspector: "/api/_inkan" });
  const env = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    assert.equal((await handlers(dev).GET(req("/api/_inkan"))).status, 200);
    process.env.NODE_ENV = "production";
    assert.equal((await handlers(dev).GET(req("/api/_inkan"))).status, 404);
  } finally {
    process.env.NODE_ENV = env;
  }
});

// A Pages Router API route, on a plain node:http server the way Next runs one: with Next's
// body parser off, or on, when it has already read the body into req.body.
async function onPages(parse: boolean, run: (base: string) => Promise<void>) {
  const route = pages(app);
  const server = createServer(async (req, res) => {
    if (parse) {
      let text = "";
      for await (const c of req) text += c;
      const type = req.headers["content-type"] ?? "";
      (req as IncomingMessage & { body?: unknown }).body = !text ? "" : type.includes("json") ? JSON.parse(text) : text;
    }
    await route(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

for (const parse of [false, true]) {
  test(`the Pages Router, with Next's body parser ${parse ? "on" : "off"}`, async () => {
    await onPages(parse, async (base) => {
      const r = await fetch(`${base}/api/teas/7`);
      assert.deepEqual(await r.json(), { id: 7, name: "Sencha" });
      const ok = await fetch(`${base}/api/teas`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Mio"}' });
      assert.equal(ok.status, 201);
      assert.deepEqual(await ok.json(), { name: "Mio" });
      const bad = await fetch(`${base}/api/teas`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":""}' });
      assert.equal(bad.status, 400);
      assert.equal(bad.headers.get("content-type"), "application/problem+json");
    });
  });
}

test("direct() is the typed client, without a network", async () => {
  const shop = inkan({ log: false }).mount(
    "/api",
    routes().get("/teas/:id", { params: t.object({ id: t.int() }), response: { 200: t.object({ id: t.int(), name: t.string() }) } }, ({ params }) => ({ id: params.id, name: "Hojicha" })),
  ).get("/who", ({ headers }) => ({ cookie: (headers as Record<string, string>).cookie }));
  const api = direct(shop, { headers: () => ({ cookie: "session=1" }) });
  const r = await api.get("/api/teas/:id", { params: { id: 3 } });
  assert.ok(r.ok);
  const name: string = r.data.name;
  assert.equal(name, "Hojicha");
  // @ts-expect-error there is no such route
  void (() => api.get("/coffee"));
  const who = await api.get("/who");
  assert.deepEqual(who.ok && who.data, { cookie: "session=1" }, "headers go along, say a cookie from next/headers");
});
