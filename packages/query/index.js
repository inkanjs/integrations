// The typed inkan client for TanStack Query. query() and mutation() only build the options
// every TanStack adapter takes (React, Vue, Svelte, Solid), so this needs none of them: the
// client already knows every type, and a failed answer becomes a ProblemError that the
// query shows as its error, instead of a value it would cache as data.
//
//   useQuery(query(["tea", id], () => shop.get("/teas/:id", { params: { id } })));
//   useMutation(mutation((tea) => shop.post("/teas", { body: tea })));

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
