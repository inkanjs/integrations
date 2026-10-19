import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient, MutationObserver } from "@tanstack/query-core";
import { inkan, problem, sse, t } from "@vxnsin/inkan";
import { client } from "@vxnsin/inkan/client";
import { connect, follow, isProblem, mutation, ProblemError, queries, query, retry } from "./index.js";
import type { Connection, EventsState, LiveEvents, SocketState } from "./index.js";
import { useEvents, useSocket } from "./react.js";

type EventOf<S> = S extends LiveEvents<infer E> ? E : never;

const Tea = t.object({ id: t.int(), name: t.string(), brewed: t.date() });
const teas = [{ id: 1, name: "Sencha", brewed: new Date("2026-01-02T03:04:05.000Z") }];
const app = inkan({ log: false })
  .get("/teas/:id", { params: t.object({ id: t.int() }), response: { 200: Tea, 404: t.problem() } }, ({ params }) => {
    const tea = teas.find((x) => x.id === params.id);
    if (!tea) throw problem(404, "tea-not-found", `There is no tea ${params.id}`);
    return tea;
  })
  .post("/teas", { body: t.object({ name: t.string().min(1) }), response: { 201: Tea } }, ({ body }) => {
    const tea = { id: teas.length + 1, name: body.name, brewed: new Date() };
    teas.push(tea);
    return tea;
  });

// the typed client, talking to the app through app.fetch: no port needed
const shop = client<typeof app>("http://shop.test", { fetch: (url, init) => app.fetch(new Request(url, init)) });

test("a query has the contract's data, typed, as JSON brings it", async () => {
  const qc = new QueryClient();
  const tea = await qc.fetchQuery(query(["tea", 1], () => shop.get("/teas/:id", { params: { id: 1 } })));
  assert.deepEqual(tea, { id: 1, name: "Sencha", brewed: "2026-01-02T03:04:05.000Z" });
  const name: string = tea.name;
  const brewed: string = tea.brewed; // a Date arrives as a string, and the type says so
  assert.ok(name && brewed);
  // @ts-expect-error the contract has no price
  void tea.price;
});

test("a failed answer is the query's error, with the problem document", async () => {
  const qc = new QueryClient();
  await assert.rejects(
    qc.fetchQuery({ ...query(["tea", 99], () => shop.get("/teas/:id", { params: { id: 99 } })), retry: false }),
    (err: unknown) => err instanceof ProblemError && err.status === 404 && err.type === "tea-not-found" && /no tea 99/.test(err.message),
  );
});

test("a mutation takes typed variables and throws problems too", async () => {
  const qc = new QueryClient();
  const add = new MutationObserver(qc, mutation((tea: { name: string }) => shop.post("/teas", { body: tea })));
  const made = await add.mutate({ name: "Bancha" });
  assert.equal(made.name, "Bancha");
  await assert.rejects(add.mutate({ name: "" }), (err: unknown) => err instanceof ProblemError && err.status === 400 && err.type === "validation");
});

test("queries() keys and types everything from the path", async () => {
  const qc = new QueryClient();
  const q = queries(shop);
  const options = q.get("/teas/:id", { params: { id: 1 } });
  assert.deepEqual(options.queryKey, ["/teas/:id", { params: { id: 1 } }]);
  const tea = await qc.fetchQuery(options);
  const name: string = tea.name;
  assert.equal(name, "Sencha");
  // @ts-expect-error the contract has no price
  void tea.price;
  // @ts-expect-error the path needs its params
  void (() => q.get("/teas/:id"));
  // @ts-expect-error there is no such GET
  void (() => q.get("/coffee"));

  const add = new MutationObserver(qc, q.post("/teas"));
  const made = await add.mutate({ body: { name: "Gyokuro" } });
  assert.equal(made.name, "Gyokuro");
  // @ts-expect-error the body needs a name
  void (() => add.mutate({ body: {} }));

  await qc.invalidateQueries({ queryKey: q.key("/teas/:id") });
  assert.equal(qc.getQueryState(options.queryKey)?.isInvalidated, true, "the path's key reaches every query of it");
});

