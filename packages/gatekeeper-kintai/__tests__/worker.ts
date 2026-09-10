import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ActionKind, GatekeeperUiFrame, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { applyStagedApprovalsSchema } from "../src/kintai.js";
import { applySchema } from "../src/store/schema.js";
import type { KintaiGatekeeper, KintaiSession } from "../src/kintai.js";

export { default } from "../src/worker.js";
export * from "../src/worker.js";
// Vitest's ctx.exports analyzer does not follow the production barrel re-export.
export {
  GatekeeperVendor, KintaiAccount, KintaiGatekeeper, KintaiVerifier,
} from "../src/kintai.js";
export { KintaiStore } from "../src/store/kintai-store.js";

/** What the test-side queue recorded, read back through `KintaiFacetHost.readQueue()`. */
export type QueueLog = {
  observations: {
    title: string;
    description: string;
    prohibitAllSharing: boolean;
    /** Definite, never `undefined`: "named nobody" must be distinguishable from "field dropped". */
    excludeObservers: string[];
  }[];
  actions: {
    action: number;
    title: string;
    description: string;
    // Recorded as definite values, never as `undefined`: an action that leaves `implementsRevert`
    // off is asserting it cannot be reverted, and a test must be able to tell that apart from
    // "the harness dropped the field". Same reasoning as `prohibitAllSharing` above.
    implementsRevert: boolean;
    awaitDecision: boolean;
    autoApprovable: boolean;
    actionKind: ActionKind | null;
  }[];
};

/**
 * Stands in for the Overseer's ApprovalQueue.
 *
 * Permissive by default so the domain suites see the behaviour they always did; `denyObservations`
 * flips it into a refusing queue so a test can prove a read is actually gated on it and not merely
 * accompanied by a call.
 */
class TestApprovalQueue extends RpcTarget {
  constructor(
    private readonly state: {
      log: QueueLog; denyObservations: boolean; denyActions: boolean;
      /** Collaborators still authorized in the Overseer's sharing graph. See `authorizeObservation`. */
      shares: Set<string>;
    },
  ) {
    super();
  }

  /**
   * Set once an observation marked `prohibitAllSharing` is authorized, and never cleared — exactly
   * as the real Overseer does (`overseer.ts` `authorizeObservation` puts `prohibitAllSharing` into
   * workspace storage). One instance of this class lives for the life of one session, which is the
   * scope the real flag has: per gadget.
   */
  #prohibitAllSharing = false;

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    if (description.prohibitAllSharing) this.#prohibitAllSharing = true;
    this.state.log.observations.push({
      title: description.title,
      description: description.description,
      // Recorded as definite values: an observation that leaves these off is asserting it is
      // shareable and excludes nobody, and a test must be able to tell that from "the harness
      // dropped the field".
      prohibitAllSharing: description.prohibitAllSharing === true,
      excludeObservers: [...description.excludeObservers ?? []],
    });

    // Faithful to the real Overseer's `#enforceExcludeObservers`: a named observer who is STILL
    // authorized in the sharing graph blocks the observation outright, because v1 has no
    // per-thread hiding and so cannot promise they would not see it. A named id that is not an
    // active share is ignored (already torn down). Crucially — and this is the whole reason Kintai
    // uses this instead of `prohibitAllSharing` — it sets no workspace lockdown, so actions still
    // work afterwards.
    for (const observerId of description.excludeObservers ?? []) {
      if (this.state.shares.has(observerId)) {
        throw new Error(
          "OBSERVATION_EXCLUDED: this observation was blocked because it contains data that a " +
          "current collaborator is not permitted to see.",
        );
      }
    }

