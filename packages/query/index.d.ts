import type { ProblemBody, Responses, Routes } from "@vxnsin/inkan";
import type { Answer, Client, Input } from "@vxnsin/inkan/client";

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

/** Whether `err` is a ProblemError, and when a type is given, one of that type. */
export function isProblem(err: unknown, type?: string): err is ProblemError;

/**
 * For `retry`: tries again up to `times` (default 3) for what may pass by itself (a dropped
 * connection, a 5xx, a 429), never for a problem the same request would only get again.
 */
export function retry(times?: number): (failures: number, error: unknown) => boolean;

/** The data of a successful answer; a failed one is thrown as a ProblemError. */
export function unwrap<A extends AnyAnswer>(answer: A): DataOf<A>;

/** Options for useQuery / createQuery: a key, and a call of the typed client. */
export function query<const K extends readonly unknown[], A extends AnyAnswer>(
  queryKey: K,
  call: () => Promise<A>,
): { queryKey: K; queryFn: () => Promise<DataOf<A>> };

/** Options for useMutation / createMutation: a call of the typed client that takes the variables. */
export function mutation<V, A extends AnyAnswer>(call: (variables: V) => Promise<A>): { mutationFn: (variables: V) => Promise<DataOf<A>> };

type DefsOf<A> = A extends Routes<infer D> ? D : never;
type PathsOf<D, M extends string> = { [K in keyof D & string]: K extends `${M} ${infer P}` ? P : never }[keyof D & string];
type DefAt<D, K> = K extends keyof D ? D[K] : never;
type ResponseOf<X> = X extends { response: infer R extends Responses } ? R : {};
type Data<R> = DataOf<Answer<ResponseOf<R>>>;
type Variables<R> = {} extends Input<R> ? Input<R> | void : Input<R>;

type Read<D> = <P extends PathsOf<D, "GET">>(
  path: P,
  ...input: {} extends Input<DefAt<D, `GET ${P}`>> ? [input?: Input<DefAt<D, `GET ${P}`>>] : [input: Input<DefAt<D, `GET ${P}`>>]
) => { queryKey: readonly [P] | readonly [P, Input<DefAt<D, `GET ${P}`>>]; queryFn: () => Promise<Data<DefAt<D, `GET ${P}`>>> };

type Write<D, M extends string> = <P extends PathsOf<D, M>>(
  path: P,
) => { mutationFn: (variables: Variables<DefAt<D, `${M} ${P}`>>) => Promise<Data<DefAt<D, `${M} ${P}`>>> };

export type Queries<A> = {
  /** The key of a query, and with only the path, the start of every key of that path, for invalidating. */
  key<P extends PathsOf<DefsOf<A>, "GET">>(path: P, input?: Input<DefAt<DefsOf<A>, `GET ${P}`>>): readonly unknown[];
  /** Options for useQuery: the GET, keyed by its path and input. */
  get: Read<DefsOf<A>>;
  /** Options for useMutation: the request, with its input as the variables. */
  post: Write<DefsOf<A>, "POST">;
  put: Write<DefsOf<A>, "PUT">;
  patch: Write<DefsOf<A>, "PATCH">;
  delete: Write<DefsOf<A>, "DELETE">;
};

/** Query and mutation options straight from the typed client, keyed by path and input. */
export function queries<A>(client: Client<A>): Queries<A>;
