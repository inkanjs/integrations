import { inkan, plugin, t } from "@vxnsin/inkan";

const hello = "world";
// what the test reads: which app started and stopped, in this process
const events: string[] = ((globalThis as { inkanEvents?: string[] }).inkanEvents ??= []);

const api = plugin((p) => {
  p.get("/hello", () => ({ hello }));
  p.post("/teas", { body: t.object({ name: t.string().min(1) }), response: { 201: t.object({ name: t.string() }) } }, ({ body }) => body);
});

export const app = inkan({ log: false, docs: "/api/docs", openapi: "/api/openapi.json", inspector: "/api/_inkan" })
  .register(api, { prefix: "/api" })
  .onListen(() => void events.push(`listen ${hello}`))
  .onClose(() => void events.push(`close ${hello}`));
app.listen(); // stays quiet under Vite
