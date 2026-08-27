import { useEffect, useState } from "react";
import type { KintaiIdentity } from "../src/types";

/**
 * The part of the admin capability this page uses. Deliberately just `whoAmI`: the capability an
 * administrator receives carries more, and this page must not start depending on it before the
 * authorization shape behind it has been reviewed.
 */
export type KintaiAdminClient = {
  whoAmI(): Promise<KintaiIdentity>;
};

type State =
  | { status: "loading" }
  | { status: "ready"; identity: KintaiIdentity }
  | { status: "failed" };

/**
 * A placeholder, and meant to stay one until part 2.
 *
 * Its whole job is to prove the chain works end to end — build, iframe, MessagePort, Cap'n Web
 * session, store — so that the real HR screens start from a session that is known to be live
 * rather than debugging the pipeline and the screens at the same time.
 *
 * It renders nothing but what `whoAmI()` returned. No roster, no forms: everything else on this
 * capability is gated by an authorization shape that gets reviewed before any UI is built on it.
 * The account code is shown because it is the one thing an employee actually needs from this page
 * today — there is no registry of provisioned accounts, so onboarding starts with the employee
 * reading this string out to HR.
 */
export default function AdminPage({ api }: { api: KintaiAdminClient }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let live = true;
    api.whoAmI().then(
      (identity) => {
        if (live) setState({ status: "ready", identity });
      },
      () => {
        if (live) setState({ status: "failed" });
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Kintai</h1>
        <p className="mt-1 text-sm text-kumo-subtle">
          Attendance administration. The HR screens are not built yet.
        </p>
      </header>

      {state.status === "loading" && (
        <p className="text-sm text-kumo-subtle">Loading your account…</p>
      )}

      {state.status === "failed" && (
        <p className="text-sm text-kumo-danger" data-testid="error">
          Couldn’t read your Kintai account.
        </p>
      )}

      {state.status === "ready" && (
        <dl className="flex flex-col gap-4 rounded-lg border border-kumo-line bg-kumo-elevated p-4">
          <div>
            <dt className="text-xs font-medium text-kumo-subtle">Account code</dt>
            <dd className="mt-1 font-mono text-sm break-all text-kumo-default" data-testid="account-id">
              {state.identity.accountId}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-kumo-subtle">Employee record</dt>
            <dd className="mt-1 text-sm text-kumo-default" data-testid="linked">
              {state.identity.linked ? (
                <>
                  Linked to employee <span data-testid="employee-id">{state.identity.employeeId}</span>
                </>
              ) : (
                "Not linked yet — give the account code above to HR."
              )}
            </dd>
          </div>
        </dl>
      )}
    </main>
  );
}
