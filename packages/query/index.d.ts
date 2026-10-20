import type { ProblemBody, Responses, Routes } from "@vxnsin/inkan";
import type { Answer, Client, EventOf, Input, Jsonify, TypedSocket } from "@vxnsin/inkan/client";

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
  /** A live source for useEvents / follow: a GET that answers with `t.events(...)`. */
  events: Live<DefsOf<A>>;
  /** A live source for useSocket / connect: a WebSocket route. */
  ws: Ws<DefsOf<A>>;
};

/** Query and mutation options straight from the typed client, keyed by path and input. */
export function queries<A>(client: Client<A>): Queries<A>;

// ---- live data: server-sent events and WebSockets

/** One event of a stream: its name, its data typed by the name, and its id when it had one. */
export type AnyEvent = { event: string; data: unknown; id?: string };
type Args<R> = {} extends Input<R> ? [input?: Input<R>] : [input: Input<R>];
type EventPaths<D> = {
  [K in keyof D & string]: K extends `GET ${infer P}` ? ([EventOf<ResponseOf<D[K]>>] extends [never] ? never : P) : never;
}[keyof D & string];
type Part<R, K extends string> = R extends { [P in K]: infer V } ? V : unknown;

/** An event stream to follow: its key (path and input), and how to open it. */
export type LiveEvents<E extends AnyEvent> = {
  readonly key: readonly unknown[];
  open(signal?: AbortSignal): AsyncIterable<E>;
};

/** A WebSocket to open: its key (path and input), and how to open it. */
export type LiveSocket<In, Out> = {
  readonly key: readonly unknown[];
  open(): TypedSocket<In, Out>;
};

type Live<D> = <P extends EventPaths<D>>(path: P, ...input: Args<DefAt<D, `GET ${P}`>>) => LiveEvents<EventOf<ResponseOf<DefAt<D, `GET ${P}`>>>>;
type Ws<D> = <P extends PathsOf<D, "WS">>(
  path: P,
  ...input: Args<DefAt<D, `WS ${P}`>>
) => LiveSocket<Part<DefAt<D, `WS ${P}`>, "message">, Part<DefAt<D, `WS ${P}`>, "send">>;

/**
 * How a live source stands. `idle` only for a hook that is not `enabled`; `connecting` until
 * the first event (or message) arrives, and again while waiting to retry; `closed` once it
 * ended; `error` once it failed for good.
 */
export type LiveStatus = "idle" | "connecting" | "open" | "closed" | "error";

/** The data of each event, by its name. */
export type EventData<E extends AnyEvent> = { [K in E["event"]]: Extract<E, { event: K }>["data"] };

export type EventsState<E extends AnyEvent> = {
  /** The last event, narrowed by `last.event`. */
  last: E | undefined;
  /** The latest data of every event that came, by name: `byName.progress`. */
  byName: Partial<EventData<E>>;
  status: LiveStatus;
  /**
   * Why it failed (or, while retrying, failed last). A stream that did not open is a
   * ProblemError with the problem the server sent: `isProblem(error, "not-found")`.
   */
  error: ProblemError | Error | undefined;
};

export type FollowOptions<E extends AnyEvent> = {
  /** Called with every event as it comes, after the state took it: a place for `setQueryData`. */
  onEvent?: (event: E) => void;
  /**
   * Whether to open the stream again after it failed to open or broke off. Default never
   * (a job's stream ends by itself; an ended stream is never opened again). `true` always,
   * a number that many times in a row, or a function like TanStack's `retry`, so the
   * package's `retry(3)` fits: no retry for a 404, one for a 503 or a dropped connection.
   */
  retry?: boolean | number | ((failures: number, error: ProblemError | Error) => boolean);
  /** Milliseconds before opening it again. Default 1 s, doubling, at most 30 s. */
  retryDelay?: number | ((failures: number, error: ProblemError | Error) => number);
};

/**
 * Follows an event stream until it ends, fails or `signal` aborts, telling `onChange` how it
 * stands. Returns the function that stops it. The framework-free part of `useEvents`.
 */
export function follow<E extends AnyEvent>(
  source: LiveEvents<E>,
  options?: FollowOptions<E> & { signal?: AbortSignal; onChange?: (state: EventsState<E>) => void },
): () => void;

export type SocketState<In, Out> = {
  /** The last message the server sent, after a trip through JSON. */
  last: Jsonify<Out> | undefined;
  status: LiveStatus;
  error: Error | undefined;
  /** The typed socket underneath: `on`, `ready`, `raw`. */
  socket: TypedSocket<In, Out> | undefined;
};

export type Connection<In, Out> = {
  socket: TypedSocket<In, Out>;
  /** Sends a message as JSON; one sent while the socket is still opening goes once it is open. */
  send(value: In): void;
  /** Closes the socket; `onChange` hears nothing after. */
  close(): void;
};

/**
 * Opens a WebSocket and tells `onChange` how it stands and `onMessage` every message. The
 * framework-free part of `useSocket`.
 */
export function connect<In, Out>(
  source: LiveSocket<In, Out>,
  options?: { onMessage?: (message: Jsonify<Out>) => void; onChange?: (state: SocketState<In, Out>) => void },
): Connection<In, Out>;
