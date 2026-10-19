// The typed inkan client for TanStack Query. query() and mutation() only build the options
// every TanStack adapter takes (React, Vue, Svelte, Solid), so this needs none of them: the
// client already knows every type, and a failed answer becomes a ProblemError that the
// query shows as its error, instead of a value it would cache as data.
//
//   const q = queries(shop);
//   useQuery(q.get("/teas/:id", { params: { id } }));
//   useMutation(q.post("/teas"));
//   queryClient.invalidateQueries({ queryKey: q.key("/teas/:id") });
//
// Live data, server-sent events and WebSockets, is no query: follow() and connect() keep its
// state without any framework, and @inkanjs/query/react makes hooks of them.

/** A failed answer: the RFC 9457 problem document the server sent, and its status. */
export class ProblemError extends Error {
  constructor(answer) {
    const p = answer.problem ?? {};
    super(p.detail ?? p.title ?? `The server answered ${answer.status}`);
    this.name = "ProblemError";
    this.status = answer.status;
    this.problem = p;
    this.type = p.type;
  }
}

/** Whether `err` is a ProblemError, and when a type is given, one of that type. */
export function isProblem(err, type) {
  return err instanceof ProblemError && (type === undefined || err.type === type);
}

/**
 * For `retry`: tries again up to `times` for what may pass by itself (a dropped connection,
 * a 5xx, a 429), never for a problem the same request would only get again (a 400, a 404).
 */
export function retry(times = 3) {
  return (failures, err) => failures < times && !(err instanceof ProblemError && err.status < 500 && err.status !== 429);
}

/** The data of a successful answer; a failed one is thrown as a ProblemError. */
export function unwrap(answer) {
  if (answer.ok) return answer.data;
  throw new ProblemError(answer);
}

/** Options for useQuery / createQuery: a key, and a call of the typed client. */
export function query(queryKey, call) {
  return { queryKey, queryFn: async () => unwrap(await call()) };
}

/** Options for useMutation / createMutation: a call of the typed client that takes the variables. */
export function mutation(call) {
  return { mutationFn: async (variables) => unwrap(await call(variables)) };
}

/** What a stream that did not open threw (the client's StreamError) as a ProblemError. */
function asError(err) {
  if (err instanceof ProblemError) return err;
  if (err instanceof Error && typeof err.status === "number" && err.problem) return new ProblemError(err);
  return err instanceof Error ? err : new Error(String(err));
}

const backoff = (failures) => Math.min(1000 * 2 ** (failures - 1), 30_000);

/**
 * Follows an event stream (`q.events(path, input)`) until it ends, fails or `signal` aborts,
 * and tells `onChange` how it stands, first as it starts and then after every event. A
 * stream that fails to open or breaks off is opened again only as `retry` says: by default
 * never, since a job's stream ends, and an ended stream stays closed either way. Returns
 * the function that stops it.
 */
export function follow(source, options = {}) {
  const stop = new AbortController();
  const outer = options.signal;
  if (outer?.aborted) stop.abort();
  else outer?.addEventListener("abort", () => stop.abort(), { once: true });
  let state = { last: undefined, byName: {}, status: "connecting", error: undefined };
  const set = (next) => {
    if (stop.signal.aborted) return;
    state = { ...state, ...next };
    options.onChange?.(state);
  };
  options.onChange?.(state);
  (async () => {
    for (let failures = 0; !stop.signal.aborted; ) {
      try {
        for await (const e of source.open(stop.signal)) {
          if (stop.signal.aborted) return;
          failures = 0;
          const event = e.id === undefined ? { event: e.event, data: e.data } : { event: e.event, data: e.data, id: e.id };
          set({ status: "open", error: undefined, last: event, byName: { ...state.byName, [e.event]: e.data } });
          if (!stop.signal.aborted) options.onEvent?.(event);
        }
        return set({ status: "closed" });
      } catch (err) {
        if (stop.signal.aborted) return;
        const error = asError(err);
        const again = options.retry;
        const go = typeof again === "function" ? again(failures, error) : typeof again === "number" ? failures < again : again === true;
        if (!go) return set({ status: "error", error });
        failures++;
        set({ status: "connecting", error });
        const wait = options.retryDelay ?? backoff;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, typeof wait === "function" ? wait(failures, error) : wait);
          stop.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        });
      }
    }
  })();
  return () => stop.abort();
}

/**
 * Opens a WebSocket (`q.ws(path, input)`) and tells `onChange` how it stands: its status and
 * the last message. `send` waits for the socket to open; `close` closes it, and after that
 * nothing is told any more.
 */
export function connect(source, options = {}) {
  const socket = source.open();
  let closed = false;
  let state = { last: undefined, status: "connecting", error: undefined, socket };
  const set = (next) => {
    if (closed) return;
    state = { ...state, ...next };
    options.onChange?.(state);
  };
  options.onChange?.(state);
  socket.ready.then(() => state.status === "connecting" && set({ status: "open" }), () => {});
  socket.on("message", (message) => {
    if (closed) return;
    set({ last: message });
    options.onMessage?.(message);
  });
  socket.on("close", (code) => {
    if (state.status === "connecting") set({ status: "error", error: new Error(`The WebSocket closed before it opened (${code})`) });
    else set({ status: "closed" });
  });
  return {
    socket,
    send(value) {
      if (socket.raw.readyState === 1) socket.send(value);
      else if (socket.raw.readyState === 0) socket.ready.then(() => socket.send(value), () => {});
    },
    close() {
      closed = true;
      if (socket.raw.readyState < 2) socket.close();
    },
  };
}

/**
 * Query and mutation options straight from the typed client, keyed by path and input:
 * `q.get(path, input)` is a query, `q.post(path)` and the others a mutation that takes the
 * input as its variables, and `q.key(path)` the key of every query of that path.
 * `q.events(path, input)` and `q.ws(path, input)` are live sources for follow() and
 * connect(), or useEvents and useSocket: a key, and how to open them.
 */
export function queries(client) {
  const key = (path, input) => (input === undefined ? [path] : [path, input]);
  const write = (method) => (path) => mutation((input) => client[method](path, input));
  return {
    key,
    get: (path, input) => query(key(path, input), () => client.get(path, input)),
    post: write("post"),
    put: write("put"),
    patch: write("patch"),
    delete: write("delete"),
    events: (path, input) => ({ key: key(path, input), open: (signal) => client.events(path, { ...input, signal }) }),
    ws: (path, input) => ({ key: key(path, input), open: () => client.ws(path, input) }),
  };
}