test("isProblem and retry tell problems that pass from those that stay", async () => {
  const notFound = new ProblemError({ status: 404, problem: { type: "tea-not-found", title: "Not Found", status: 404 } });
  const down = new ProblemError({ status: 503, problem: { type: "unavailable", title: "Service Unavailable", status: 503 } });
  assert.ok(isProblem(notFound) && isProblem(notFound, "tea-not-found"));
  assert.ok(!isProblem(notFound, "validation") && !isProblem(new Error("x")));
  const again = retry(2);
  assert.equal(again(0, notFound), false, "a 404 stays a 404");
  assert.equal(again(0, down), true);
  assert.equal(again(0, new TypeError("fetch failed")), true);
  assert.equal(again(0, new ProblemError({ status: 429, problem: {} })), true);
  assert.equal(again(2, down), false, "and only so often");
});

// ---- live data

const Progress = t.object({ done: t.int(), total: t.int() });
let release: () => void = () => {};
const live = inkan({ log: false })
  .job("/exports", { body: t.object({ rows: t.int() }), progress: Progress, result: t.object({ url: t.string() }) }, async (job) => {
    await new Promise<void>((resolve) => (release = resolve)); // waits until someone follows it
    for (let done = 1; done <= job.input.rows; done++) job.progress({ done, total: job.input.rows });
    return { url: `/files/${job.id}.csv` };
  })
  .get("/ticks", { response: { 200: t.events({ tick: t.object({ n: t.int() }) }) } }, () =>
    sse(async function* (signal) {
      for (let n = 0; !signal.aborted; n++) {
        yield { event: "tick", data: { n } };
        await new Promise((r) => setTimeout(r, 5));
      }
    }),
  )
  .ws(
    "/rooms/:room",
    {
      params: t.object({ room: t.string().min(3) }),
      message: t.object({ type: t.literal("say"), text: t.string() }),
      send: t.object({ type: t.literal("said"), room: t.string(), text: t.string() }),
    },
    (socket, ctx) => socket.on("message", (m) => void socket.send({ type: "said", room: ctx.params.room, text: m.text })),
  );
const api = client<typeof live>("http://live.test", { fetch: (url, init) => live.fetch(new Request(url, init)) });

/** Resolves with the first state `check` accepts. */
function until<S>(start: (onChange: (s: S) => void) => unknown, check: (s: S) => boolean): Promise<S> {
  return new Promise((resolve) => {
    start((s) => {
      if (check(s)) resolve(s);
    });
  });
}

test("follow() follows a job: typed events, the latest of each, then closed", async () => {
  const qc = new QueryClient();
  const q = queries(api);
  const started = await new MutationObserver(qc, q.post("/exports")).mutate({ body: { rows: 3 } });
  const source = q.events("/exports/:id/events", { params: { id: started.id } });
  assert.deepEqual(source.key, ["/exports/:id/events", { params: { id: started.id } }]);

  const progress: number[] = [];
  const statuses: string[] = [];
  const end = await until<EventsState<EventOf<typeof source>>>(
    (onChange) =>
      follow(source, {
        onChange: (s) => (statuses.push(s.status), onChange(s)),
        onEvent: (e) => {
          if (e.event === "status") release(); // following now: let the job run
          if (e.event === "progress") progress.push(e.data.done); // narrowed by the name
          // @ts-expect-error a job's stream has no such event
          void (e.event === "tick");
        },
      }),
    (s) => s.status === "closed",
  );
  assert.equal(statuses[0], "connecting");
  assert.ok(statuses.includes("open"));
  assert.equal(end.byName.end?.state, "done");
  assert.deepEqual(end.byName.progress, { done: 3, total: 3 });
  assert.equal(end.last?.event, "end");
  assert.equal(progress.at(-1), 3);
  const total: number | undefined = end.byName.progress?.total;
  assert.equal(total, 3);
  // @ts-expect-error progress has no percent
  void end.byName.progress?.percent;

  const result = await qc.fetchQuery(q.get("/exports/:id/result", { params: { id: started.id } }));
  assert.equal(result.url, `/files/${started.id}.csv`);
});

