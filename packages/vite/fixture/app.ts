import { inkan, plugin, t } from "@vxnsin/inkan";

const api = plugin((p) => {
  p.get("/hello", () => ({ hello: "world" }));
  p.post("/teas", { body: t.object({ name: t.string().min(1) }), response: { 201: t.object({ name: t.string() }) } }, ({ body }) => body);
});

export const app = inkan({ log: false, docs: "/api/docs", openapi: "/api/openapi.json", inspector: "/api/_inkan" }).register(api, { prefix: "/api" });
app.listen(); // stays quiet under Vite
