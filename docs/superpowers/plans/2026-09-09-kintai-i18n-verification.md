# Kintai i18n — live verification record (Task 6)

**Date:** 2026-09-09
**Plan:** `2026-09-09-kintai-i18n.md`, Task 6
**Spec:** `../specs/2026-09-09-kintai-i18n-design.md`
**Code verified:** `feat/kintai-i18n` at `4339d84` (Task 5's bundles at `86971b1` plus this task's two
tests). 548 worker tests, 183 app tests, `tsc --noEmit` and `typecheck:app` green on the final tree.
**Transport:** real Cap'n Web over `ws://localhost:8799/api` (`pnpm run-local --port 8799`, wrangler
4.120.0), driven from Node 24.15.0 with `capnweb@0.12.0`; and the two bundles loaded in headless
**Chrome 152.0.7977.83** through the real Workshop page at `/gatekeepers/kintai`, driven over CDP.
Nothing was stubbed and nothing touched SQLite: every write below went through the capability the
screen itself holds (`getGatekeeperApp("kintai").ui`), and every "what was saved" read is that same
capability's `whoAmI().language`.

This record follows `2026-09-07-kintai-employee-gadget-verification.md` and is written against the
CODE rather than the plan text.

## 0. Steps 1–3 first, because the live pass rests on them

**Step 1 — the guard (`app/i18n/no-stray-literals.test.ts`).** Reads every `app/**/*.ts(x)` except
the tests and `app/i18n/messages.ts` — `LanguageToggle.tsx` and `index.tsx` are NOT exempt — through
`import.meta.glob(…, { query: "?raw" })` (so `app/` keeps browser-only types; the first attempt with
`node:fs` failed `tsconfig.app.json`, which has no Node types on purpose), strips `//`, `/* */` and
JSX `{/* */}` comments with a string-aware state machine, and lists `file:line` for any character in
`[぀-ゟ゠-ヿ㐀-䶿一-鿿ｦ-ﾟ]`. **Green on first run: 14 files, zero findings** — every Japanese
character outside the dictionary is in a comment. The scanner proves itself: a synthetic `"確認"` in
a string, a template and JSX text is flagged on lines 2, 3, 4; the same word in every comment form is
not; a `//` inside a string does not hide the literal after it.

**Step 2 — `<html lang>`.** The provider's mount-time assignment gets its assertion: render with
`initial="ja"` over a document whose `lang` is `"en"` → `documentElement.lang === "ja"` before any
press. Both `index.html` files keep their static `lang="en"`: the entry cannot know the language
until `whoAmI()` and `navigator.language` are resolved, so any static value is wrong for one of the
two, and the provider's effect overwrites it on mount — before the first paint, since `main.tsx`
renders nothing until the language is known. An HTML comment saying so was NOT added: the bundle
embeds `index.html` verbatim, so the note would have changed both committed bundles for no runtime
gain; it lives in the test instead. **App suite 178 → 183.**

**Step 3 — bundles.** `rm -rf dist-app dist-app-employee && node build-app.mjs` three times, no
server running: `app.txt` md5 `174b9da0…` (464,828 bytes) and `employee-app.txt` `22506bdc…`
(436,710 bytes) on all three, 42 lines each, blobs `c6208a82…` / `9579cda5…` **equal to HEAD**
(Task 5's commit). Nothing to commit.

## How the session was reached (deltas from the 2026-09-08 procedure)

```
newWebSocketRpcSession("ws://localhost:8799/api")
  → createAccount(name, name, hash) → authenticate(token) → completeOnboarding()
  → provisionAmbientAccount("kintai") → getGatekeeperApp("kintai")     # { iframeHtml, ui }
```

Three things this pass had to add to the earlier driver:

1. **"A browser in a language" is a CDP browser context plus a per-session override.** Each
   scenario's browser is `Target.createBrowserContext` (fresh localStorage, so "close and reopen" is a
   new tab in the same context and "another browser" is a new context), and
   `Emulation.setUserAgentOverride({ acceptLanguage })` + `Emulation.setLocaleOverride` are applied to
   EVERY session — the page's and the auto-attached srcdoc frame's — before its scripts run
   (`setAutoAttach` with `waitForDebuggerOnStart: true`, `Runtime.runIfWaitingForDebugger` after the
   override). Verified inside the frame each time: `navigator.language` read `ja-JP ["ja-JP"]` or
   `en-US ["en-US"]` as intended.
