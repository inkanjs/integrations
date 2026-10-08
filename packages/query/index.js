// The typed inkan client for TanStack Query. query() and mutation() only build the options
// every TanStack adapter takes (React, Vue, Svelte, Solid), so this needs none of them: the
// client already knows every type, and a failed answer becomes a ProblemError that the
// query shows as its error, instead of a value it would cache as data.
//
//   const q = queries(shop);
//   useQuery(q.get("/teas/:id", { params: { id } }));
//   useMutation(q.post("/teas"));
//   queryClient.invalidateQueries({ queryKey: q.key("/teas/:id") });

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

/**
 * Query and mutation options straight from the typed client, keyed by path and input:
 * `q.get(path, input)` is a query, `q.post(path)` and the others a mutation that takes the
 * input as its variables, and `q.key(path)` the key of every query of that path.
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
  };
}
