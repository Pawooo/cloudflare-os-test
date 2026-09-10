/**
 * Every word either Kintai screen says, in English and in 日本語.
 *
 * `en` IS THE SCHEMA. `Messages` is `typeof en`, `ja` is declared `satisfies Messages`, and there
 * is no third thing to keep in step: a key added to `en` and forgotten in `ja` fails the build, and
 * a key removed from `en` makes every call site that read it fail the build too. There is no
 * string-key lookup anywhere — call sites read `t.today.emptyDay` and `t.pending.summary(n, m)` —
 * so a typo is a compile error rather than a blank space on a payroll screen, and nothing new ships
 * in the bundle but the strings themselves. No i18n library: the entire mechanism is this file,
 * `LanguageProvider`, and `useT()`.
 *
 * KEYS ARE NAMED BY MEANING, NEVER BY THE ENGLISH TEXT. `today.emptyDay`, not `noPunchesYet`:
 * rewording the English must not rename the key, or the migration is a rename every time somebody
 * edits a sentence.
 *
 * PARAMETERISED COPY IS A FUNCTION, and the function does its own formatting rather than taking a
 * pre-formatted string. `pending.askOvertime(minutes, date)` takes the minutes because "2h 30m" and
 * "2時間30分" are not the same arithmetic written twice — they are one sentence each language builds
 * its own way, and a caller that formatted the number first would have made the choice for both.
 *
 * WHAT IS NOT TRANSLATED, deliberately: dates stay `YYYY-MM-DD` and clocks `HH:MM` in both
 * languages (the store's own format, and what `monthlyReport`/`lockPeriod` take); an account code,
 * an employee number and a period are values, not words; a language's own name (`labels
 * .languageNames`) is written the way its own readers write it, in both dictionaries, so a reader
 * hunting for their language finds the word they would look for. Server-side error DETAILS also
 * stay English — see `errors`.
 *
 * WHERE THE BILINGUAL COPY WENT. Both screens used to mix the two languages in one sentence
 * ("承認待ち · waiting on a decision"), which is what this file replaces. Each half became the
 * corresponding language's value, and where one half said less than the other — a bare `夜勤`
 * against "punches filed against the shift's start date" — the shorter side was completed rather
 * than kept short. A `ja` entry that says less than its `en` twin is a translation bug, not a
 * terser style.
 *
 * 管理監督者 and 労働基準法 §41 are the one hard case. They are legal terms of art with no English
 * equivalent that HR would recognise, and the old English copy simply wrote them in Japanese. The
 * English side now glosses them ("a managerial or supervisory employee under Article 41 of the
 * Labour Standards Act"), because "one language per screen" is the whole point of the exercise and
 * an English screen that drops into 漢字 for its most consequential determination is the mixture
 * this replaces.
 */
import type { AppLocale } from "@gadgets/workshop-shared/theme";
import type {
  ApprovalAction, PunchKind, SubmissionState, UiLanguage, WorkDatePolicy,
} from "../../src/types";
import { UI_LANGUAGES } from "../../src/types";

// ---- the maps whose keys are WIRE STRINGS ------------------------------------------------------
//
// `Record<string, string>` and not a closed union, in both dictionaries, for the reason the two
// `ANOMALY_LABELS` maps these replace were untyped: an anomaly flag and a `KINTAI_*` code are plain
// strings on the wire, produced by a worker this module cannot see, and every call site falls
// through to the raw value for an unknown one. A closed type here would be a compile-time promise
// about somebody else's enumeration. The runtime parity walk in `messages.test.ts` is what holds
// the two dictionaries' keys together instead — the job `satisfies` cannot do once the type is
// this wide.

/**
 * How each anomaly flag reads to a human. The keys are the strings `dayAnomalies` pushes.
 *
 * One map where there were two — `OverviewTab`'s and `EmployeePage`'s, which said the same thing
 * about the same flag and were kept apart only because neither task wanted to reach into the
 * other's file. An administrator and the employee whose day it is now read the same words.
 */
const EN_ANOMALIES: Record<string, string> = {
  unpaired_in: "No clock-out",
  unpaired_break: "Break never ended",
  orphan_out: "Clock-out with no clock-in",
  duplicate_in: "Duplicate clock-in",
  negative_gross: "Breaks longer than the day",
  // A PROBLEM, like its five neighbours, not a measurement: "14 hours or more" named a threshold
  // and left the reader to guess what had crossed it — while `ja` said 14時間以上の勤務, the work.
  long_span: "Worked 14 hours or more",
};

const JA_ANOMALIES: Record<string, string> = {
  unpaired_in: "退勤打刻なし",
  unpaired_break: "休憩終了の打刻なし",
  orphan_out: "出勤打刻のない退勤",
  duplicate_in: "出勤打刻の重複",
  negative_gross: "休憩が労働時間を超過",
  long_span: "14時間以上の勤務",
};

/**
 * Codes whose own detail should not be shown, keyed by the `KINTAI_*` code on the wire.
 *
 * `KINTAI_NOT_FOUND` says "there is no employee 42", where the number came from a control the
 * reader never typed into — the useful half is that their copy of the roster is stale.
 * `KINTAI_INVALID_TRANSITION` and `KINTAI_STALE_DECISION` mean the same thing to the person in
 * front of the queue: the row they are looking at is not the request as it now stands. The API's
 * own wording is true and gives them nothing to do; "reload" does.
 *
 * `KINTAI_ADMIN_NOT_LINKED` is the odd one out, and the only one whose rewrite names a fix rather
 * than a reload. An administrator whose own account is not linked to an employee record cannot
 * perform a write that RECORDS who performed it — closing a month, deciding a request — because
 * there is nobody to record. The server's detail is about the missing link; what the reader needs
 * is that their own account card, one tab away, is where they repair it.
 *
 * `KINTAI_ACCOUNT_NOT_LINKED` is its worker-side twin, and the most-read sentence in this map.
 * `#requireEmployee` throws it on EVERY read and write an unlinked account attempts, so it is the
 * entire 今日 tab for a new hire — the first thing Kintai ever says to them. The server's detail
 * says "Contact HR to be set up", which names no act they can perform: the fix is in their hand,
 * because the account code they are signed in with is the thing HR has to point at a record. The
 * rewrite says to read it out, and does not send them to a tab they cannot see — the employee
 * screen has no roster and no account card, unlike the administrator's.
 *
 * `KINTAI_NO_APPROVER` is here for a different reason from all of them: its detail is not merely
 * unhelpful, it is in the WRONG LANGUAGE. The English text `NoApproverError` throws contains
 * 管理監督者, so an English screen showing it dropped into 漢字 for the word its sentence turns on
 * — which is the mixture this whole file replaces. Both rewrites keep the detail's substance (an
 * exemption is not an approver, a punch correction still needs one, and the fix is a reporting
 * line or a designated approver) and each stays in one language throughout, the English side
 * glossing the term as Article 41 exactly as `roster.row.exempt` does.
 *
 * It is written WITHOUT "you", unlike the two above. Both an employee filing a correction
 * (`fileAmendment`/`submitOvertime` → `assertApproverReachable`) and an administrator saving an
 * organisation reach this code, and only one of those readers is the person who has no approver.
 */
