/**
 * Which plugin instance holds a session, in the client the instances of one
 * process share (spec D3, D4).
 *
 * OpenCode 2 creates one plugin instance per location and disposes it when
 * the location is evicted, while the trace state lives in the shared client.
 * An instance therefore ends and forgets only the sessions it holds when it
 * is disposed, and only the holding instance lets events change a session.
 *
 * Any live instance may take a session that nobody holds: then no instance
 * is tracing it, so taking it cannot end another instance's turn. A held
 * session moves to another instance only through a hook of an instance at
 * the session's current location, as recorded from `session.moved` (until a
 * move is recorded every instance qualifies, and so does an instance whose
 * location is unknown). An instance at the recorded location therefore takes
 * the session back at its first hook, and an old location's late hooks and
 * events cannot take it from the holder (spec D3, rev6).
 */

// Marks clients built by this package; a client of another build has no
// session holds, and the plugin then only flushes on disposal (spec D7).
export const SESSION_HOLDS: unique symbol = Symbol.for(
  "langfuse.opencode.sessionHolds.v1",
);

// The same bound as the version history's sessions.
const MAX_LOCATIONS = 2000;

type Location = { readonly key: string; readonly directory: string };
type Holder = { readonly location: Location | undefined; closed: boolean };

// OpenCode tells locations apart by directory and workspace.
const parseLocation = (location: unknown): Location | undefined => {
  if (typeof location !== "object" || location === null) {
    return undefined;
  }
  const directory: unknown = Reflect.get(location, "directory");
  if (typeof directory !== "string") {
    return undefined;
  }
  const workspaceID: unknown = Reflect.get(location, "workspaceID");
  return {
    key: JSON.stringify([
      directory,
      typeof workspaceID === "string" ? workspaceID : null,
    ]),
    directory,
  };
};

export class SessionHoldTable {
  private readonly holders = new Map<string, Holder>();
  // The current location of each moved session, with the sequence of the
  // move it was recorded from.
  private readonly locations = new Map<
    string,
    { readonly location: Location; readonly seq: number }
  >();
  private readonly end: (sessionID: string) => void;
  private readonly forget: (
    sessionID: string,
    keepSessionFacts: boolean,
  ) => void;

  constructor(input: {
    end: (sessionID: string) => void;
    forget: (sessionID: string, keepSessionFacts: boolean) => void;
  }) {
    this.end = input.end;
    this.forget = input.forget;
  }

  /** The holds of one plugin instance at `location` (its `ctx.location`). */
  open(location: unknown) {
    const holder: Holder = { location: parseLocation(location), closed: false };
    const atCurrentLocation = (sessionID: string) => {
      const current = this.locations.get(sessionID);
      return (
        current === undefined ||
        holder.location === undefined ||
        current.location.key === holder.location.key
      );
    };

    return {
      /** A hook of the session ran on this instance (spec D3 R2). */
      hook: (sessionID: string) => {
        if (
          !holder.closed &&
          (!this.holders.has(sessionID) || atCurrentLocation(sessionID))
        ) {
          this.holders.set(sessionID, holder);
        }
      },
      /** Whether this instance may apply an event of the session (R3). */
      event: (sessionID: string) => {
        const current = this.holders.get(sessionID);
        if (current === holder) {
          return true;
        }
        if (current !== undefined || holder.closed) {
          return false;
        }
        this.holders.set(sessionID, holder);
        return true;
      },
      /** `session.moved`: records the session's current location (F). */
      moved: (sessionID: string, location: unknown, seq: number) => {
        const target = parseLocation(location);
        const recorded = this.locations.get(sessionID);
        if (
          target === undefined ||
          (recorded !== undefined && seq < recorded.seq)
        ) {
          return;
        }
        this.locations.delete(sessionID);
        this.locations.set(sessionID, { location: target, seq });
        for (const oldest of this.locations.keys()) {
          if (this.locations.size <= MAX_LOCATIONS) {
            break;
          }
          this.locations.delete(oldest);
        }

        // A disposed instance still records the move and lets go of a hold
        // at another location, but takes nothing (rev6).
        if (
          !holder.closed &&
          (holder.location === undefined || holder.location.key === target.key)
        ) {
          this.holders.set(sessionID, holder);
          return;
        }
        const current = this.holders.get(sessionID)?.location;
        if (current !== undefined && current.key !== target.key) {
          this.holders.delete(sessionID);
        }
      },
      /** The start of the disposal: the instance takes no more sessions. */
      close: () => {
        holder.closed = true;
      },
      /** `session.deleted`: forgets the session, whoever holds it (R4). */
      deleted: (sessionID: string) => {
        this.forget(sessionID, false);
      },
      /**
       * Disposal: ends and forgets the sessions this instance holds, keeping
       * their history, parent link and location (spec D4).
       */
      release: () => {
        const held = Array.from(this.holders)
          .filter(([, current]) => current === holder)
          .map(([sessionID]) => sessionID);
        for (const sessionID of held) {
          this.end(sessionID);
          this.forget(sessionID, true);
        }
      },
    };
  }

  /** Called by the client when it forgets a session. */
  drop(sessionID: string, keepLocation: boolean) {
    this.holders.delete(sessionID);
    if (!keepLocation) {
      this.locations.delete(sessionID);
    }
  }

  clear() {
    this.holders.clear();
    this.locations.clear();
  }

  /** Test-only: the directories of the session's location and holder. */
  debugSession(sessionID: string) {
    const holder = this.holders.get(sessionID);
    return {
      location: this.locations.get(sessionID)?.location.directory,
      holder:
        holder === undefined
          ? undefined
          : (holder.location?.directory ?? "(unknown location)"),
    };
  }
}

type SessionHolds = ReturnType<SessionHoldTable["open"]>;

const isSessionHolds = (value: unknown): value is SessionHolds =>
  typeof value === "object" &&
  value !== null &&
  (["hook", "event", "moved", "close", "deleted", "release"] as const).every(
    (key) => typeof Reflect.get(value, key) === "function",
  );

/**
 * The holds of a plugin instance, when the shared client has them. The
 * client may come from another build, so its shape is checked at run time.
 */
export const openSessionHolds = (client: object, location: unknown) => {
  const table: unknown = Reflect.get(client, SESSION_HOLDS);
  if (typeof table !== "object" || table === null) {
    return undefined;
  }
  const open: unknown = Reflect.get(table, "open");
  if (typeof open !== "function") {
    return undefined;
  }
  const holds: unknown = Reflect.apply(open, table, [location]);
  return isSessionHolds(holds) ? holds : undefined;
};