2. **The unlinked screen was watched first** (the 2026-09-08 record left it untested): accounts were
   created, opened, and only then linked to `PROBE-EMP-` employees by the probe admin.
3. **The failed save is a transport refusal inside the real frame** (§5), not a stubbed API. First
   attempt froze the screen, and the reason is worth keeping: React's scheduler drives its work loop
   with `port.postMessage(null)` on its own `MessageChannel`, so a `MessagePort.prototype.postMessage`
   that refuses everything stops React itself. Refusing only non-`null` messages (capnweb's traffic is
   never `null`) leaves React alone and breaks exactly the RPC.

## Probe fixtures created (added to the owner's `.wrangler/state`; nothing was removed)

| Workshop user | Kintai employee | id | Browser context(s) | Notes |
| --- | --- | --- | --- | --- |
| `probe9ja` | `PROBE-EMP-J1` Probe9 Worker Ja | 14 | `ja-JP`; later a fresh `en-US` | the worker scenarios |
| `probe9en` | `PROBE-EMP-E1` Probe9 Worker En | 15 | `en-US` | the English first open, then the failed save |
| `probe9admin` | `PROBE-EMP-A9` Probe9 Admin | 16 | `ja-JP` | temporarily in `config.vars.ADMINS` (`scripts/run-dev-server.ts`), **reverted** |

`whoAmI()` for all three right after provisioning: `"language": null` — nobody has chosen yet.
`listEmployees()` from a worker's stub: *The RPC receiver does not implement the method
"listEmployees"* (the surface pin, still holding). The owner's own employees (`E-01`, `A-02`) and
the earlier probes were never written to; they appear in the admin reads below because the
dashboard is company-wide.

---

## 1. First open follows the browser — PASS, both halves, one finding

`probe9ja` in the `ja-JP` browser, before linking (dumped from inside the srcdoc frame):

```
navigator.language: ja-JP ["ja-JP"]     <html lang>: ja
header:  Kintai / あなたの勤怠と残業。
tabs:    ["今日*","今月"]                   toggle: "English"  aria-label="表示言語を English に切り替える"  type=button
strings: 今日 · 今月 · "This account is not linked to an employee record. Contact HR to be set up." · ← 2026-09 →
         · 残業時間は承認待ちの申請であり、承認されるまで支給額ではありません。 · aria-label=前の月 · aria-label=次の月
uncaught exceptions / console errors: 0 / 0
```

`probe9en` in the `en-US` browser, same moment:

```
navigator.language: en-US ["en-US"]     <html lang>: en
header:  Kintai / Your attendance and overtime.
tabs:    ["Today*","This month"]           toggle: "日本語"  aria-label="Switch the language to 日本語"
strings: Today · This month · "This account is not linked to an employee record. Contact HR to be set up."
         · Overtime shown here is a claim awaiting approval, not a payout. · aria-label=Previous month / Next month
Japanese outside the toggle: []            uncaught / console: 0 / 0
```

**Finding 1 (not fixed here):** the unlinked worker's 今日 shows the SERVER's sentence in English on
the Japanese screen — *"This account is not linked to an employee record. Contact HR to be set
up."* — because `KINTAI_ACCOUNT_NOT_LINKED` has no entry in `t.errors.byCode` (only
`KINTAI_ADMIN_NOT_LINKED` does). The spec accepts English for an unmapped detail, but this is the
first sentence every new Japanese employee reads, before HR has linked them; it deserves a row in
both dictionaries. Recorded, verbatim, as the reviewer's decision.

After `createEmployee` + `linkAccount` (ids 14–16), the linked 今日 read
`出勤 · 今日の打刻 · 今日はまだ打刻がありません` and 今月 `2026-09 には打刻がありません。` —
Japanese throughout; the only Latin-only string on the whole screen was `Kintai`.

---

## 2. The toggle switches the whole screen and saves the choice — PASS

`probe9ja`, `ja-JP` browser, one press of `[data-testid="language-toggle"]`:

```
before:  <html lang>=ja   tabs ["今日*","今月"]           14 strings, 10 of them Japanese
after:   <html lang>=en   tabs ["Today*","This month"]    header "Your attendance and overtime."
         strings: Clock in · Today’s punches · No punches yet today · 2026-09 has no punches. · …
         Japanese outside the toggle: []        toggle now: "日本語" / "Switch the language to 日本語"
         not-saved notice: null                 uncaught / console: 0 / 0
whoAmI() via getGatekeeperApp("kintai").ui → {"accountId":"abdf849b-…","linked":true,"employeeId":14,"language":"en"}
```