const EN_BY_CODE: Record<string, string> = {
  KINTAI_NOT_FOUND: "That employee record no longer exists. Reload the roster and try again.",
  KINTAI_INVALID_TRANSITION:
    "Somebody already decided this request. Reload the page to see where it stands.",
  KINTAI_STALE_DECISION: "This request changed since you read it. Reload the page, then decide again.",
  KINTAI_ADMIN_NOT_LINKED:
    "Your account is not linked to an employee record, so this action cannot be recorded against" +
    " you. Link your account code on the Roster tab first.",
  KINTAI_ACCOUNT_NOT_LINKED:
    "Your account is not linked to an employee record yet. Read your account code to HR so they" +
    " can link it.",
  KINTAI_NO_APPROVER:
    "Nobody can approve this: there is no manager and no designated approver on record. Being" +
    " exempt under Article 41 does not change that — a punch correction still needs somebody to" +
    " approve it. Ask an administrator to set a reporting line, or a designated approver for" +
    " somebody who reports to nobody.",
};

const JA_BY_CODE: Record<string, string> = {
  KINTAI_NOT_FOUND: "その従業員レコードはもう存在しません。名簿を読み込み直してからやり直してください。",
  KINTAI_INVALID_TRANSITION:
    "この申請はすでに誰かが決定しています。ページを読み込み直して現在の状態を確認してください。",
  KINTAI_STALE_DECISION:
    "この申請は読み込んだあとに変わりました。ページを読み込み直してから、もう一度決定してください。",
  KINTAI_ADMIN_NOT_LINKED:
    "あなたのアカウントが従業員レコードに紐づいていないため、この操作をあなたの記録として残せません。" +
    "まず名簿タブでアカウントコードを紐づけてください。",
  KINTAI_ACCOUNT_NOT_LINKED:
    "あなたのアカウントはまだ従業員レコードに紐づいていません。アカウントコードを人事に伝えて、" +
    "紐づけてもらってください。",
  KINTAI_NO_APPROVER:
    "承認できる人がいません — 上長も指定承認者も登録されていません。管理監督者であってもこれは" +
    "変わりません: 打刻の修正には承認する人が必要です。管理者に上長の設定を依頼してください。" +
    "誰にも報告しない場合は指定承認者を設定してもらってください。",
};

const EN_PUNCH_KINDS: Record<PunchKind, string> = {
  in: "Clock in",
  out: "Clock out",
  break_start: "Start break",
  break_end: "End break",
};

const JA_PUNCH_KINDS: Record<PunchKind, string> = {
  in: "出勤",
  out: "退勤",
  break_start: "休憩開始",
  break_end: "休憩終了",
};

/**
 * The three decisions, and the one place they are named.
 *
 * Held as a const above the dictionary rather than only inside it because two other entries are
 * built from it — the confirmation button and the "moved to its next step" notice — and a
 * dictionary cannot refer to itself while it is being written.
 */
const EN_DECISIONS: Record<ApprovalAction, string> = {
  approve: "Approve",
  return: "Return",
  reject: "Reject",
};

const JA_DECISIONS: Record<ApprovalAction, string> = {
  approve: "承認",
  return: "差し戻し",
  reject: "却下",
};

/** The verb on the button that actually writes the decision. Not `${label}する`: 差し戻し → 差し戻す. */
const EN_CONFIRM_DECISION: Record<ApprovalAction, string> = {
  approve: "Yes, approve",
  return: "Yes, return",
  reject: "Yes, reject",
};

const JA_CONFIRM_DECISION: Record<ApprovalAction, string> = {
  approve: "承認する",
  return: "差し戻す",
  reject: "却下する",
};

/**
 * How each overtime state reads to the employee whose request it is. The keys are `SubmissionState`.
 *
 * Every one of these is a CLAIM, which is why 今月 carries a standing line saying so; the label
 * names where in approval the claim currently sits, not what will be paid.
 */