test("follow() tells a stream that does not open as a ProblemError, and retries only as asked", async () => {
  const q = queries(api);
  const missing = q.events("/exports/:id/events", { params: { id: "nope" } });
  let opened = 0;
  const counted = { key: missing.key, open: (signal?: AbortSignal) => (opened++, missing.open(signal)) };
  const failed = await until<EventsState<EventOf<typeof missing>>>(
    (onChange) => follow(counted, { onChange, retry: retry(3), retryDelay: 0 }),
    (s) => s.status === "error",
  );
  assert.ok(isProblem(failed.error) && failed.error.status === 404);
  assert.equal(opened, 1, "a 404 is not tried again");

  let tries = 0;
  const broken = {
    key: ["broken"],
    open: (): AsyncIterable<{ event: "x"; data: number }> => ({
      [Symbol.asyncIterator]: () => ({ next: () => (tries++, Promise.reject(new TypeError("fetch failed"))) }),
    }),
  };
  const statuses: string[] = [];
  const gave = await until<EventsState<{ event: "x"; data: number }>>(
    (onChange) => follow(broken, { onChange: (s) => (statuses.push(s.status), onChange(s)), retry: 2, retryDelay: 0 }),
    (s) => s.status === "error",
  );
  assert.equal(tries, 3, "once, and twice again");
  assert.equal(gave.error?.message, "fetch failed");
  assert.deepEqual(statuses, ["connecting", "connecting", "connecting", "error"]);
});

test("follow() stops when told to, and tells nothing after", async () => {
  const q = queries(api);
  const changes: string[] = [];
  let stop = () => {};
  await until<EventsState<{ event: "tick"; data: { n: number } }>>(
    (onChange) => (stop = follow(q.events("/ticks"), { onChange: (s) => (changes.push(s.status), onChange(s)) })),
    (s) => (s.byName.tick?.n ?? 0) >= 2,
  );
  stop();
  const count = changes.length;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(changes.length, count);
});

type Say = { type: "say"; text: string };
type Said = { type: "said"; room: string; text: string };

test("connect() opens a typed WebSocket, sends before it is open, closes", async () => {
  const server = await live.listen(0, "127.0.0.1");
  try {
    const { port } = server.address() as { port: number };
    const q = queries(client<typeof live>(`http://127.0.0.1:${port}`));
    const statuses: string[] = [];
    let conn!: Connection<Say, Said>;
    const said = await until<SocketState<Say, Said>>(
      (onChange) => {
        conn = connect(q.ws("/rooms/:room", { params: { room: "tea" } }), { onChange: (s) => (statuses.push(s.status), onChange(s)) });
        conn.send({ type: "say", text: "hello" }); // still opening: goes once it is open
        // @ts-expect-error the route takes a say
        void (() => conn.send({ type: "shout", text: "x" }));
      },
      (s) => s.last !== undefined,
    );
    assert.deepEqual(said.last, { type: "said", room: "tea", text: "hello" });
    assert.deepEqual(statuses.slice(0, 2), ["connecting", "open"]);
    conn.close();

    const refused = await until<SocketState<Say, Said>>(
      (onChange) => connect(q.ws("/rooms/:room", { params: { room: "x" } }), { onChange }),
      (s) => s.status !== "connecting",
    );
    assert.equal(refused.status, "error", "a room name too short is a 400, and no socket");
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("the React hooks are typed from the route", () => {
  // types only: running them takes a renderer; follow() and connect() above are what they run
  const q = queries(api);
  const component = () => {
    const job = useEvents(q.events("/exports/:id/events", { params: { id: "1" } }), { retry: retry(2), onEvent: (e) => void e.event });
    const done: number | undefined = job.byName.progress?.done;
    const state: string | undefined = job.byName.end?.state;
    if (job.last?.event === "progress") void (job.last.data.total satisfies number);
    const status: "idle" | "connecting" | "open" | "closed" | "error" = job.status;
    // @ts-expect-error the events route needs its id
    void (() => useEvents(q.events("/exports/:id/events")));
    // @ts-expect-error a GET that is not a stream
    void (() => q.events("/exports/:id", { params: { id: "1" } }));

    const room = useSocket(q.ws("/rooms/:room", { params: { room: "tea" } }), { enabled: true, onMessage: (m) => void m.text });
    room.send({ type: "say", text: "hi" });
    // @ts-expect-error the route takes a text
    room.send({ type: "say" });
    const text: string | undefined = room.last?.text;
    // @ts-expect-error there is no such WebSocket route
    void (() => q.ws("/lobby"));
    return [done, state, status, text, room.socket?.raw];
  };
  assert.equal(typeof component, "function");
  assert.equal(typeof useEvents, "function");
  assert.equal(typeof useSocket, "function");
});
