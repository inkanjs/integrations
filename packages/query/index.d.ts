import type { ProblemBody } from "@vxnsin/inkan";

/** What the typed client answers: success or failure, told apart by `ok`. */
type AnyAnswer = { ok: true; data: unknown } | { ok: false; status: number; problem: unknown };

/** The data of the successful answers. */
export type DataOf<A> = A extends { ok: true; data: infer D } ? D : never;
/** The problem documents of the failed answers. */
export type ProblemOf<A> = A extends { ok: false; problem: infer P } ? P : never;

/** A failed answer: the RFC 9457 problem document the server sent, and its status. */
export class ProblemError<P = ProblemBody> extends Error {
  readonly status: number;
  readonly problem: P;
  /** The problem's stable code to switch on, like "validation" or "tea-not-found". */
  readonly type: string | undefined;
  constructor(answer: { status: number; problem: P });
}

/** The data of a successful answer; a failed one is thrown as a ProblemError. */
export function unwrap<A extends AnyAnswer>(answer: A): DataOf<A>;

/** Options for useQuery / createQuery: a key, and a call of the typed client. */
export function query<const K extends readonly unknown[], A extends AnyAnswer>(
  queryKey: K,
  call: () => Promise<A>,
): { queryKey: K; queryFn: () => Promise<DataOf<A>> };

/** Options for useMutation / createMutation: a call of the typed client that takes the variables. */
export function mutation<V, A extends AnyAnswer>(call: (variables: V) => Promise<A>): { mutationFn: (variables: V) => Promise<DataOf<A>> };