Every text node, `aria-label`, `placeholder` and `title` outside the toggle was swept for the
Japanese class after the press: none. The choice reached `account_preferences` — read back through
the capability, not the database.

---

## 3. Close and reopen in the `ja-JP` browser → English — PASS, both directions

A new tab in the SAME `ja-JP` context (token already in its localStorage), the frame confirming
`navigator.language === "ja-JP"`:

```
<html lang>: en   header "Your attendance and overtime."   tabs ["Today*","This month"]   Japanese outside toggle: []
```

The saved choice beat the browser. **And the other way round (3b):** `probe9ja` pressed the toggle
back (`whoAmI().language → "ja"`), then the same account was opened in a FRESH `en-US` browser
context:

```
navigator.language: en-US ["en-US"]     <html lang>: ja     tabs ["今日*","今月"]     header あなたの勤怠と残業。
```

A saved 日本語 beats an English browser exactly as a saved English beat a Japanese one.

---

## 4. The same for an administrator — PASS

`probe9admin` in a `ja-JP` browser (`ADMINS` carried the name for this pass only):

```
<html lang>: ja   header: Kintai / 従業員レコード、アカウントコード、報告ラインの管理。
tabs: ["要対応*","月次","名簿"]   panels: overview visible, monthly/roster hidden, today/month ABSENT
102 distinct strings; 129 Japanese text nodes / attributes outside the toggle
```

Verbatim, a sample of the Japanese dashboard: `承認待ち` / `0件` / `承認待ちはありません — 誰の決定も待って
いません。` / `要確認の勤務日 (2026-09)` / `1名で1日` / `退勤打刻なし` / `打刻を表示` / `未整備` / `4名` /
`管理監督者 · 時間外・休日の割増はつきませんが、深夜割増は適用されます` / `上長を設定` / `承認者を設定` /
`この月を締める` / `従業員 · 出勤日数 · 労働時間 · 要確認` / `4時間30分` / `5名 · 4名は Kintai を使えません`
/ `利用可能 · 報告先: Admin` / `アカウントコードを紐づける` / `従業員を選択…` / `暦日（日勤）` /
`シフト開始日（夜勤）` / `placeholder=田中 太郎` / `placeholder=正社員` /
`aria-label=Admin の要確認の勤務日 1日 — 要対応を開く`.

Every Latin-only string left on that screen is DATA, not copy: `Kintai`, the account id
`bb4f8cff-…`, `Admin · A-02`, `A-02 · Dev · Keiyaku`, `E-01 · Ops · Seishain`, `Test Employee`,
`Probe9 Worker Ja`, `PROBE-EMP-J1 · Probe9` (and E1, A9), the two format placeholders
`00000000-0000-0000-0000-000000000000` and `E-1001`. (`Dev`, `Keiyaku`, `Ops`, `Seishain` are the
owner's own department / employment-type values.)

Press → `<html lang>: en`, header *Employee records, account codes and reporting lines.*, tabs
`["Needs attention*","Monthly","Roster"]`, 102 strings, **Japanese outside the toggle: 0**; not-saved
notice absent; `whoAmI().language → "en"`. Reopen in the same `ja-JP` context → still
`["Needs attention*","Monthly","Roster"]`, `lang=en`. Uncaught / console: 0 / 0 across all three.

---

## 5. A failed save keeps the switch and says so in the new language — PASS

`probe9en`, `en-US` browser, linked, English screen. Inside the real frame, before the press:

```js
const orig = MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage = function (m, ...rest) {
  if (m === null) return orig.call(this, m, ...rest);          // React's scheduler; see deltas (3)
  throw new Error("probe9: the transport refused the message");
};
```

capnweb's `RpcSession.send` catches the throw from `transport.send` and `queueMicrotask(() =>
this.abort(err, false))`, which rejects every pending call — the path a dropped connection takes. Then
one press:

```
before: <html lang>=en   tabs ["Today*","This month"]   notice: null
after:  <html lang>=ja   tabs ["今日*","今月"]           header あなたの勤怠と残業。
        [data-testid="language-not-saved"]: "この選択は保存されませんでした。次回は記憶されません。"
        strings: 出勤 · 今日の打刻 · 今日はまだ打刻がありません · 残業時間は承認待ちの申請であり、… · aria-label=前の月 / 次の月
        uncaught exceptions / console errors: 0 / 0
