import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RosterEntry } from "../src/types";
import AdminPage, { type KintaiAdminClient } from "./AdminPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The refusal a non-admin's capability throws, verbatim from `AdminRequiredError`. */
const REFUSED = (method: string) =>
  new Error(
    `KINTAI_ADMIN_REQUIRED: ${method} is available to Workshop administrators only. ` +
    "Ask an administrator to make this change.",
  );

function person(overrides: Partial<RosterEntry> & Pick<RosterEntry, "id">): RosterEntry {
  return {
    employee_number: `E-${overrides.id}`,
    display_name: `Employee ${overrides.id}`,
    department: null,
    employment_type: null,
    designated_approver_id: null,
    status: "active",
    joined_on: "2026-04-01",
    departed_on: null,
    linked: false,
    managerIds: [],
    exempt: false,
    approverReachable: false,
    ...overrides,
  };
}

const TANAKA = person({
  id: 1, display_name: "Tanaka", employee_number: "E-1001", department: "Sales",
  linked: true, managerIds: [2], approverReachable: true,
});
/** Linked, and still cannot use the system: the state this whole screen exists to make visible. */
const STRANDED = person({
  id: 3, display_name: "Stranded", employee_number: "E-1003", linked: true,
});
const SUZUKI = person({
  id: 2, display_name: "Suzuki", employee_number: "E-1002", exempt: true,
  approverReachable: true, linked: true,
});

/** An admin's capability: every method answers. Overrides replace individual methods. */
function adminApi(overrides: Partial<KintaiAdminClient> = {}, roster: RosterEntry[] = [TANAKA]) {
  return {
    whoAmI: vi.fn<KintaiAdminClient["whoAmI"]>(async () => ({
      accountId: "acct-admin", linked: true, employeeId: 9,
    })),
    listEmployees: vi.fn<KintaiAdminClient["listEmployees"]>(async () => roster),
    createEmployee: vi.fn<KintaiAdminClient["createEmployee"]>(async () => 42),
    linkAccount: vi.fn<KintaiAdminClient["linkAccount"]>(async () => {}),
    setReportingLine: vi.fn<KintaiAdminClient["setReportingLine"]>(async () => {}),
    grantExemption: vi.fn<KintaiAdminClient["grantExemption"]>(async () => {}),
    ...overrides,
  };
}

/** A non-admin's capability: `whoAmI` answers, everything else refuses. */
function viewerApi(overrides: Partial<KintaiAdminClient> = {}) {
  return adminApi({
    whoAmI: vi.fn<KintaiAdminClient["whoAmI"]>(async () => ({
      accountId: "acct-1234", linked: false, employeeId: null,
    })),
    listEmployees: vi.fn<KintaiAdminClient["listEmployees"]>(async () => {
      throw REFUSED("listEmployees");
    }),
    createEmployee: vi.fn<KintaiAdminClient["createEmployee"]>(async () => {
      throw REFUSED("createEmployee");
    }),
    linkAccount: vi.fn<KintaiAdminClient["linkAccount"]>(async () => {
      throw REFUSED("linkAccount");
    }),
    setReportingLine: vi.fn<KintaiAdminClient["setReportingLine"]>(async () => {
      throw REFUSED("setReportingLine");
    }),
    grantExemption: vi.fn<KintaiAdminClient["grantExemption"]>(async () => {
      throw REFUSED("grantExemption");
    }),
    ...overrides,
  });
}