    if (this.state.denyObservations) throw new Error("OBSERVATION_DENIED: test queue refused.");
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    // Faithful to the real Overseer, which refuses EVERY action once the workspace has observed
    // data marked `prohibitAllSharing`:
    //
    //   if (this.storage.prohibitAllSharing.get()) {
    //     throw new Error("This workspace has observed sensitive data. To prevent leaks, the
    //       workspace is prohibited from performing actions.");
    //   }
    //
    // Modelled here rather than left out, because it is load-bearing for Kintai specifically:
    // `listPendingApprovals()` is marked `prohibitAllSharing`, and it is the only way a Gadget can
    // learn a submission id it may act on. See the lockdown suite in `approval-queue.test.ts`.
    // Thrown before the action is recorded, as the real one is.
    if (this.#prohibitAllSharing) {
      throw new Error(
        "WORKSPACE_LOCKED_DOWN: this workspace has observed sensitive data. To prevent leaks, " +
        "the workspace is prohibited from performing actions.",
      );
    }
    this.state.log.actions.push({
      action,
      title: description.title,
      description: description.description,
      implementsRevert: description.implementsRevert === true,
      awaitDecision: description.awaitDecision === true,
      autoApprovable: description.autoApprovable === true,
      actionKind: description.actionKind ?? null,
    });
    // A refusing queue proves the gatekeeper actually gates on submitAction, rather than merely
    // calling it and proceeding — and that a refused submission leaves nothing staged behind.
    if (this.state.denyActions) throw new Error("ACTION_DENIED: test queue refused.");
  }

  async bindHook(): Promise<void> {
    throw new Error("Kintai registers no hooks.");
  }
}

/**
 * Test-only stand-in for the Overseer, so tests reach the facet the way a Gadget does.
 *
 * There is no way to mint an account-imbued facet from a test's `env`:
 *
 *  - `getByName(name, { accountId })` does not exist. `getByName` takes a name only, and a
 *    `durableObjects` namespace binding cannot carry `ctx.props` at all — a facet reached that way
 *    would see `ctx.props === undefined`, which production never produces.
 *  - `ctx.exports.KintaiGatekeeper({ props })` returns a `DurableObjectClass`, not a namespace, so
 *    it has no `getByName`. An imbued class can only be instantiated as a FACET under a parent
 *    Durable Object, via `ctx.facets.get(name, () => ({ class }))`.
 *  - `ctx.exports` exists only inside a Durable Object or WorkerEntrypoint, never in a test.
 *
 * That is exactly the production shape: `KintaiAccount.getSingletonGatekeeperClass()` hands the
 * imbued class to the Overseer, which installs it as a facet under itself. This class is that
 * parent, and nothing more.
 */
/**
 * Stands in for the workspace git cache the Overseer passes to `applyAction`. Kintai pushes no
 * git objects and reads none back, so nothing here is ever called; it exists so the stub the
 * validator requires is a real `RpcTarget`, as in production. Every method answers "nothing
 * cached" rather than throwing, so a future read would fail visibly on its own terms.
 */
class TestGitCache extends RpcTarget {
  async get(): Promise<null> { return null; }
  async has(): Promise<boolean> { return false; }
  async stat(): Promise<null> { return null; }
  async put(): Promise<string> { throw new Error("TestGitCache: Kintai never writes git objects."); }
  async advertiseCommit(): Promise<void> {}
  async buildPack(): Promise<ReadableStream<Uint8Array>> {
    return new ReadableStream({ start(controller) { controller.close(); } });
  }
  async consumePack(): Promise<string[]> { return []; }
  async isAncestor(): Promise<boolean> { return false; }
}