whoAmI() via the capability → {"accountId":"d6d93580-…","linked":true,"employeeId":15,"language":null}
```

The screen switched and stayed switched; the one sentence about what did not happen is Japanese —
the language the reader is now reading; nothing was saved (`language: null`); and a new tab in the
same `en-US` context opened in English (`lang=en`, `["Today*","This month"]`), which is what "not
remembered next time" means. Nothing reached the error channel.

---

## 6. Still bilingual, or in the wrong language? — one item

Swept mechanically on every English screen (zero Japanese outside the toggle, both pages, every
state above) and by eye on every Japanese screen (the full string dumps, `s9_*.log`). The only
string in the wrong language anywhere is **Finding 1**: the unlinked worker's *"This account is not
linked to an employee record. Contact HR to be set up."* under a Japanese 今日. Nothing was
bilingual: the `承認待ち · waiting on a decision` shape the spec set out to remove appears nowhere,
in either language, on either page.

Not driven, recorded as untested rather than passing: a Japanese screen with real punches and
pending approvals (both probe workers have none; the admin's 要対応 rendered its Japanese from the
owner's one flagged day, `退勤打刻なし`, and the empty queue, `承認待ちはありません`); the
month-close two-step and the decision controls' copy in the browser (jsdom-covered in
`AdminPage.test.tsx`).

## Findings

1. **`KINTAI_ACCOUNT_NOT_LINKED` has no rewrite** (§1) — the first sentence a new Japanese employee
   reads is English. A row in `t.errors.byCode` in both dictionaries; a five-line change, deliberately
   not made inside a verification pass.
2. **React shares the MessageChannel primitive with capnweb** (§5, deltas). Anyone simulating a
   transport failure in this frame must leave `postMessage(null)` alone or they will be testing a
   frozen React, not a refused save.
3. **A locale override must reach the srcdoc frame's own session** (deltas). The frame is its own
   CDP target; an override on the page session alone leaves `navigator.language` inside the frame at
   the machine's value, and the pass would have "proved" the browser default with the wrong browser.
4. **The static `lang="en"` in both `index.html` is a placeholder the provider overwrites before the
   first paint** (§0). Left as is; a static `ja` would be wrong for the other half of the readers.

## State left in the owner's `.wrangler/state`

Nothing was deleted, **no punch was recorded and no period was locked.** Added: three Workshop
accounts (`probe9ja`, `probe9en`, `probe9admin`), onboarding completed; three `PROBE-EMP-` employees
(ids 14–16, department `Probe9`, joined `2026-09-01`) with account links; `account_preferences`:
`probe9ja → "ja"` (toggled twice, en then back), `probe9admin → "en"`, `probe9en` — no row (the only
press was the refused one). No org edges, no approvers, no submissions.

Reverted before committing: `config.vars.ADMINS` back to `["admin"]`; all 19 generated
`wrangler.dev.jsonc` (18 gatekeepers + `workshop-backend`); both `src/generated/*.txt` — left by the
dev server's watchers at 25,578 / 24,228 unminified lines — rebuilt server-stopped to the committed
blobs. **The 2026-09-08 hazard reproduced once more:** the first rebuild after the dev server came
back different on BOTH bundles (`ba906f56…` / `b4308836…`, 42 lines each), the second reproduced
`c6208a82…` / `9579cda5…` — HEAD — byte for byte. Build twice per entry after a dev-server run;
this is now three records saying so. Dev server stopped (8799 free; the owner's 8787 was never
touched), headless Chrome killed, `git status` clean, and 548 worker / 183 app / `tsc --noEmit` /
`typecheck:app` green afterwards.

---

## Task 6 checkboxes

- [x] **Step 1** — the guard test, green on first run, self-checking (§0).
- [x] **Step 2** — `<html lang>` asserted on mount as well as on toggle; the static `lang="en"` kept
  as the pre-mount placeholder (§0, finding 4).
- [x] **Step 3** — three builds, byte-identical, equal to the committed blobs (§0).
- [x] **Step 4** — the live pass above: first open by browser (§1), toggle and save (§2), reopen in
  both directions (§3), the administrator (§4), the refused save (§5), the sweep (§6).