const EN_OVERTIME_STATES: Record<SubmissionState, string> = {
  draft: "Draft",
  pending: "Waiting on a decision",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

const JA_OVERTIME_STATES: Record<SubmissionState, string> = {
  draft: "下書き",
  pending: "承認待ち",
  approved: "承認済み",
  rejected: "却下",
  withdrawn: "取り下げ",
};

/**
 * Which day an employee's punches are filed against, in the words the form offers.
 *
 * These replace `WORK_DATE_POLICY_LABELS` in `src/work-date.ts` for the SCREEN's purposes. That
 * const has no other reader — it was English-only and imported by `AdminPage` alone — so a
 * Japanese administrator was choosing a policy from an English dropdown.
 */
const EN_WORK_DATE_POLICIES: Record<WorkDatePolicy, string> = {
  calendar: "Calendar date (office staff)",
  shift_start: "Shift start date (night shifts)",
};

const JA_WORK_DATE_POLICIES: Record<WorkDatePolicy, string> = {
  calendar: "暦日（日勤）",
  shift_start: "シフト開始日（夜勤）",
};

/**
 * `2h 30m`, `45m`, `3h`. Named rather than inlined because two other English entries build a
 * sentence around it, and a dictionary cannot refer to itself while it is being written.
 */
function enShortDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** `2時間30分`, `45分`, `3時間`. The Japanese half of the pair above. */
function jaShortDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}分`;
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
}

/**
 * Each language's own name, never translated and identical in both dictionaries.
 *
 * The toggle renders the OTHER language's entry, which is the whole reason this is one map rather
 * than an `otherName` string per dictionary: a third language is a row here and a row in
 * `UI_LANGUAGES`, and no toggle logic changes.
 */
const LANGUAGE_NAMES: Record<UiLanguage, string> = {
  en: "English",
  ja: "日本語",
};

// ---- English: the schema ----------------------------------------------------------------------

export const en = {
  common: {
    /** A read in flight, on a section that has nothing to show yet. */
    loading: "Loading…",
    /** The retry beside a read that failed. Never a dead end — see `MonthTable`. */
    tryAgain: "Try again",
    /** A write in flight, on the button that started it. */
    saving: "Saving…",
    /** The hint on a collapsed form's summary. */
    show: "Show",
    /** Beside a field label, for a field that may be left blank. */
    optional: "optional",
    /** Abandon an armed confirmation — a decision, or a month close. */
    cancel: "Cancel",
    /** The one control on the crash screen. */
    reload: "Reload",
    /** The crash screen itself: `ErrorBoundary` has caught a render failure. */
    crashed: "Something went wrong",
    prevMonth: "Previous month",
    nextMonth: "Next month",
    /**
     * An employee named by number because no display name is at hand.
     *
     * Used wherever a roster lookup misses: a manager id on a row whose manager is not in the
     * read, an approver id with no name behind it. Never a blank, which would read as nobody.
     */
    employeeFallback: (id: number) => `employee ${id}`,
  },

  header: {
    /** The product's name. Not translated in either language — it is what the tab says. */
    appName: "Kintai",
    /** Under the title on the admin dashboard, once the roster has loaded. */
    adminSubtitle: "Employee records, account codes and reporting lines.",
    /** Under the title before the roster read has answered, and on a failure. */
    subtitle: "Attendance and overtime.",
    /** Under the title on the employee's own screen. */
    employeeSubtitle: "Your attendance and overtime.",
    loadingAccount: "Loading your account…",

    /**
     * The administrator's own account code, and whether it is linked to an employee record.
     *
     * Not a courtesy: an admin whose account is not linked is recorded as `null` on every audit
     * entry they write, and this is the only place their code appears.
     */
    account: {
      heading: "Your account code",
      copy: "Copy",
      copied: "Copied",
      /** The clipboard was unavailable (an opaque-origin iframe), so the text was selected instead. */
      selected: "Selected the code — press ⌘C or Ctrl+C to copy it.",
      /**
       * Two halves rather than one function, because the employee id between them is its own
       * element (`data-testid="employee-id"`) that HR reads out and a test pins. A function
       * returning one string would have had to swallow the span.
       */
      linkedPrefix: "You’re set up — this account is employee record ",
      linkedSuffix: ".",
      notLinked:
        "Not linked to an employee record yet, so your changes are recorded without a name" +
        " against them. Link this code to your own record below.",
    },

    /**
     * The header toggle. `switchTo` is read by a reader who is still in the CURRENT language, so
     * it is written in it; the name it is given is the other language's own.
     */
    language: {
      switchTo: (name: string) => `Switch the language to ${name}`,
      /**
       * The save was refused. The switch itself stands — the dictionary is already in the bundle,
       * so honouring the press costs nothing — and this says precisely what did not happen.
       */
      notSaved: "This choice could not be saved, so it will not be remembered next time.",
    },
  },

  tabs: {
    /** The admin dashboard's default: what needs a human right now. */
    overview: "Needs attention",
    monthly: "Monthly",
    roster: "Roster",
    /** The employee gadget's default: the day they are clocking through. */
    today: "Today",
    month: "This month",
  },

  /** 今日 — the employee's own day. */
  today: {
    heading: "Today’s punches",
    emptyDay: "No punches yet today",

    /**
     * The forgotten clock-out, filed as a REQUEST and never as an edit. Nothing changes until an
     * approver applies it, which is why the confirmation says "waiting on a decision" and never
     * "fixed".
     */
    missingOut: {
      intro: "File a request for the clock-out you missed.",
      timeLabel: "The time you actually clocked out",
      reasonLabel: "Reason",
      reasonPlaceholder: "e.g. I forgot to clock out when I left",
      submit: "Request the missing clock-out",
      /**
       * Visible text rather than a placeholder: a `type="time"` input ignores `placeholder` in
       * most browsers, so guidance put there would never show.
       */
      hint: "Enter the time you actually left work (e.g. 18:30). The person approving it reads your reason.",
      filed: "Filed · waiting on a decision",
    },
  },

  /** 今月 — the month an employee reads back. */
  month: {
    /**
     * The guardrail. A pending number in a column headed "Overtime" reads as money owed unless
     * something says otherwise, and this is that something.
     */
    claimsNote: "Overtime shown here is a claim awaiting approval, not a payout.",
    empty: (period: string) => `${period} has no punches.`,
    columns: {
      date: "Date",
      workedHours: "Worked",
      overtime: "Overtime",
      needsALook: "Needs a look",
    },
  },

  /** 要対応, section 1: a request waiting on a decision, and who — if anybody — can decide it. */
  pending: {
    heading: "Waiting on a decision",
    summary: (count: number, stranded: number) =>
      `${count} ${count === 1 ? "request" : "requests"}` +
      (stranded > 0 ? ` · ${stranded} with nobody able to decide` : ""),
    empty: "Nothing is waiting on anybody’s decision.",

    /**
     * Whose hand filed it, which is not always whose request it is — and an unrecorded filer is
     * not the same as somebody filing their own. Conflating the two would hide the commonest way a
     * request stalls: whoever files one can never decide it.
     */
    filedBy: (name: string) => `Filed by ${name}.`,
    filerUnknown: "Who filed it was not recorded.",

    /**
     * The month this correction is dated in has been closed off. Applying an approved correction
     * is the one write still allowed into a closed month, so this is a fact about the decision
     * rather than a refusal of it.
     */
    closedPeriod: (period: string) =>
      `Closed · the period ${period} is closed. Approving this changes a month that has already` +
      " been closed off.",

    /** Nobody is eligible, so this request will wait for ever unless the organisation changes. */
    stranded: (employeeName: string) =>
      `Nobody can decide this — it will wait for ever. Give ${employeeName} a manager or a` +
      " designated approver on the Roster tab, or look at who filed it: whoever files a request" +
      " can never be the one who decides it.",

    /** The viewer is named by the org chart, so the decision controls are on this row. */
    yours: (eligible: string[]) =>
      eligible.length > 1
        ? `Yours to decide — you are one of: ${eligible.join(", ")}`
        : "Yours to decide",

    decidedByOthers: (eligible: string[]) =>
      `Can be decided by ${eligible.join(", ")} — not by you, and not here: one of them decides` +
      " it from their own dashboard, or by asking their assistant for their pending approvals.",

    /** The confirmation restates ONE request, in the words the agent's own card would have used. */
    confirmDetail: (employeeName: string, ask: string) => ` — ${employeeName}: ${ask}`,
    /** 差し戻し and 却下 require it: the employee reads it as the reason. */
    commentLabel: "Reason (the employee sees this)",
    commentPlaceholderReturn: "e.g. Check your clock-out time and file it again",
    commentPlaceholderReject: "e.g. Does not match the site record",
    confirmAction: (action: ApprovalAction) => EN_CONFIRM_DECISION[action],

    /**
     * The decision landed and the request is STILL pending — a multi-step route advanced to
     * somebody else. A terminal decision needs no notice: the re-read removes the row.
     */
    movedOn: (action: ApprovalAction) =>
      `${EN_DECISIONS[action]} recorded. This request moved to its next step and is waiting on` +
      " somebody else.",

    /** What the request asks for: overtime on a day. */
    askOvertime: (minutes: number, workDate: string) =>
      `${enShortDuration(minutes)} of overtime on ${workDate}`,
    /** What the request asks for: a correction to a punch on a day. */
    askAmendment: (workDate: string, change: string) => `${workDate}: ${change}`,
    /**
     * An addition has no left-hand side. "(none recorded)" is the honest comparison; a fabricated
     * 00:00 would read as a punch that exists.
     */
    amendmentAdded: (kind: string, at: string) => `${kind} added at ${at} (none recorded)`,
    amendmentMoved: (kind: string, from: string, to: string) => `${kind} ${from} → ${to}`,
  },

  /** 要対応, section 2: a day whose punches do not make sense. */
  anomalies: {
    heading: (period: string) => `Days that need a look (${period})`,
    summary: (days: number, employees: number) =>
      `${days} ${days === 1 ? "day" : "days"} across ` +
      `${employees} ${employees === 1 ? "employee" : "employees"}`,
    empty: "Every day with punches this month pairs up.",
    showPunches: "Show punches",
    hidePunches: "Hide punches",
    readingPunches: "Reading the punches…",
    /** The day was read and has none: a correction removed them since the flag was computed. */
    noPunches: "No punches on this day any more.",
    credited: (minutes: number) => `Credited ${enShortDuration(minutes)}`,
  },

  /** 要対応, section 3: an employee the system will turn away the first time they file anything. */
  blockers: {
    heading: "Not ready to use Kintai",
    summary: (count: number) => `${count} ${count === 1 ? "employee" : "employees"}`,
    emptyRoster: "No employee records yet — add the first one on the Roster tab.",
    allReady: "Everybody is linked and has somebody who can approve for them.",
  },

  /** The Roster tab: who exists, who is linked, and who still cannot use the system. */
  roster: {
    heading: "Roster",
    summary: (total: number, notReady: number) =>
      total === 0
        ? "Nobody yet"
        : `${total} ${total === 1 ? "employee" : "employees"}` +
          (notReady > 0 ? ` · ${notReady} not ready to use Kintai` : " · all ready"),
    empty: "No employee records yet. Add the first one below.",

    /** One employee's row, and the verdict on whether they can use Kintai at all. */
    row: {
      /** Shown only when it is NOT the default: the handful of people filed against a shift date. */
      nightShift: "Night shift · punches filed against the date the shift started",
      /**
       * A neutral badge, deliberately NOT in the readiness column: it is a fact about this
       * person's overtime, not a verdict about whether anybody can approve for them.
       */
      exempt:
        "Exempt under Article 41 · no overtime or holiday premium, but the late-night premium" +
        " still applies",
      ready: (reason: string) => `Ready · ${reason}`,
      notLinked: "No account code linked — they cannot sign in as themselves.",
      /**
       * Not "overtime". A punch correction needs approval too, and naming only overtime is what
       * made an exempt officer look finished: they file no overtime, so the warning read as
       * inapplicable to them.
       */
      noApproverExempt:
        "Nobody can approve for them — their Article 41 exemption covers overtime, but a punch" +
        " correction still needs a person. Give them a manager or a designated approver.",
      noApprover:
        "Nobody can approve for them — anything they file will be refused. Give them a manager," +
        " or a designated approver if they report to nobody.",
      /** Why this employee counts as approvable, in the order `hasReachableApprover` decides it. */
      reportsTo: (managers: string) => `reports to ${managers}`,
      approvedBy: (approver: string) => `approver ${approver}`,
      approvable: "approvable",
      linkCode: "Link code",
      setManager: "Set manager",
      setApprover: "Set approver",
      /** Offered on every row, and NOT as a repair: it finishes nothing. */
      exemptAction: "Article 41",
      workDates: "Work dates",
    },

    /** The five forms, each with its own message directly beneath its own button. */
    forms: {
      /** The label on every employee picker, and the empty option inside one. */
      employee: "Employee",
      chooseEmployee: "Choose an employee…",
      /** Shared disabled hint: nothing to pick from yet. */
      needAnEmployee: "Add an employee record first.",

      link: {
        title: "Link an account code",
        hint:
          "The employee reads this off their own Kintai page and gives it to you — there is no way" +
          " to look one up. Linking replaces whatever code they had before, which is how an email" +
          " change is handled.",
        submit: "Link account",
        code: "Account code",
        /** The shape of a code, not a word: identical in both languages. */
        codePlaceholder: "00000000-0000-0000-0000-000000000000",
        done: (name: string) => `Linked ${name} to that account code.`,
      },

      reportingLine: {
        title: "Set a reporting line",
        hint:
          "A reporting line is what lets the manager approve this employee’s overtime. It opens" +
          " now and stays open; nobody can approve their own submissions.",
        disabledHint: "Two employee records are needed before anyone can report to anyone.",
        submit: "Set reporting line",
        manager: "Reports to",
        done: (employee: string, manager: string) => `${employee} now reports to ${manager}.`,
      },

      approver: {
        title: "Set a designated approver",
        hint:
          "For an employee at the top of the organisation, who reports to nobody: it names the one" +
          " person who may approve what they file — overtime, and corrections to their punches." +
          " Use a reporting line instead wherever one honestly exists. Nobody may approve their" +
          " own submissions, so an employee cannot be their own approver.",
        disabledHint: "Two employee records are needed before anyone can approve for anyone.",
        submit: "Set approver",
        approvedBy: "Approved by",
        done: (approver: string, employee: string) =>
          `${approver} can now approve for ${employee}.`,
      },

      exemption: {
        title: "Record an Article 41 exemption",
        hint:
          "For a manager or officer whose authority and treatment make them a managerial or" +
          " supervisory employee under Article 41 of the Labour Standards Act: it marks them exempt" +
          " from overtime and holiday premiums, but the late-night premium still applies, so they" +
          " file no overtime requests. It does NOT give them an" +
          " approver — their punches still need correcting sometimes, and a correction needs a" +
          " person, so they still need a manager or a designated approver. Recorded from now and" +
          " open-ended — there is no way to end it here yet, so use it only where the" +
          " determination has actually been made.",
        submit: "Record exemption",
        done: (name: string) => `${name} is recorded as exempt under Article 41 from now.`,
      },

      workDate: {
        title: "Set which day punches are filed against",
        hint:
          "Office staff finish before midnight, so the calendar date is right for them and it is" +
          " the default. A night shift crossing midnight has to be filed against the date it" +
          " started, or it splits across two days and both get flagged. This applies to punches" +
          " made from now on — it does not move anything already recorded, so set it when you" +
          " onboard someone who works nights. Do not change it while the employee is clocked in:" +
          " their current shift is stranded half on each day and both halves get flagged, and only" +
          " an administrative correction can tidy that up. Wait until they have clocked out.",
        submit: "Set policy",
        label: "Work date",
        current: (policy: WorkDatePolicy) => `Currently ${EN_WORK_DATE_POLICIES[policy]}.`,
        /**
         * Names what will happen to punches FROM NOW rather than claiming a repair: the setting is
         * not retroactive, and a confirmation that read as one would be a promise nothing keeps.
         */
        done: (name: string, policy: WorkDatePolicy) =>
          `${name}: new punches will be filed ` +
          (policy === "shift_start"
            ? "against the date their shift started"
            : "against the date they happen on") +
          ". Punches already recorded are unchanged.",
      },

      create: {
        title: "Add an employee",
        hint:
          "Creates the record only. They still need an account code linked, and somebody who can" +
          " approve for them, before they can use Kintai.",
        submit: "Add employee",
        number: "Employee number",
        numberPlaceholder: "E-1001",
        name: "Name",
        namePlaceholder: "Taro Tanaka",
        joinedOn: "Joining date",
        department: "Department",
        employmentType: "Employment type",
        employmentTypePlaceholder: "Full-time",
        approver: "Designated approver",
        /** The escape hatch for someone at the top of the org chart. */
        approverNote: "For an employee who reports to nobody.",
        approverNone: "Nobody",
        done: (name: string) =>
          `Added ${name}. They still need an account code and someone who can approve for them.`,
      },
    },
  },

  /** 月次: one month's hours per employee, and the one write that closes it. */
  monthly: {
    /**
     * Closed, and NOT frozen. An approved correction is still applied into a closed month, so
     * these numbers can still move; what has stopped is everything else.
     */
    closedBadge: (period: string) =>
      `Closed · ${period} is closed. Ordinary edits are refused; an approved correction is still` +
      " applied, so these totals can still change.",
    closeMonth: "Close this month",
    closing: "Closing…",
    reading: "Reading the month…",
    empty: (period: string) =>
      `${period} has no punches — nobody clocked in this month, so there is nothing to total.`,

    /** The two-step close, inline — never `window.confirm`, on the one irreversible write here. */
    confirm: {
      ariaLabel: (period: string) => `Close ${period}`,
      heading: (period: string) => `Close ${period}?`,
      ordinaryEdits: "Ordinary punches and edits into this month stop here.",
      approvedCorrections: "An approved correction is still applied — approval is the one way in that stays open.",
      totalsMove: "So the totals can still move: closing a month does not freeze these numbers.",
      irreversible: "There is no way to reopen a closed month. This cannot be undone.",
      close: (period: string) => `Close ${period}`,
    },

    columns: {
      employee: "Employee",
      daysWorked: "Days worked",
      workedHours: "Worked",
      needsALook: "Needs a look",
    },
    /** On the count that jumps to 要対応 — offered only for the month that panel is reading. */
    anomalyLink: (count: number, name: string) =>
      `${count} ${count === 1 ? "day" : "days"} need a look for ${name} — open Needs attention`,
  },

  /**
   * How a punch got into the record, in words an HR reader can act on — never the raw value stored
   * in `punches.source`, and never the platform's own word `gadget`.
   */
  punchSource: {
    /**
     * WHERE the punch came from, not who it belongs to. "Punched by the employee" was written for
     * the admin drill-down and reads as somebody else's punch on the one screen where it is the
     * reader's own — an employee looking at their 今日 tab is the employee. Naming the app instead
     * says the same thing to both readers, and still contrasts with `admin` and `import`, which is
     * the whole distinction this map exists to draw. `ja` has always been 本人打刻.
     */
    gadget: "Punched in the app",
    /**
     * The one source with a story worth telling: it is an approved correction, and what matters is
     * WHO approved it and WHY, not the bare fact that it differs from what was first recorded.
     */
    amendment: (approver: string, reason: string) =>
      `Corrected (approved by ${approver}, reason: ${reason})`,
    unknownApprover: "unknown",
    noReason: "no reason recorded",
    admin: "Entered by an administrator",
    import: "Imported",
  },

  /**
   * What the capability threw, turned into something an HR user can act on.
   *
   * SERVER-SIDE DETAIL TEXTS STAY ENGLISH and are not in this file. They are agent-facing as well
   * as human-facing, and most of them are already written for a person; an unmapped detail
   * therefore shows in English to a Japanese reader. That is honest — the alternative is guessing
   * at a translation of a sentence this module has never seen — and the common codes are all
   * mapped. `failureDetail`'s raw text is unchanged for the same reason: it is for reporting.
   */
  errors: {
    byCode: EN_BY_CODE,

    /**
     * Details that are correct for an API caller and wrong for the person in front of the screen.
     * Keyed by meaning; `errors.ts` owns the pattern that matches each one.
     */
    details: {
      /**
       * The empty dropdown. Every employee id these forms send comes from a `<select>`, and an
       * untouched one submits `""`, which `Number("")` turns into `0` — so the API answers
       * "employee must be a positive employee id", a true statement about an argument and a
       * useless description of what the reader did, which is forget to pick somebody.
       */
      employeeIdRequired: "Choose someone from the list first.",

      /**
       * The exemption pressed twice. `grantExemption` refuses a second open period, and its
       * English detail spells out 管理監督者 — so before this entry an English screen refused in
       * 漢字. Glossed as Article 41 here, the way `roster.row.exempt` is, and it repeats the
       * server's other half: ending an exemption is a genuine gap in the tab, not a mistake the
       * reader made, so they are told that rather than left pressing the button again.
       */
      alreadyExempt:
        "This employee is already recorded as exempt under Article 41. Ending an exemption is not" +
        " supported here yet.",
    },

    /**
     * What to say when there is nothing to go on — a dropped session, a raw SQLite failure, a
     * thrown non-Error. Each one names the action that failed, so an unrecognised failure still
     * lands next to the thing that failed rather than guessing at a cause.
     */
    fallbacks: {
      readAccount: "Couldn’t read your Kintai account.",
      readRoster: "Couldn’t load the roster.",
      linkAccount: "Couldn’t link that account code.",
      setReportingLine: "Couldn’t set that reporting line.",
      setApprover: "Couldn’t set that designated approver.",
      grantExemption: "Couldn’t record that exemption.",
      setWorkDatePolicy: "Couldn’t change that work-date policy.",
      createEmployee: "Couldn’t create that employee.",
      readPending: "Couldn’t read the queue of requests waiting on a decision.",
      readAnomalousDays: "Couldn’t read the flagged days.",
      readDay: "Couldn’t read that day’s punches.",
      decide: "Couldn’t record that decision.",
      readMonth: "Couldn’t read that month.",
      closeMonth: "Couldn’t close that month.",
      readToday: "Couldn’t read today’s punches.",
      punch: "Couldn’t record that punch.",
      fileRequest: "Couldn’t file that request.",
      readMyMonth: "Couldn’t read your attendance for that month.",
    },
  },

  /** The five wire enumerations, and the two formats that are arithmetic as well as words. */
  labels: {
    punchKinds: EN_PUNCH_KINDS,
    anomalies: EN_ANOMALIES,
    overtimeStates: EN_OVERTIME_STATES,
    decisions: EN_DECISIONS,
    workDatePolicies: EN_WORK_DATE_POLICIES,
    languageNames: LANGUAGE_NAMES,

    durations: {
      /**
       * `2h 30m`, `45m`, `3h` — the empty half dropped, because this labels ONE request inside a
       * sentence ("2h 30m of overtime on 2026-09-01").
       */
      short: enShortDuration,
      /**
       * `8h 15m`, `162h 30m` — always both units, because this fills a column a reader runs their
       * eye down and `162h` beside `162h 30m` makes it ragged at exactly the place somebody is
       * comparing two people's months.
       */
      full: (minutes: number) => `${Math.floor(minutes / 60)}h ${minutes % 60}m`,
    },

    ages: {
      /**
       * How long a request has waited, as a BUCKET: `2d`, `3h`, `< 1h`. An age that ticked would
       * rerender the whole queue every second to report a precision nobody can act on, and "2d" is
       * the entire decision the column informs: chase it, or leave it.
       *
       * Truncated rather than rounded, so a row never claims to be older than it is, and clamped
       * at zero — `submitted_at` is nullable and reports 0, and a clock that moved backwards
       * between the write and the read would otherwise render a negative wait.
       */
      waiting: (waitingMs: number) => {
        const hours = Math.max(0, Math.floor(waitingMs / (60 * 60 * 1000)));
        if (hours >= 24) return `${Math.floor(hours / 24)}d`;
        return hours === 0 ? "< 1h" : `${hours}h`;
      },
    },
  },
};

/** Every string either screen can render, in one language. `en` is the schema; `ja` satisfies it. */
export type Messages = typeof en;

// ---- 日本語: the same shape, checked against it ------------------------------------------------
//
// `satisfies Messages` and NOT `: Messages`. The annotation would widen every literal to `string`
// and hide a missing key behind an inferred index signature; `satisfies` checks the shape and keeps
// the literal types, so `Messages` stays `typeof en` and this object has to answer for every key in
// it. A key missing here fails the build. A key with the wrong ARITY does not — see the runtime
// parity walk in `messages.test.ts`, which exists for exactly that gap.

export const ja = {
  common: {
    loading: "読み込み中…",
    tryAgain: "再試行",
    saving: "保存中…",
    show: "表示",
    optional: "任意",
    cancel: "やめる",
    reload: "再読み込み",
    crashed: "問題が発生しました",
    prevMonth: "前の月",
    nextMonth: "次の月",
    employeeFallback: (id: number) => `従業員 ${id}`,
  },

  header: {
    appName: "Kintai",
    adminSubtitle: "従業員レコード、アカウントコード、報告ラインの管理。",
    subtitle: "勤怠と残業。",
    employeeSubtitle: "あなたの勤怠と残業。",
    loadingAccount: "アカウントを読み込んでいます…",

    account: {
      heading: "あなたのアカウントコード",
      copy: "コピー",
      copied: "コピーしました",
      selected: "コードを選択しました — ⌘C または Ctrl+C でコピーしてください。",
      linkedPrefix: "設定は完了しています — このアカウントは従業員レコード ",
      linkedSuffix: " です。",
      notLinked:
        "まだ従業員レコードに紐づいていないため、あなたの変更は名前なしで記録されます。" +
        "下のフォームでこのコードを自分のレコードに紐づけてください。",
    },

    language: {
      switchTo: (name: string) => `表示言語を ${name} に切り替える`,
      notSaved: "この選択は保存されませんでした。次回は記憶されません。",
    },
  },

  tabs: {
    overview: "要対応",
    monthly: "月次",
    roster: "名簿",
    today: "今日",
    month: "今月",
  },

  today: {
    heading: "今日の打刻",
    emptyDay: "今日はまだ打刻がありません",

    missingOut: {
      intro: "退勤の打刻漏れを申請します。",
      timeLabel: "実際の退勤時刻",
      reasonLabel: "理由",
      reasonPlaceholder: "例: 退勤時に打刻を忘れました",
      submit: "退勤の打刻漏れを申請",
      hint: "実際に職場を離れた時刻を入力してください（例 18:30）。理由は承認する人が読みます。",
      filed: "申請しました · 承認待ち",
    },
  },

  month: {
    claimsNote: "残業時間は承認待ちの申請であり、承認されるまで支給額ではありません。",
    empty: (period: string) => `${period} には打刻がありません。`,
    columns: {
      date: "日付",
      workedHours: "労働時間",
      overtime: "残業",
      needsALook: "要確認",
    },
  },

  pending: {
    heading: "承認待ち",
    summary: (count: number, stranded: number) =>
      `${count}件` + (stranded > 0 ? ` · ${stranded}件は決定できる人がいません` : ""),
    empty: "承認待ちはありません — 誰の決定も待っていません。",

    filedBy: (name: string) => `申請者: ${name}。`,
    filerUnknown: "申請者は記録されていません。",

    closedPeriod: (period: string) =>
      `締め済み · ${period} は締め済みです。承認すると、すでに締めた月の内容が変わります。`,

    stranded: (employeeName: string) =>
      `これを決定できる人がいません — このままでは永久に待ち続けます。名簿タブで ${employeeName} に` +
      "上長または指定承認者を設定してください。あるいは申請者を確認してください: 申請した本人は" +
      "決定者になれません。",

    yours: (eligible: string[]) =>
      eligible.length > 1
        ? `あなたが決定できます — 決定できるのは ${eligible.join("、")} のいずれかです`
        : "あなたが決定できます",

    decidedByOthers: (eligible: string[]) =>
      `${eligible.join("、")} が決定できます — あなたではなく、この画面でもありません。` +
      "いずれかの担当者が自分のダッシュボードから、または担当者のアシスタントに承認待ちを尋ねて" +
      "決定します。",

    confirmDetail: (employeeName: string, ask: string) => ` — ${employeeName}: ${ask}`,
    commentLabel: "理由（本人に表示されます）",
    commentPlaceholderReturn: "例: 退勤時刻を確認して再申請してください",
    commentPlaceholderReject: "例: 現場の記録と一致しません",
    confirmAction: (action: ApprovalAction) => JA_CONFIRM_DECISION[action],

    movedOn: (action: ApprovalAction) =>
      `${JA_DECISIONS[action]}を記録しました。この申請は次の段階に進み、別の担当者の決定を待っています。`,

    askOvertime: (minutes: number, workDate: string) =>
      `${workDate} の残業 ${jaShortDuration(minutes)}`,
    askAmendment: (workDate: string, change: string) => `${workDate}: ${change}`,
    amendmentAdded: (kind: string, at: string) => `${at} に${kind}を追加（記録なし）`,
    amendmentMoved: (kind: string, from: string, to: string) => `${kind} ${from} → ${to}`,
  },

  anomalies: {
    heading: (period: string) => `要確認の勤務日 (${period})`,
    summary: (days: number, employees: number) => `${employees}名で${days}日`,
    empty: "フラグの立った勤務日はありません — 今月の打刻はすべて対になっています。",
    showPunches: "打刻を表示",
    hidePunches: "打刻を隠す",
    readingPunches: "打刻を読み込んでいます…",
    noPunches: "この日の打刻はもうありません。",
    credited: (minutes: number) => `労働時間 ${jaShortDuration(minutes)}`,
  },

  blockers: {
    heading: "未整備",
    summary: (count: number) => `${count}名`,
    emptyRoster: "従業員がまだ登録されていません — 名簿タブで最初のレコードを追加してください。",
    allReady: "全員 Kintai を使える状態です — 全員が紐づけ済みで、承認できる人もいます。",
  },

  roster: {
    heading: "名簿",
    summary: (total: number, notReady: number) =>
      total === 0
        ? "まだ誰も登録されていません"
        : `${total}名` +
          (notReady > 0 ? ` · ${notReady}名は Kintai を使えません` : " · 全員利用可能"),
    empty: "従業員レコードがまだありません。下のフォームで最初の一人を追加してください。",

    row: {
      nightShift: "夜勤 · 打刻はシフトの開始日に記録されます。",
      exempt: "管理監督者 · 時間外・休日の割増はつきませんが、深夜割増は適用されます",
      ready: (reason: string) => `利用可能 · ${reason}`,
      notLinked: "アカウントコードが紐づいていません — 本人としてサインインできません。",
      noApproverExempt:
        "承認できる人がいません — 管理監督者は残業が対象外ですが、打刻の修正には承認する人が" +
        "必要です。上長または指定承認者を設定してください。",
      noApprover:
        "承認できる人がいません — この人が申請したものはすべて拒否されます。上長を設定するか、" +
        "誰にも報告しない場合は指定承認者を設定してください。",
      reportsTo: (managers: string) => `報告先: ${managers}`,
      approvedBy: (approver: string) => `承認者: ${approver}`,
      approvable: "承認可能",
      linkCode: "コードを紐づけ",
      setManager: "上長を設定",
      setApprover: "承認者を設定",
      exemptAction: "管理監督者",
      workDates: "勤務日の基準",
    },

    forms: {
      employee: "従業員",
      chooseEmployee: "従業員を選択…",
      needAnEmployee: "先に従業員レコードを追加してください。",

      link: {
        title: "アカウントコードを紐づける",
        hint:
          "従業員が自分の Kintai 画面で確認して伝えるコードです — こちらから調べる方法はありません。" +
          "紐づけると以前のコードは置き換わります。メールアドレスの変更もこの方法で対応します。",
        submit: "アカウントを紐づける",
        code: "アカウントコード",
        codePlaceholder: "00000000-0000-0000-0000-000000000000",
        done: (name: string) => `${name} をそのアカウントコードに紐づけました。`,
      },

      reportingLine: {
        title: "報告ラインを設定する",
        hint:
          "報告ラインがあることで、上長がこの従業員の残業を承認できます。設定した時点から有効で、" +
          "解除されるまで続きます。自分の申請を自分で承認することはできません。",
        disabledHint: "報告ラインを設定するには従業員レコードが2件必要です。",
        submit: "報告ラインを設定",
        manager: "報告先",
        done: (employee: string, manager: string) => `${employee} の報告先を ${manager} にしました。`,
      },

      approver: {
        title: "指定承認者を設定する",
        hint:
          "誰にも報告しない、組織の最上位にいる従業員のためのものです。その人が申請するもの — 残業と" +
          "打刻の修正 — を承認できる唯一の人を指名します。報告ラインが実際に存在する場合は、そちらを" +
          "使ってください。自分の申請を自分で承認することはできないため、本人を承認者にすることは" +
          "できません。",
        disabledHint: "指定承認者を設定するには従業員レコードが2件必要です。",
        submit: "承認者を設定",
        approvedBy: "承認者",
        done: (approver: string, employee: string) =>
          `${approver} が ${employee} の申請を承認できるようになりました。`,
      },

      exemption: {
        title: "管理監督者の認定を記録する",
        hint:
          "権限と待遇から労働基準法41条の管理監督者にあたる管理者・役職者のためのものです。時間外・" +
          "休日の割増の対象外として記録されますが、深夜割増は適用されます。残業申請は行わなくなり" +
          "ます。承認者が設定されるわけでは" +
          "ありません — 打刻の修正はときに必要で、修正には承認する人が必要ですから、上長または" +
          "指定承認者は引き続き必要です。記録は設定時点から始まり、終了日はありません — ここで" +
          "終わらせる方法はまだないため、実際に認定した場合にのみ使ってください。",
        submit: "認定を記録",
        done: (name: string) => `${name} を管理監督者として記録しました（設定時点から）。`,
      },

      workDate: {
        title: "打刻を記録する勤務日の基準を設定する",
        hint:
          "日勤の従業員は日付が変わる前に退勤するため、暦日が正しく、これが既定値です。日付を" +
          "またぐ夜勤は開始した日付に記録する必要があります。そうしないと2日に分かれ、両方に" +
          "フラグが立ちます。これは今後の打刻に適用されます — すでに記録された打刻は移動しない" +
          "ため、夜勤の人を登録するときに設定してください。出勤中に変更しないでください: その" +
          "シフトが2日にまたがって取り残され、両方にフラグが立ち、管理者による修正でしか" +
          "整理できません。退勤するまで待ってください。",
        submit: "基準を設定",
        label: "勤務日",
        current: (policy: WorkDatePolicy) => `現在は${JA_WORK_DATE_POLICIES[policy]}です。`,
        done: (name: string, policy: WorkDatePolicy) =>
          `${name}: 今後の打刻は` +
          (policy === "shift_start" ? "シフトを開始した日付" : "実際に打刻した日付") +
          "に記録されます。すでに記録された打刻は変わりません。",
      },

      create: {
        title: "従業員を追加する",
        hint:
          "レコードを作成するだけです。Kintai を使えるようになるには、アカウントコードの紐づけと、" +
          "承認できる人がまだ必要です。",
        submit: "従業員を追加",
        number: "社員番号",
        numberPlaceholder: "E-1001",
        name: "氏名",
        namePlaceholder: "田中 太郎",
        joinedOn: "入社日",
        department: "部署",
        employmentType: "雇用形態",
        employmentTypePlaceholder: "正社員",
        approver: "指定承認者",
        approverNote: "誰にも報告しない従業員のためのものです。",
        approverNone: "なし",
        done: (name: string) =>
          `${name} を追加しました。アカウントコードの紐づけと、承認できる人がまだ必要です。`,
      },
    },
  },

  monthly: {
    closedBadge: (period: string) =>
      `締め済み · ${period} は締め済みです。通常の編集は拒否されますが、承認された修正は引き続き` +
      "反映されるため、この合計はまだ動きます。",
    closeMonth: "この月を締める",
    closing: "締めています…",
    reading: "月を読み込んでいます…",
    empty: (period: string) =>
      `${period} には打刻がありません — この月は誰も出勤していないため、合計するものがありません。`,

    confirm: {
      ariaLabel: (period: string) => `${period} を締める`,
      heading: (period: string) => `${period} を締めますか？`,
      ordinaryEdits: "通常の打刻や修正は拒否されます — この月への通常の編集はここで止まります。",
      approvedCorrections: "承認された修正申請は引き続き反映されます — 承認だけが開いたままの入口です。",
      totalsMove: "だから合計はまだ動きます — 締めても数字が固定されるわけではありません。",
      irreversible: "締めを解除する方法はありません — この操作は取り消せません。",
      close: (period: string) => `${period} を締める`,
    },

    columns: {
      employee: "従業員",
      daysWorked: "出勤日数",
      workedHours: "労働時間",
      needsALook: "要確認",
    },
    anomalyLink: (count: number, name: string) =>
      `${name} の要確認の勤務日 ${count}日 — 要対応を開く`,
  },

  punchSource: {
    gadget: "本人打刻",
    amendment: (approver: string, reason: string) => `修正（承認: ${approver}、理由: ${reason}）`,
    unknownApprover: "不明",
    noReason: "理由未記載",
    admin: "管理者による記録",
    import: "取り込み",
  },

  errors: {
    byCode: JA_BY_CODE,

    details: {
      employeeIdRequired: "先に一覧から従業員を選んでください。",
      alreadyExempt:
        "この従業員はすでに管理監督者として記録されています。認定の終了はこのタブではまだ行えません。",
    },

    fallbacks: {
      readAccount: "あなたの Kintai アカウントを読み込めませんでした。",
      readRoster: "名簿を読み込めませんでした。",
      linkAccount: "そのアカウントコードを紐づけられませんでした。",
      setReportingLine: "その報告ラインを設定できませんでした。",
      setApprover: "その指定承認者を設定できませんでした。",
      grantExemption: "その認定を記録できませんでした。",
      setWorkDatePolicy: "勤務日の基準を変更できませんでした。",
      createEmployee: "その従業員を作成できませんでした。",
      readPending: "承認待ちの一覧を読み込めませんでした。",
      readAnomalousDays: "フラグの立った勤務日を読み込めませんでした。",
      readDay: "その日の打刻を読み込めませんでした。",
      decide: "決定できませんでした。",
      readMonth: "その月を読み込めませんでした。",
      closeMonth: "その月を締められませんでした。",
      readToday: "今日の打刻を読み込めませんでした。",
      punch: "打刻できませんでした。",
      fileRequest: "申請できませんでした。",
      readMyMonth: "その月の勤怠を読み込めませんでした。",
    },
  },

  labels: {
    punchKinds: JA_PUNCH_KINDS,
    anomalies: JA_ANOMALIES,
    overtimeStates: JA_OVERTIME_STATES,
    decisions: JA_DECISIONS,
    workDatePolicies: JA_WORK_DATE_POLICIES,
    languageNames: LANGUAGE_NAMES,

    durations: {
      short: jaShortDuration,
      full: (minutes: number) => `${Math.floor(minutes / 60)}時間${minutes % 60}分`,
    },

    ages: {
      waiting: (waitingMs: number) => {
        const hours = Math.max(0, Math.floor(waitingMs / (60 * 60 * 1000)));
        if (hours >= 24) return `${Math.floor(hours / 24)}日`;
        return hours === 0 ? "1時間未満" : `${hours}時間`;
      },
    },
  },
} satisfies Messages;

/** The two dictionaries by code, so the provider needs no branch of its own. */
export const DICTIONARIES: Record<UiLanguage, Messages> = { en, ja };

/**
 * Which language a screen is read in: the OS choice, then the account's, then the browser's.
 *
 * Pure, and takes all three inputs rather than reading `navigator` itself, so the whole rule is
 * one table in a test rather than a global to stub.
 *
 * `os` IS THE SHELL'S PICKER (`theme.locale`, pushed into this iframe on the same channel as dark
 * mode since 2026-09-10) and it outranks everything, because it is the control the reader can see
 * and press. `null` there is not "English": it is the shell sitting on "system", which is the
 * shell explicitly declining to answer so that an app with its own memory of this person can use
 * it. Sending the browser-resolved value instead would make that memory dead weight, which is why
 * the OS patch sends null.
 *
 * `saved` IS THAT MEMORY — the choice on `account_preferences`, `null` when there is none. It is
 * the only cross-device fact in the chain and the only one that survives a different browser; it
 * loses to the OS and beats `navigator`. `null` means never chosen, not "chose English", which is
 * why the column is nullable.
 *
 * `navigatorLanguage` IS THE LAST RESORT, and on a first open by somebody who has chosen nowhere
 * it is the only signal there is: the sandboxed iframe is an opaque origin with no localStorage,
 * no IndexedDB and no cookies, so this app can remember nothing locally at all.
 *
 * Anything that is not a `ja` tag resolves to English, including a language this dictionary has no
 * words for. `fr-FR` becoming French would be a promise the bundle cannot keep; becoming English is
 * the fallback doing its job. Matched on the PREFIX and case-insensitively, because `navigator
 * .language` is `ja`, `ja-JP` and (on some hosts) `JA-jp`.
 */
export function resolveLanguage(
  os: AppLocale | null,
  saved: UiLanguage | null,
  navigatorLanguage: string | undefined,
): UiLanguage {
  for (const chosen of [os, saved]) {
    if (chosen !== null && UI_LANGUAGES.includes(chosen)) return chosen;
  }
  return navigatorLanguage?.toLowerCase().startsWith("ja") === true ? "ja" : "en";
}