describe("AdminPage", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  describe("the view a non-administrator gets", () => {
    // The account code is the whole point of showing an unlinked employee this page: there is no
    // registry of provisioned accounts, so onboarding begins with them reading this string to HR.
    it("shows the account code and how to get onboarded when the account is unlinked", async () => {
      await render(<AdminPage api={viewerApi()} />);

      expect(text('[data-testid="account-id"]')).toBe("acct-1234");
      expect(text('[data-testid="linked"]')).toContain("HR");
      expect(container!.querySelector('[data-testid="employee-id"]')).toBeNull();
    });

    it("reports the employee record once the account is linked", async () => {
      const api = viewerApi({
        whoAmI: vi.fn<KintaiAdminClient["whoAmI"]>(async () => ({
          accountId: "acct-5678", linked: true, employeeId: 42,
        })),
      });
      await render(<AdminPage api={api} />);

      expect(text('[data-testid="account-id"]')).toBe("acct-5678");
      expect(text('[data-testid="employee-id"]')).toBe("42");
    });

    // The authorization boundary is the server's, not this component's — but a page that rendered
    // admin controls a non-admin cannot use would be lying to them about what they may do.
    it("offers no roster and no admin control at all", async () => {
      const api = viewerApi();
      await render(<AdminPage api={api} />);

      expect(container!.querySelectorAll("form, select, textarea")).toHaveLength(0);
      expect(container!.querySelector('[data-testid="roster-summary"]')).toBeNull();
      expect(container!.textContent).not.toContain("Roster");
      // The one control an employee gets is the one that helps them read their code out.
      expect([...container!.querySelectorAll("button")].map((b) => b.dataset.action))
        .toEqual(["copy-account-id"]);
      expect(api.createEmployee).not.toHaveBeenCalled();
      expect(api.linkAccount).not.toHaveBeenCalled();
      expect(api.setReportingLine).not.toHaveBeenCalled();
      expect(api.grantExemption).not.toHaveBeenCalled();
    });

    // The refusal is HOW the page learns it is not talking to an administrator. It must never
    // reach the reader: `KINTAI_ADMIN_REQUIRED: listEmployees is available to…` is a fact about
    // our RPC surface, and an employee reading their own code has done nothing wrong.
    it("shows no error, and no code, for the refusal that told it who it is", async () => {
      await render(<AdminPage api={viewerApi()} />);

      expect(container!.querySelector('[data-testid="error"]')).toBeNull();
      expect(container!.textContent).not.toContain("KINTAI_");
      expect(container!.textContent).not.toContain("listEmployees");
    });
  });

  describe("failures that are not a refusal", () => {
    it("renders a message when the account cannot be read", async () => {
      const api = viewerApi({
        whoAmI: vi.fn<KintaiAdminClient["whoAmI"]>(async () => {
          throw new Error("the session went away");
        }),
      });
      await render(<AdminPage api={api} />);

      expect(text('[data-testid="error"]')).toBe("Couldn’t read your Kintai account.");
      expect(container!.querySelector('[data-testid="account-id"]')).toBeNull();
    });

    // A roster read that fails for any reason OTHER than the refusal must not silently demote an
    // administrator to the employee view: they would see no controls and no explanation, and would
    // reasonably conclude their access had been taken away.
    it("does not mistake a broken roster read for not being an administrator", async () => {
      const api = adminApi({
        listEmployees: vi.fn<KintaiAdminClient["listEmployees"]>(async () => {
          throw new Error("connection lost");
        }),
      });
      await render(<AdminPage api={api} />);

      expect(text('[data-testid="error"]')).toBe("Couldn’t load the roster.");
    });

    it("retries the whole load from the failure state", async () => {
      let attempt = 0;
      const api = adminApi({
        listEmployees: vi.fn<KintaiAdminClient["listEmployees"]>(async () => {
          if (attempt++ === 0) throw new Error("connection lost");
          return [TANAKA];
        }),
      });
      await render(<AdminPage api={api} />);
      expect(container!.querySelector('[data-testid="error"]')).not.toBeNull();

      await click('[data-action="retry"]');

      expect(container!.querySelector('[data-testid="error"]')).toBeNull();
      expect(container!.textContent).toContain("Tanaka");
    });
  });

  describe("the roster an administrator reads", () => {
    it("lists everyone with their number and department", async () => {
      await render(<AdminPage api={adminApi({}, [TANAKA, SUZUKI, STRANDED])} />);

      expect(text('[data-testid="roster-summary"]')).toBe("3 employees · 1 not ready to use Kintai");
      expect(row(1).textContent).toContain("Tanaka");
      expect(row(1).textContent).toContain("E-1001");
      expect(row(1).textContent).toContain("Sales");
    });

    // The judgement this screen turns on. HR links an account, sees a linked record, and would
    // reasonably call onboarding done — but `submitOvertime` will refuse this employee, because
    // `assertApproverReachable` finds nobody. Linked is not ready.
    it("shows a linked employee with no reachable approver as incomplete, and says why", async () => {
      await render(<AdminPage api={adminApi({}, [TANAKA, STRANDED])} />);

      const stranded = row(STRANDED.id);
      expect(stranded.querySelector('[data-issue="no-approver"]')).not.toBeNull();
      expect(stranded.querySelector('[data-issue="unlinked"]')).toBeNull();
      expect(stranded.textContent).toContain("overtime they file will be refused");
      expect(stranded.textContent).not.toContain("Ready");
      // And the row offers the fix, next to the problem.
      expect(stranded.querySelector('[data-action="manager-for-this"]')).not.toBeNull();
    });

    it("shows an unlinked employee as incomplete for that reason too", async () => {
      const fresh = person({ id: 7, display_name: "Fresh", managerIds: [1], approverReachable: true });
      await render(<AdminPage api={adminApi({}, [TANAKA, fresh])} />);

      expect(row(7).querySelector('[data-issue="unlinked"]')).not.toBeNull();
      expect(row(7).querySelector('[data-issue="no-approver"]')).toBeNull();
      expect(row(7).querySelector('[data-action="link-this"]')).not.toBeNull();
    });

    // Only when both halves are true. Anything else is an employee the system will turn away.
    it("calls an employee ready only when they are linked and approvable", async () => {
      await render(<AdminPage api={adminApi({}, [TANAKA, SUZUKI, STRANDED])} />);

      expect(row(TANAKA.id).textContent).toContain("Ready · reports to Suzuki");
      expect(row(SUZUKI.id).textContent).toContain("Ready · 管理監督者");
      expect(row(STRANDED.id).textContent).not.toContain("Ready");
    });

    it("names the designated approver when that is what makes them approvable", async () => {
      const rooted = person({
        id: 8, display_name: "Rooted", linked: true, designated_approver_id: 1,
        approverReachable: true,
      });
      await render(<AdminPage api={adminApi({}, [TANAKA, rooted])} />);

      expect(row(8).textContent).toContain("Ready · approver Tanaka");
    });

    // A reporting line needs somebody to report TO. With one employee the form correctly refuses
    // to render its fields, which used to leave the row's "Set manager" button pointing at a ref
    // that was null — it rendered, it was clickable, and it did nothing. That failure signature is
    // the one this page went to some trouble to eliminate, and it landed at the moment HR is most
    // confused: the very first employee.
    it("offers no 'Set manager' on the only employee, because there is nobody to report to",
      async () => {
        const alone = person({ id: 9, display_name: "First Hire", linked: true });
        await render(<AdminPage api={adminApi({}, [alone])} />);

        expect(row(9).querySelector('[data-action="manager-for-this"]')).toBeNull();
        expect(container!.textContent)
          .toContain("Two employee records are needed before anyone can report to anyone.");
        // The other route out is still offered, and it is the right one for a first hire who is
        // genuinely at the top of the organisation.
        expect(row(9).querySelector('[data-action="exempt-this"]')).not.toBeNull();
      });

    it("offers 'Set manager' again as soon as there is somebody to report to", async () => {
      await render(<AdminPage api={adminApi({}, [TANAKA, STRANDED])} />);

      expect(row(STRANDED.id).querySelector('[data-action="manager-for-this"]')).not.toBeNull();
    });

    it("says so plainly when there is nobody on the roster at all", async () => {
      await render(<AdminPage api={adminApi({}, [])} />);

      expect(text('[data-testid="roster-summary"]')).toBe("Nobody yet");
      expect(container!.textContent).toContain("No employee records yet");
      // Nothing to link an account to and nobody to report to, so those forms say why.
      expect(container!.textContent).toContain("Add an employee record first.");
      expect(container!.querySelector('[data-action="create-employee"]')).not.toBeNull();
    });
  });

  describe("the forms", () => {
    it("creates an employee with what was typed, trimmed", async () => {
      const api = adminApi();
      await render(<AdminPage api={api} />);

      await type('[name="employeeNumber"]', "  E-2001  ");
      await type('[name="displayName"]', " Yamada ");
      await type('[name="joinedOn"]', "2026-04-01");
      await type('[name="department"]', "Engineering");
      await submit("create-employee");

      expect(api.createEmployee).toHaveBeenCalledWith({
        employeeNumber: "E-2001", displayName: "Yamada", department: "Engineering",
        employmentType: undefined, designatedApproverId: undefined, joinedOn: "2026-04-01",
      });
      // Re-read afterwards, because creating a record changes what the roster must show.
      expect(api.listEmployees).toHaveBeenCalledTimes(2);
      expect(text('[data-testid="create-employee-notice"]')).toContain("Added Yamada");
    });

    it("sends a designated approver when one was chosen", async () => {
      const api = adminApi({}, [TANAKA, SUZUKI]);
      await render(<AdminPage api={api} />);

      await type('[name="employeeNumber"]', "E-2002");
      await type('[name="displayName"]', "Root");
      await type('[name="joinedOn"]', "2026-04-01");
      await choose('[name="designatedApproverId"]', "2");
      await submit("create-employee");

      expect(api.createEmployee).toHaveBeenCalledWith(
        expect.objectContaining({ designatedApproverId: 2 }),
      );
    });

    it("links an account code to the chosen employee", async () => {
      const api = adminApi({}, [TANAKA, STRANDED]);
      await render(<AdminPage api={api} />);

      await type('[name="accountId"]', "  acct-abc  ");
      await choose('[data-form="link-account"] [name="employeeId"]', "3");
      await submit("link-account");

      expect(api.linkAccount).toHaveBeenCalledWith("acct-abc", 3);
      expect(text('[data-testid="link-account-notice"]')).toBe("Linked Stranded to that account code.");
      expect(api.listEmployees).toHaveBeenCalledTimes(2);
    });

    it("opens a reporting line from the chosen employee to the chosen manager", async () => {
      const api = adminApi({}, [TANAKA, STRANDED]);
      await render(<AdminPage api={api} />);

      await choose('[data-form="set-reporting-line"] [name="employeeId"]', "3");
      await choose('[data-form="set-reporting-line"] [name="managerId"]', "1");
      await submit("set-reporting-line");

      expect(api.setReportingLine).toHaveBeenCalledWith(3, 1);
      expect(text('[data-testid="set-reporting-line-notice"]'))
        .toBe("Stranded now reports to Tanaka.");
    });

    // The row's own button is the shortest path from seeing the problem to fixing it, and the
    // reason the forms take their employee from state rather than owning it.
    it("preselects the employee whose row asked for the fix", async () => {
      const api = adminApi({}, [TANAKA, STRANDED]);
      await render(<AdminPage api={api} />);

      await click(`[data-employee="3"] [data-action="manager-for-this"]`);
      await choose('[data-form="set-reporting-line"] [name="managerId"]', "1");
      await submit("set-reporting-line");

      expect(api.setReportingLine).toHaveBeenCalledWith(3, 1);
    });

    // The only honest way to complete somebody at the top of the organisation. Without it the
    // roster can be turned green only by writing a reporting line that does not exist — a fiction
    // in the table an audit reads.
    it("records a 管理監督者 exemption for someone who reports to nobody", async () => {
      const officer = person({ id: 9, display_name: "Officer", linked: true });
      const api = adminApi({}, [officer]);
      await render(<AdminPage api={api} />);

      await choose('[data-form="grant-exemption"] [name="employeeId"]', "9");
      await submit("grant-exemption");

      expect(api.grantExemption).toHaveBeenCalledWith(9);
      expect(text('[data-testid="grant-exemption-notice"]'))
        .toBe("Officer is recorded as 管理監督者 from now.");
      // Re-read afterwards: an exemption is one of the three things that make a row ready.
      expect(api.listEmployees).toHaveBeenCalledTimes(2);
    });

    it("offers the exemption from the row of anyone who has no approver, and preselects them",
      async () => {
        const officer = person({ id: 9, display_name: "Officer", linked: true });
        const api = adminApi({}, [TANAKA, officer]);
        await render(<AdminPage api={api} />);
        expect(row(TANAKA.id).querySelector('[data-action="exempt-this"]')).toBeNull();

        await click('[data-employee="9"] [data-action="exempt-this"]');
        await submit("grant-exemption");

        expect(api.grantExemption).toHaveBeenCalledWith(9);
      });

    it("shows an exempt employee as ready, on the exemption rather than a manager", async () => {
      const officer = person({
        id: 9, display_name: "Officer", linked: true, exempt: true, approverReachable: true,
      });
      await render(<AdminPage api={adminApi({}, [officer])} />);

      expect(row(9).textContent).toContain("Ready · 管理監督者");
      expect(row(9).querySelector('[data-action="exempt-this"]')).toBeNull();
      expect(row(9).querySelector('[data-action="manager-for-this"]')).toBeNull();
    });

    it("clears the form after a success so the next entry starts empty", async () => {
      const api = adminApi({}, [TANAKA, STRANDED]);
      await render(<AdminPage api={api} />);

      await type('[name="accountId"]', "acct-abc");
      await choose('[data-form="link-account"] [name="employeeId"]', "3");
      await submit("link-account");

      expect(field<HTMLInputElement>('[name="accountId"]').value).toBe("");
    });

    it("keeps what was typed when the call was refused, so it can be corrected", async () => {
      const api = adminApi({
        linkAccount: vi.fn<KintaiAdminClient["linkAccount"]>(async () => {
          throw new Error("KINTAI_NOT_FOUND: there is no employee 3.");
        }),
      }, [TANAKA, STRANDED]);
      await render(<AdminPage api={api} />);

      await type('[name="accountId"]', "acct-abc");
      await choose('[data-form="link-account"] [name="employeeId"]', "3");
      await submit("link-account");

      expect(field<HTMLInputElement>('[name="accountId"]').value).toBe("acct-abc");
    });
  });

  // The Workshop hosts this app with `sandbox="allow-scripts allow-modals"`. Chrome blocks form
  // submission outright there — no `submit` event, no error, the button simply does nothing — so
  // every one of these actions has to work without it. Verified by clicking in a real browser
  // against `pnpm run-local`; these pin it so it cannot come back.
  describe("working inside a sandbox that forbids forms", () => {
    it("runs every action from a plain button, never from form submission", async () => {
      await render(<AdminPage api={adminApi({}, [TANAKA, STRANDED])} />);

      // EVERY button, not only the ones carrying `data-action`: a button inside a form defaults to
      // `type="submit"`, so a new one added without the attribute would be inert in production and
      // would have slipped past a narrower selector.
      const buttons = [...container!.querySelectorAll<HTMLButtonElement>("button")];
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(
          button.type,
          `${button.dataset.action ?? button.textContent} must not rely on form submission`,
        ).toBe("button");
      }
    });

    it("acts on the button press itself, with no submit event anywhere", async () => {
      const api = adminApi({}, [TANAKA, STRANDED]);
      await render(<AdminPage api={api} />);
      let submitted = false;
      for (const form of container!.querySelectorAll("form")) {
        form.addEventListener("submit", () => { submitted = true; });
      }

      await type('[name="accountId"]', "acct-abc");
      await choose('[data-form="link-account"] [name="employeeId"]', "3");
      await submit("link-account");

      expect(api.linkAccount).toHaveBeenCalledWith("acct-abc", 3);
      expect(submitted).toBe(false);
    });

    // Typing a code and pressing Enter is what anybody does, and the sandbox took the browser's
    // implicit submission away along with the rest.
    it("acts on Enter in a field", async () => {
      const api = adminApi({}, [TANAKA, STRANDED]);
      await render(<AdminPage api={api} />);

      await type('[name="accountId"]', "acct-enter");
      await choose('[data-form="link-account"] [name="employeeId"]', "3");
      await pressEnter('[name="accountId"]');

      expect(api.linkAccount).toHaveBeenCalledWith("acct-enter", 3);
    });

    it("does not fire a second time while the first call is still running", async () => {
      let release: (() => void) | undefined;
      const api = adminApi({
        linkAccount: vi.fn<KintaiAdminClient["linkAccount"]>(
          () => new Promise((resolve) => { release = () => resolve(); }),
        ),
      }, [TANAKA, STRANDED]);
      await render(<AdminPage api={api} />);

      await type('[name="accountId"]', "acct-abc");
      await choose('[data-form="link-account"] [name="employeeId"]', "3");
      await submit("link-account");
      await pressEnter('[name="accountId"]');
      await submit("link-account");

      expect(api.linkAccount).toHaveBeenCalledTimes(1);
      await act(async () => release!());
    });
  });

  describe("what a failed form says", () => {
    // Every coded error must arrive as a sentence, next to the form that produced it.
    it("turns an invalid-input code into the sentence behind it", async () => {
      const api = adminApi({
        createEmployee: vi.fn<KintaiAdminClient["createEmployee"]>(async () => {
          throw new Error(
            "KINTAI_INVALID_INPUT: joining date is not a real calendar date: 2026-02-31.",
          );
        }),
      });
      await render(<AdminPage api={api} />);

      await type('[name="employeeNumber"]', "E-3");
      await type('[name="displayName"]', "Bad Date");
      await submit("create-employee");

      expect(text('[data-testid="create-employee-notice"]'))
        .toBe("Joining date is not a real calendar date: 2026-02-31.");
      expect(container!.textContent).not.toContain("KINTAI_");
    });

    it("explains a not-found rather than repeating the id nobody typed", async () => {
      const api = adminApi({
        linkAccount: vi.fn<KintaiAdminClient["linkAccount"]>(async () => {
          throw new Error("KINTAI_NOT_FOUND: there is no employee 3.");
        }),
      }, [TANAKA, STRANDED]);
      await render(<AdminPage api={api} />);

      await type('[name="accountId"]', "acct-abc");
      await choose('[data-form="link-account"] [name="employeeId"]', "3");
      await submit("link-account");

      expect(text('[data-testid="link-account-notice"]'))
        .toBe("That employee record no longer exists. Reload the roster and try again.");
    });

    it("does not name the RPC method when a refusal reaches a form", async () => {
      const api = adminApi({
        setReportingLine: vi.fn<KintaiAdminClient["setReportingLine"]>(async () => {
          throw REFUSED("setReportingLine");
        }),
      }, [TANAKA, STRANDED]);
      await render(<AdminPage api={api} />);

      await choose('[data-form="set-reporting-line"] [name="employeeId"]', "3");
      await choose('[data-form="set-reporting-line"] [name="managerId"]', "1");
      await submit("set-reporting-line");

      const notice = text('[data-testid="set-reporting-line-notice"]');
      expect(notice).toBe(
        "Only a Workshop administrator can do this. Ask an administrator to make the change.",
      );
      expect(notice).not.toContain("setReportingLine");
    });

    it("falls back to naming the action when the failure carries no code", async () => {
      const api = adminApi({
        createEmployee: vi.fn<KintaiAdminClient["createEmployee"]>(async () => {
          throw new Error("Internal error; reference = abc123");
        }),
      });
      await render(<AdminPage api={api} />);

      await type('[name="employeeNumber"]', "E-4");
      await type('[name="displayName"]', "Whoever");
      await submit("create-employee");

      expect(text('[data-testid="create-employee-notice"]')).toBe("Couldn’t create that employee.");
    });

    // A failure belongs beside the thing that failed. Two forms must not share one message.
    it("keeps each form's message to its own form", async () => {
      const api = adminApi({
        linkAccount: vi.fn<KintaiAdminClient["linkAccount"]>(async () => {
          throw new Error("KINTAI_INVALID_INPUT: account code is required.");
        }),
      }, [TANAKA, STRANDED]);
      await render(<AdminPage api={api} />);

      await type('[name="accountId"]', "x");
      await choose('[data-form="link-account"] [name="employeeId"]', "3");
      await submit("link-account");

      expect(container!.querySelector('[data-testid="link-account-notice"]')).not.toBeNull();
      expect(container!.querySelector('[data-testid="create-employee-notice"]')).toBeNull();
      expect(container!.querySelector('[data-testid="set-reporting-line-notice"]')).toBeNull();
    });

    it("does not re-read the roster when the call never happened", async () => {
      const api = adminApi({
        createEmployee: vi.fn<KintaiAdminClient["createEmployee"]>(async () => {
          throw new Error("KINTAI_INVALID_INPUT: name is required.");
        }),
      });
      await render(<AdminPage api={api} />);

      await type('[name="employeeNumber"]', "E-5");
      await submit("create-employee");

      expect(api.listEmployees).toHaveBeenCalledTimes(1);
    });
  });

  // ---- helpers -------------------------------------------------------------------------------

  async function render(element: React.ReactNode): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(element);
    });
  }

  function field<T extends Element>(selector: string): T {
    const element = container!.querySelector<T>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  }

  function text(selector: string): string {
    return field(selector).textContent ?? "";
  }

  function row(employeeId: number): HTMLElement {
    return field<HTMLElement>(`[data-employee="${employeeId}"]`);
  }

  async function click(selector: string): Promise<void> {
    const element = field<HTMLElement>(selector);
    await act(async () => element.click());
  }

  /**
   * Press a form's button, which is what a person does — never `form.submit()`.
   *
   * The distinction is the whole of the bug this replaced: the Workshop's iframe sandbox omits
   * `allow-forms`, so submission never happens there. A test that dispatched a submit event would
   * have passed against a page nobody could actually use. See "runs from the button" below.
   */
  async function submit(action: string): Promise<void> {
    await click(`button[data-action="${action}"]`);
  }

  /** Enter in a text field, which the sandbox also takes away along with submission. */
  async function pressEnter(selector: string): Promise<void> {
    const element = field<HTMLElement>(selector);
    await act(async () => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  }

  /** Set a controlled input's value the way a keystroke would, past React's value tracker. */
  async function type(selector: string, value: string): Promise<void> {
    const element = field<HTMLInputElement>(selector);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function choose(selector: string, value: string): Promise<void> {
    const element = field<HTMLSelectElement>(selector);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!
        .set!.call(element, value);
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
});