export class KintaiFacetHost extends DurableObject<Cloudflare.Env> {
  readonly #queueState = {
    log: { observations: [], actions: [] } as QueueLog,
    denyObservations: false,
    denyActions: false,
    shares: new Set<string>(),
  };

  /** One live session per facet name, as a Gadget holds one session for as long as it runs. */
  readonly #sessions = new Map<string, Promise<KintaiSession>>();

  #facet(accountId: string, name: string): KintaiGatekeeper {
    return this.ctx.facets.get<KintaiGatekeeper>(name, () => ({
      class: this.ctx.exports.KintaiGatekeeper({ props: { accountId } }),
    }));
  }

  /**
   * Invoke one method on the account-imbued facet itself — the `Gatekeeper<KintaiSession>`
   * protocol surface the Overseer calls, not the agent-facing session.
   */
  callFacet(accountId: string, name: string, method: string, args: unknown[]): Promise<unknown> {
    const callable =
      this.#facet(accountId, name) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    // The real Overseer hands every `applyAction` a workspace git-cache stub (upstream, 2026-09), and
    // the facet's validator refuses the call without one. This host IS the tests' Overseer, so it
    // supplies the stub the same way — a fresh one per call, since a stub passed as an RPC argument
    // is disposed when the call returns. Kintai never reads it; see `TestGitCache`.
    if (method === "applyAction" && args.length === 1) {
      args = [...args, new RpcStub(new TestGitCache())];
    }
    return callable[method](...args);
  }

  /**
   * Invoke one method on the session the facet opens, which is the only surface a Gadget reaches.
   *
   * Calls are forwarded rather than the session being returned because a stub that transitively
   * points at a Durable Object facet is not serializable out — which mirrors production, where the
   * facet never leaves the Overseer either. `args` is passed through verbatim, extra arguments
   * included, so authorization tests can genuinely try to smuggle an employee id past the session's
   * signature.
   */
  async callSession(
    accountId: string, name: string, method: string, args: unknown[],
  ): Promise<unknown> {
    let session = this.#sessions.get(name);
    if (!session) {
      // startSession() is reached through the facet exactly as the Overseer reaches it, so the
      // session under test is bound to the facet's own ctx.props and to nothing the caller said.
      session = Promise.resolve(
        this.#facet(accountId, name).startSession(
          new TestApprovalQueue(this.#queueState) as never,
        ),
      );
      this.#sessions.set(name, session);
    }
    const callable =
      (await session) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return callable[method](...args);
  }

  /**
   * Install a class handed out by `KintaiAccount.getSingletonGatekeeperClass()` and call one
   * method on the session it opens.
   *
   * This is the whole provisioning protocol end to end, with nothing stubbed: the vendor minted the
   * account, the account chose the accountId and imbued the class with it, and the class arrives
   * here as opaque data. Nothing in this method knows or can say which account it is speaking for.
   */
  async callProvisionedSession(
    gatekeeperClass: DurableObjectClass<KintaiGatekeeper>,
    name: string,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const facet = this.ctx.facets.get<KintaiGatekeeper>(name, () => ({ class: gatekeeperClass }));
    const session = await facet.startSession(new TestApprovalQueue(this.#queueState) as never);
    const callable = session as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return callable[method](...args);
  }

  /**
   * Call one method on a `KintaiAccount` imbued with a known accountId.
   *
   * Production mints the accountId inside `createAccount()` and never reveals it, which is right
   * but leaves `revoke()` untestable against a linked employee. Building the account here with an
   * id the test also linked closes that gap without adding any way to read an accountId back out
   * of a real account.
   */
  callAccount(accountId: string, method: string, args: unknown[]): Promise<unknown> {
    const account = this.ctx.exports.KintaiAccount({ props: { accountId } });
    const callable =
      account as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return callable[method](...args);
  }

  /**
   * Open the account's HR admin app exactly as the Workshop does, and forward one call into the
   * capability it hands the iframe.
   *
   * This is the production expression verbatim — `ctx.exports.KintaiAccount({ props }).startAppUi({
   * isAdmin })` — and `isAdmin` is passed to `startAppUi` and nowhere else. Nothing here can widen
   * what comes back: whichever class `startAppUi` chose is the only surface the call can reach, and
   * `args` is forwarded verbatim so an authorization test genuinely attempts the call.
   *
   * `ctx.exports` exists only inside a Durable Object or WorkerEntrypoint, never in a test, which
   * is why this lives here rather than in the suite. Production mints the accountId inside
   * `createAccount()` and never reveals it; building the account here with an id the test also
   * linked is what makes the linked and unlinked cases reachable, and adds no way to read an
   * accountId back out of a real account.
   */
  async callAppUi(
    accountId: string, isAdmin: boolean, method: string, args: unknown[],
  ): Promise<unknown> {
    const account = this.ctx.exports.KintaiAccount({ props: { accountId } });
    const frame = await account.startAppUi!({ isAdmin });
    const callable =
      frame.ui as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return callable[method](...args);
  }

  /**
   * The whole `GatekeeperUiFrame`, handed back to the caller as the Workshop hands it to the
   * browser — HTML and live capability together, rather than one call forwarded through this host.
   */
  async openAppUi(accountId: string, isAdmin: boolean): Promise<GatekeeperUiFrame> {
    const account = this.ctx.exports.KintaiAccount({ props: { accountId } });
    return account.startAppUi!({ isAdmin });
  }

  /**
   * Call `getAgentCatalog()` with a live authorizer.
   *
   * It takes an `ObservationAuthorizer` stub and RPC validation rejects anything else, so a test
   * cannot reach it through `callFacet` — a stub can only be minted inside a worker.
   */
  getAgentCatalog(accountId: string, name: string): Promise<unknown> {
    return this.#facet(accountId, name)
      .getAgentCatalog(new TestApprovalQueue(this.#queueState) as never);
  }

  /** Everything the approval queue has been asked to authorize since the last `resetQueue()`. */
  readQueue(): QueueLog {
    return {
      observations: [...this.#queueState.log.observations],
      actions: [...this.#queueState.log.actions],
    };
  }

  /** Clear the recorded calls and choose whether the queue permits or refuses each call kind. */
  resetQueue(denyObservations = false, denyActions = false): void {
    this.#queueState.log.observations.length = 0;
    this.#queueState.log.actions.length = 0;
    this.#queueState.denyObservations = denyObservations;
    this.#queueState.denyActions = denyActions;
    this.#queueState.shares.clear();
  }

  /**
   * Stand in for the Overseer's sharing graph: who currently has access to this workspace.
   *
   * Separate from `Gatekeeper.addObserver`, exactly as in production — the Overseer keeps the
   * sharing graph and its own observer index, and tells the gatekeeper about observers through
   * `addObserver`. A test that wants the real shape calls both.
   */
  setShares(observerIds: string[]): void {
    this.#queueState.shares.clear();
    for (const id of observerIds) this.#queueState.shares.add(id);
  }

  /**
   * Delete a seed row, re-run `applySchema`, and report what the lookup table holds afterwards.
   *
   * This is the forward path the lookup tables exist for: a later version adding an enum value is
   * an INSERT that an existing store picks up on its next activation, with no migration and no
   * table rebuild. Reachable only from here because `applySchema` runs in the store's constructor,
   * so a `KintaiStore` can never be observed part-way through one.
   */
  reseedsMissingLookupRow(): string[] {
    const sql = this.ctx.storage.sql;
    applySchema(sql);
    sql.exec(`DELETE FROM punch_sources WHERE source = 'amendment'`);

    applySchema(sql);

    return sql
      .exec<{ source: string }>(`SELECT source FROM punch_sources ORDER BY source`)
      .toArray()
      .map((row) => row.source);
  }

  /**
   * Run the real schema over this host's own storage, then attempt a raw `INSERT` into `table`
   * with an enum value the lookup table does not hold, and report what the database said.
   *
   * `KintaiStore.recordPunch` cannot express this. `@validateRpc()` generates its argument
   * validators from `NewPunch`, so a `source` outside `PunchSource` is refused with
   * `expected union, got string` before the method body runs -- correct layering, and pinned by
   * its own assertion in the suite, but it means the foreign key underneath is never reached
   * through that surface. The whole claim of the lookup tables is that the DATABASE refuses too,
   * independently of TypeScript and of RPC validation, so the probe has to be raw SQL. Same
   * approach, and same reason, as `migrateLegacyEmployees` below: the shape under test is
   * unreachable through every public surface.
   *
   * Returns the error message, or null if the row was accepted -- a null is a failing test, not
   * an absent one.
   */
  rejectsUnknownEnum(table: "punches" | "submissions", value: string): string | null {
    const sql = this.ctx.storage.sql;
    applySchema(sql);
    sql.exec(
      `INSERT OR IGNORE INTO employees (id, employee_number, display_name, status, joined_on)
       VALUES (1, 'probe', 'Probe', 'active', '2026-04-01')`,
    );

    try {
      if (table === "punches") {
        sql.exec(
          `INSERT INTO punches
             (employee_id, work_date, kind, occurred_at, recorded_at, source)
           VALUES (1, '2026-07-03', 'in', 0, 0, ?)`,
          value,
        );
      } else {
        sql.exec(
          `INSERT INTO submissions
             (employee_id, kind, requested_for, state, current_step, minutes, reason,
              route_snapshot)
           VALUES (1, ?, '2026-07-03', 'pending', 0, 0, 'probe', '{}')`,
          value,
        );
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return null;
  }

  /**
   * Build a PRE-lookup-table `submissions` table, run the real schema over it, and report what
   * `assertSchemaCurrent` said.
   *
   * A live store runs `applySchema` in its constructor, so by the time a test can hold a
   * `KintaiStore` the lookup tables are already there and the stale shape is unreachable. Built
   * here for the same reason `migrateLegacyEmployees` is.
   *
   * Returns the error message, or null if the schema was accepted.
   */
  detectsStaleSchema(): string | null {
    const sql = this.ctx.storage.sql;
    sql.exec(`DROP TABLE IF EXISTS submissions`);
    // Verbatim the table as it stood before the lookup tables, minus the foreign keys onto tables
    // this scratch storage does not have -- the CHECK on `kind` is the part under test.
    sql.exec(`CREATE TABLE submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('overtime')),
      requested_for TEXT NOT NULL,
      state TEXT NOT NULL,
      submitted_at INTEGER,
      current_step INTEGER NOT NULL DEFAULT 0,
      minutes INTEGER NOT NULL CHECK (minutes >= 0),
      reason TEXT NOT NULL,
      calculation_inputs TEXT,
      route_snapshot TEXT NOT NULL,
      created_by INTEGER
    ) STRICT`);

    try {
      applySchema(sql);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return null;
  }

  /**
   * Build a PRE-`work_date_policy` `employees` table with rows in it, run the real schema over it,
   * and report what each row's policy became.
   *
   * The only way to reach that migration. `applySchema` runs in the store's constructor, so by the
   * time any test can see a `KintaiStore` the column is already there and the legacy shape — an
   * `employees` table with real payroll rows and no policy column — is unreachable through every
   * public surface. So it is built here, in this host's OWN storage, and handed to the same
   * function the store's constructor calls. Same approach, and same reason, as
   * `migrateLegacyStaged` below.
   *
   * `employees` is the table this matters most for: it cannot be recreated, because it holds the
   * records every punch, link and submission points at.
   */
  migrateLegacyEmployees(names: string[]): { display_name: string; work_date_policy: string }[] {
    const sql = this.ctx.storage.sql;
    sql.exec(`DROP TABLE IF EXISTS employees`);
    // Verbatim the table as it stood before this change.
    sql.exec(`CREATE TABLE employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      department TEXT,
      employment_type TEXT,
      designated_approver_id INTEGER REFERENCES employees(id),
      status TEXT NOT NULL CHECK (status IN ('active', 'leave', 'departed')),
      joined_on TEXT NOT NULL,
      departed_on TEXT
    ) STRICT`);
    for (const [index, name] of names.entries()) {
      sql.exec(
        `INSERT INTO employees (employee_number, display_name, status, joined_on)
         VALUES (?, ?, 'active', '2026-04-01')`,
        `legacy-${index}`, name,
      );
    }

    applySchema(sql);

    return sql
      .exec<{ display_name: string; work_date_policy: string }>(
        `SELECT display_name, work_date_policy FROM employees ORDER BY id`,
      )
      .toArray();
  }

  /**
   * Build a PRE-UPGRADE `staged_approvals` table, run the real migration over it, and report what
   * survived.
   *
   * The only way to test the migration at all. A live facet runs it in its constructor, so by the
   * time any test can reach that facet the table is already migrated and its legacy shape — no
   * `staged_after_event_id`, no unique index, and therefore duplicate open rows — is unreachable
   * through every public surface. So the shape is built here, in this host's OWN storage (the
   * facets keep theirs separately, so nothing else is disturbed), and handed to the same exported
   * function the constructor calls.
   *
   * Ids are given explicitly because the migration's tie-break is `MIN(id)`, which is the thing
   * under test.
   */
  migrateLegacyStaged(
    rows: { id: number; submissionId: number; actorId: number; action: string; state: string }[],
  ): { id: number; state: string; action: string; staged_after_event_id: number | null;
       error: string | null }[] {
    const sql = this.ctx.storage.sql;
    sql.exec(`DROP TABLE IF EXISTS staged_approvals`);
    // Verbatim the table as it stood before this change: no marker column, no index.
    sql.exec(`CREATE TABLE staged_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL,
      actor_employee_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'return')),
      comment TEXT,
      staged_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'applied', 'failed')),
      error TEXT
    ) STRICT`);
    for (const row of rows) {
      sql.exec(
        `INSERT INTO staged_approvals
           (id, submission_id, actor_employee_id, action, comment, staged_at, state, error)
         VALUES (?, ?, ?, ?, NULL, 0, ?, NULL)`,
        row.id, row.submissionId, row.actorId, row.action, row.state,
      );
    }

    applyStagedApprovalsSchema(sql);

    return sql
      .exec<{ id: number; state: string; action: string; staged_after_event_id: number | null;
              error: string | null }>(
        `SELECT id, state, action, staged_after_event_id, error
         FROM staged_approvals ORDER BY id`,
      )
      .toArray();
  }
}
