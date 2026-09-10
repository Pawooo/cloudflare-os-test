# OS language switcher — live verification record (Task 4)

**Date:** 2026-09-10
**Plan:** `2026-09-10-os-language-switcher.md`, Task 4
**Spec:** `../specs/2026-09-10-os-language-switcher-design.md` ("Tests" → live pass)
**Code verified:** `feat/os-language-switcher` at `30188c0` — shell 373 / Kintai 553 worker + 205 app,
`tsc --noEmit` and `typecheck:app` green per Task 3's gates; nothing in code changed during this pass,
so they were not re-run.
**Amended 2026-09-10 after the fix wave:** §4's finding 1 is fixed in `fix(kintai): a theme re-push is
not somebody choosing a language`, together with a second, worse consequence of the same line that the
whole-branch review found and this pass had no scenario for (§4f). The amendments are marked; the
observations above them are left exactly as they were driven, against `30188c0`. Everything added
after the fix is labelled **VERIFIED BY TEST** — no browser was driven again. **Re-driven live later
the same day**, against `f808b33`, for §4, §4f and §4g only: see "Re-run after the fix wave" at the end.
**Transport:** own stack, `pnpm run-local --port 8799` (wrangler dev on `localhost:8799`, the dev server
generating every `wrangler.dev.jsonc` and serving the Kintai bundles unminified — 897,733 chars for the
worker page, 950,251 for the admin page); fixtures and every "what did the account save" read over real
Cap'n Web `ws://localhost:8799/api` from Node 24.15.0 with `capnweb@0.12.0`; the screens driven in
headless **Chrome 152.0.7977.83** over CDP against the REAL Workshop page at `/gatekeepers/kintai` —
the sidebar utility strip clicked with `Input.dispatchMouseEvent` at the button's own coordinates, the
iframe read through its auto-attached srcdoc session. Nothing touched SQLite: the only writes were
the clicks, and every saved-language read is `getGatekeeperApp("kintai").ui.whoAmI().language` —
the facet host the screen itself holds.

Procedure as in `2026-09-09-kintai-i18n-verification.md`: a "browser in a language" is a
`Target.createBrowserContext` (fresh `localStorage`) with `Emulation.setUserAgentOverride({
acceptLanguage })` + `Emulation.setLocaleOverride` applied to the page session AND to the srcdoc
frame's session before its scripts run (`setAutoAttach` with `waitForDebuggerOnStart`). Verified
inside the frame on every open: `navigator.language` read `en-US ["en-US"]` or `ja-JP ["ja-JP"]`
as intended. "Without a reload" is proven three ways on each screen: a `window.__probe10` mark set
inside the frame before the click survives it, the frame's CDP `targetId` is unchanged, and the
shell page's `performance.timeOrigin` is unchanged.

## Probe fixtures created (added to the owner's `.wrangler/state`; nothing was removed)

| Workshop user | Kintai employee | id | Notes |
| --- | --- | --- | --- |
| `probe10emp` | `PROBE-EMP-L1` Probe10 Worker | 17 | account `5b0b516a-…`; the employee scenarios |
| `probe10admin` | `PROBE-EMP-L2` Probe10 Admin | 18 | account `a30741a6-…`; temporarily in `config.vars.ADMINS` (`scripts/run-dev-server.ts`), **reverted** |

Both created, onboarded and provisioned over RPC, then linked by `probe10admin` (department
`Probe10`, joined `2026-09-01`). `whoAmI()` for both right after linking: `"language": null`. The
surface pin still holds: `listEmployees()` from the worker's stub → *The RPC receiver does not
implement the method "listEmployees"*. The owner's own employees (`E-01`, `A-02`) were never written
to; they appear in the admin reads below because the dashboard is company-wide.

---

## 1. The strip, on system, in an `en-US` browser — PASS (employee and admin)

`localStorage` before opening: `["authToken"]` only. Verbatim from the shell page:

```
button[aria-label^="Language:"]  aria-label = "Language: system (English). Switch to English."   type=button
  glyph: <svg … viewBox="0 0 256 256"> (Phosphor Translate)   text: ""   immediately BEFORE the theme button
strip buttons, in order: ["Language: system (English). Switch to English.", "Theme: system (dark). Switch to light.", "Open profile menu"]
localStorage["gadgets:locale"]: null
```

Kintai, inside the frame (`navigator.language` `en-US`):

```
employee: <html lang>=en  Kintai / Your attendance and overtime.  tabs ["Today*","This month"]
          14 strings: Kintai · Your attendance and overtime. · Today · This month · Clock in · Today’s punches
          · No punches yet today · ← · 2026-09 · → · Overtime shown here is a claim awaiting approval, not a payout.
          · 2026-09 has no punches. · aria-label=Previous month · aria-label=Next month
admin:    <html lang>=en  Kintai / Employee records, account codes and reporting lines.  tabs ["Needs attention*","Monthly","Roster"]
          108 strings, 0 Japanese
[data-testid="language-toggle"]: absent on both (Kintai's own control is gone)     uncaught / console errors: 0 / 0
```

## 2. Click once → `EN`; click again → `日本`, Kintai re-renders in 日本語 without a reload — PASS (both)

First click (employee, same for admin):

```
strip: aria-label "Language: English. Switch to 日本語."   text "EN"   no svg   localStorage["gadgets:locale"]="en"
frame: unchanged, English (the browser already resolved to English)
whoAmI().language → "en"          ← the OS choice is mirrored onto the account even when nothing visible changes
```

Second click:

```
strip: aria-label "Language: 日本語. Switch to system."   text "日本"   localStorage["gadgets:locale"]="ja"
employee frame: <html lang>=ja  あなたの勤怠と残業。  tabs ["今日*","今月"]
   strings: Kintai · あなたの勤怠と残業。 · 今日 · 今月 · 出勤 · 今日の打刻 · 今日はまだ打刻がありません · ← · 2026-09 · →
            · 残業時間は承認待ちの申請であり、承認されるまで支給額ではありません。 · 2026-09 には打刻がありません。
            · aria-label=前の月 · aria-label=次の月
   Latin-only strings: ["Kintai"]
admin frame:    <html lang>=ja  従業員レコード、アカウントコード、報告ラインの管理。  tabs ["要対応*","月次","名簿"]
   108 strings, 72 Japanese; every Latin-only string is DATA (see §7)
no reload: __probe10 mark intact, frame targetId unchanged, page timeOrigin unchanged (both roles)
whoAmI().language → "ja" (both accounts)          uncaught / console: 0 / 0
```

## 3. New browser context, empty `localStorage`, `en-US`, same account → strip system, Kintai 日本語 — PASS (both)

A fresh `Target.createBrowserContext`, `localStorage` holding only `authToken`:

```
strip: "Language: system (English). Switch to English."   Translate glyph   localStorage["gadgets:locale"]: null
employee frame: navigator.language en-US   <html lang>=ja   tabs ["今日*","今月"]   あなたの勤怠と残業。
admin frame:    navigator.language en-US   <html lang>=ja   tabs ["要対応*","月次","名簿"]
whoAmI().language → "ja"
```

The account carried the choice into a browser that had never seen it. This is the cross-device claim.

## 4. Click to system → row gone; Kintai back to English — PASS on the row, **FAIL on the screen** (both roles)

Back in the first browser (strip at `日本`), one click:

```
strip: "Language: system (English). Switch to English."   Translate glyph   localStorage["gadgets:locale"]="system"
whoAmI().language → null   (within ~1 s; both accounts)
employee frame, 10 s later: <html lang>=ja  tabs ["今日*","今月"]  あなたの勤怠と残業。   ← STILL 日本語
admin frame,    10 s later: <html lang>=ja  tabs ["要対応*","月次","名簿"]                  ← STILL 日本語
```

**Finding 1.** The row is deleted as specified, but the OPEN screen does not return to the browser's
language. `followHost` (`app/i18n/language-source.ts:104-105`) does `source.set(resolveLanguage(null,
saved, navigatorLanguage))` with `saved` still `"ja"` — the account "as it stood a moment ago" — and
only then `save(null)`; when the delete resolves, the entry advances `saved = null` and nothing
re-asks the source. The unit test pins exactly this: *"clears the account and falls back to it, then
the browser, when the shell says system"* (`language-source.test.ts:126-136`, `locale: null, saved:
"ja", navigatorLanguage: "en-US"` → `source.get() === "ja"`), so the code is doing what its test says.
The spec says otherwise: *"picking 'system' in the shell clears the memory and Kintai genuinely
follows the browser again — without this, 'system' would silently mean 'the last thing you picked'
for Kintai alone."* Live, for the rest of that session, it means exactly that — while `whoAmI()`
already says `null`, so what is shown and what will show on the next open disagree.

Two diagnostics show the mechanism rather than guess at it:

```
S4d — flip the THEME button once (an unrelated re-push, saved now null):
      employee frame → <html lang>=en  tabs ["Today*","This month"]   Japanese strings: []   (no reload)
      admin frame    → <html lang>=en  tabs ["Needs attention*","Monthly","Roster"]   Japanese strings: []
S4e — a new tab in the SAME context (gadgets:locale="system" kept): English, both roles
S4c — a new tab in the OTHER en-US context (the §3 browser): English, both roles — the account no longer overrides the browser
S4b — the OTHER context's already-open tab: still 日本語 (no live cross-device push; only the next open follows — as designed)
```

So the fall-back itself is right and one push late.

**FIXED** (`fix(kintai): a theme re-push is not somebody choosing a language`). A change now resolves
as `(locale, null, browser)` — the account is not consulted, because this very push is what overwrites
or deletes it, so falling back through the row would show the value being thrown away. The flipped
expectation is in `language-source.test.ts`: *"clears the account and follows the browser at once when
the shell says system"* — `{ locale: null, previousLocale: "ja", saved: "ja", nav: "en-US" }` →
`source.get() === "en"`, `save(null)`. §4d above is what the screen now does in the same instant as
the row disappears, without needing the theme button. **VERIFIED BY TEST**, not re-driven.

### 4f. A dark-mode flip on a fresh device leaves the account row intact — **VERIFIED BY TEST**

Not a scenario this pass had, and the reason the fix is more than the one line §4 asked for. `followHost`
saved on EVERY push, including one that carried the locale UNCHANGED — and the shell re-pushes the whole
theme whenever any part of it changes. On the §3 device (shell on system, account `"ja"`, `en-US`
browser) that meant a flip of the theme button ran `save(localeToLanguage(null))` and **deleted the
account row**, silently, with nobody having touched the language. Worse, no click is needed at all: the
deployment's accent colour reaches `SandboxedGatekeeperApp` from `useServerConfig()` after the first
push, so the theme is pushed a second time on a plain page open. §3 passed only because it read the row
before anything re-pushed.

A push is now read against the locale the page is already following (`previousLocale`, seeded with the
locale the FIRST PAINT used), and an unchanged one does nothing at all unless it is the retry of a
refused save. Three tests pin it — *"does nothing when a re-push carries the locale already being
followed"* (returns `null`, `save` not called, the source silent), *"retries a refused save on an
unchanged re-push, without touching the screen"*, and the `createHostFollower` sequence *"stays quiet on
an opening re-push, then follows every change the shell makes"* — plus, on the shell side,
`SandboxedGatekeeperApp.test.tsx` now asserts the receiver has been pushed **nothing** at the moment
`subscribeTheme` answers, which is the assumption the whole comparison rests on.

## 5. The same for an administrator — PASS / FAIL exactly as the employee

Run as a separate role with fresh contexts (§1–§4 above list both). Tabs `要対応 / 月次 / 名簿` ↔
`Needs attention / Monthly / Roster`; subtitle `従業員レコード、アカウントコード、報告ラインの管理。` ↔
`Employee records, account codes and reporting lines.`; `whoAmI().language` `null → en → ja → null`
in step. 108 strings on every admin screen in both languages; the admin re-rendered without a
reload (mark, targetId, timeOrigin all intact); uncaught / console errors 0 / 0 throughout.

## 6. A `ja-JP` browser on system, no account row — PASS (both)

`probe10emp` (row deleted in §4, `whoAmI().language === null` before and after) and `probe10admin`:

```
strip: aria-label "Language: system (日本語). Switch to English."   Translate glyph   localStorage["gadgets:locale"]: null
employee frame: navigator.language ja-JP ["ja-JP"]   <html lang>=ja   tabs ["今日*","今月"]   あなたの勤怠と残業。   Latin-only: ["Kintai"]
admin frame:    navigator.language ja-JP             <html lang>=ja   tabs ["要対応*","月次","名簿"]
whoAmI().language → null (both, unchanged by opening)
```

The browser decided, and opening the page wrote nothing to the account.

## 7. Sweep — PASS, nothing in the wrong language

Mechanical, every text node plus `aria-label` / `placeholder` / `title` inside the frame, on every
state above (the dumps: `strings-*.json` in the session scratchpad).

**English screens** (§1, first click of §2, §4d, §4e, §4c; both roles): Japanese strings **0** on
every one.

**日本語 screens** (§2, §3, §4 pre-re-push, §6; both roles): the employee page's only Latin-only
string is `Kintai`. The admin page's 26 Latin-only strings are all data — `Kintai`, the account id
`a30741a6-…`, `Admin · A-02`, `Admin`, `A-02 · Dev · Keiyaku`, `E-01 · Ops · Seishain`,
`Test Employee`, `E-01`, `A-02`, the five probe names and numbers (`Probe9 Worker Ja`,
`PROBE-EMP-J1 · Probe9`, … `Probe10 Admin`, `PROBE-EMP-L2 · Probe10`, and the bare numbers), and
the two format placeholders `00000000-0000-0000-0000-000000000000` / `E-1001`. (`Dev`, `Keiyaku`,
`Ops`, `Seishain` are the owner's own department / employment-type values.) Mixed strings that
embed data — `7名 · 6名は Kintai を使えません`, `利用可能 · 報告先: Admin`,
`aria-label=Admin の要確認の勤務日 1日 — 要対応を開く` — are Japanese copy around a name.

The shell's own text (`Theme: system (dark). Switch to light.`, `Open profile menu`, `Gatekeepers`)
stayed English throughout, by design; not flagged. The 2026-09-09 record's Finding 1 (the unlinked
worker's English `KINTAI_ACCOUNT_NOT_LINKED` sentence) was not re-observed because both probes were
linked before any screen was opened; it is not resolved by this branch.

## Findings

1. **"System" leaves the open screen in the language it just deleted** (§4, both roles). Row
   `null` at once; screen unchanged until the next theme push or open. The spec's "genuinely follows
   the browser again" fails for the current session; `language-source.test.ts:126` encoded the
   observed behaviour. **FIXED** in `fix(kintai): a theme re-push is not somebody choosing a
   language`; that test's expectation is flipped. See §4 and, for the larger defect behind it, §4f.
2. **`packages/gatekeeper-kintai/wrangler.dev.jsonc` is still tracked.** The gitignore rule
   `wrangler.dev.jsonc` does not untrack a file already committed, and this is the only one that is
   (`git ls-files | grep wrangler.dev.jsonc`). The dev server rewrote its `vars.BASE_URL` from
   `…:8787/…` to `…:8799/…`, which showed up as a modification and was reverted with `git checkout`.
   The brief's "nothing to revert there" is true for the other 18; a `git rm --cached` on this one
   would make it true for all. **FIXED** — `chore(kintai): untrack the generated dev wrangler
   config`. The file stays on disk, ignored, and `run-local` writes it from scratch.
3. **The first click writes to the account without changing anything visible** (§2): system → `EN`
   in an English browser saves `"en"`. Per spec (the save mirrors the OS choice), harmless, and the
   reason §3's "empty localStorage" test needs the SECOND click to mean anything.
4. **No live cross-device push, by design** (§4b): another browser's already-open tab keeps its
   language until its next open. Recorded so nobody reads §3 as more than it claims.

Not driven, recorded as untested rather than passing: a click in the `ja-JP` context (system →
English with a Japanese browser — the mirror of §2); a refused save (now `reportIssue` with nothing
on screen; jsdom-covered); a Japanese screen with real punches or pending approvals.

## State left in the owner's `.wrangler/state`

Nothing was deleted, **no punch was recorded and no period was locked.** Added: two Workshop
accounts (`probe10emp`, `probe10admin`), onboarding completed, Kintai provisioned; two `PROBE-EMP-`
employees (ids 17–18, department `Probe10`, joined `2026-09-01`) with account links.
`account_preferences`: **no row for either** — each went `en → ja → deleted` (twice for the
employee: the first run of the driver aborted at §4 and was rerun from a clean `null`). No org
edges, no approvers, no submissions.

Reverted before committing: `config.vars.ADMINS` back to `["admin"]`; the tracked
`packages/gatekeeper-kintai/wrangler.dev.jsonc` (finding 2). The 18 generated, ignored
`wrangler.dev.jsonc` and the untracked bundles under `src/generated/` were left as the dev server
wrote them — they are not in the tree. Dev server stopped (SIGINT to `run-local`, exit 130; 8799
free; the owner's 8787 was never in use), headless Chrome killed, `pgrep -fl "vite.js build.*--watch"`
empty, `git status` clean.

---

## Task 4 checkboxes

- [x] **(1)** Translate button beside the theme button; `Language: system (English). Switch to English.`; Kintai English (§1).
- [x] **(2)** `EN` → `日本`; 日本語 without reload; `whoAmI().language === "ja"`; `gadgets:locale === "ja"` (§2).
- [x] **(3)** Fresh `en-US` context, empty `localStorage` → strip system, Kintai 日本語 (§3).
- [x] **(4)** Click to system → `whoAmI().language === null` — **the open screen did not follow** (§4, finding 1); fixed after the pass, VERIFIED BY TEST (§4, §4f).
- [x] **(5)** Admin and employee both (§5).
- [x] **(6)** `ja-JP` on system: `Language: system (日本語). Switch to English.`, Kintai 日本語, no row (§6).
- [x] **(7)** Sweep: no English copy under 日本語, no Japanese under English; the shell stays English (§7).

---

## Re-run after the fix wave (2026-09-10)

**Code driven:** `feat/os-language-switcher` at `f808b33` (the fix `08ff49b` plus the two commits
above it, none touching Kintai's app code). Same rig as the pass above, reused file-for-file: own
stack `pnpm run-local --port 8799`, headless **Chrome 152.0.7977.83** over CDP, one
`Target.createBrowserContext` per "device" with `acceptLanguage` + `setLocaleOverride` applied to the
page session and the srcdoc frame's session before its scripts run, the strip clicked with
`Input.dispatchMouseEvent`, every saved-language read `getGatekeeperApp("kintai").ui.whoAmI().language`
over real Cap'n Web from Node 24.15.0. The bundles the dev server served were pinned before the first
tab opened: the `iframeHtml` for `probe10emp` (898,487 chars) and `probe10admin` (951,005) both contain
`previousLocale` and `createHostFollower` and neither contains the old test's phrase *"falls back to it,
then the browser"* — the post-fix code, unminified. `probe10admin` was put back into
`config.vars.ADMINS` for the admin bundle and **reverted** before committing. Both probes started with
`whoAmI().language === null` (no `account_preferences` row), and both were left that way.

Latencies below are measured from the moment the CDP `mouseReleased` dispatch returned to the first
poll that saw the new state — the frame polled every 40 ms, `whoAmI()` re-read every ~100 ms (each
read opens its own RPC session) — so they are upper bounds. "No reload" is the same three-way proof:
a `window.__probe10` mark set inside the frame just before the click, the frame's CDP `targetId`,
and the shell page's `performance.timeOrigin`, all compared after.

### §4 — click to system → English at once, row null — **PASS** (both roles)

`en-US` context, `localStorage` `["authToken"]` on open; strip driven system → `EN` → `日本`
(`whoAmI().language` `"en"` then `"ja"`, as in §2). Then one click:

```
employee: strip "Language: system (English). Switch to English."  localStorage["gadgets:locale"]="system"
          frame → <html lang>=en  tabs ["Today*","This month"]  Your attendance and overtime.     after   3 ms
          whoAmI().language → null                                                                 after  37 ms
          mark "mark-before-§4-…" intact · frame targetId 147859AE… unchanged · page timeOrigin unchanged
          Japanese strings on the English screen: []     uncaught / console: 0 / 0
admin:    strip as above, localStorage "system"
          frame → <html lang>=en  tabs ["Needs attention*","Monthly","Roster"]  Employee records, …    after   4 ms
          whoAmI().language → null                                                                 after  33 ms
          mark intact · targetId 9741891B… unchanged · timeOrigin unchanged · Japanese strings: [] · 0 / 0
```

Finding 1 of the first pass is gone: the frame switched in the same push that deleted the row, with
no theme flip and no reopen. (The first pass saw the frame still 日本語 10 s later.)

### §4f — a fresh device, theme re-pushes, the row survives — **PASS** (both roles)

Row set to `"ja"` again in the first context (system → `EN` → `日本`, `whoAmI()` `"en"` → `"ja"`) and
left there. A **new** `en-US` context, `localStorage` `["authToken"]`, same account. First paint (frame
tabs present) 321 ms after `Page.navigate`, both roles:

```
employee: strip "Language: system (English). Switch to English."  Translate glyph  localStorage["gadgets:locale"]: null
          frame: navigator.language en-US  <html lang>=ja  tabs ["今日*","今月"]  あなたの勤怠と残業。  data-mode=dark
          whoAmI().language right after first paint → "ja"
          5,055 ms after first paint: whoAmI().language → "ja"   tabs still ["今日*","今月"]  <html lang>=ja
          theme flip 1: "Theme: system (dark). Switch to light." → "Theme: light. Switch to dark."
                        frame data-mode dark → light (the push reached the frame)
                        frame <html lang>=ja  tabs ["今日*","今月"]   whoAmI().language → "ja"   localStorage["gadgets:locale"]: null
          theme flip 2: "Theme: light. Switch to dark." → "Theme: dark. Switch to system."
                        frame data-mode light → dark
                        frame <html lang>=ja  tabs ["今日*","今月"]   whoAmI().language → "ja"   localStorage["gadgets:locale"]: null
          no reload through both flips (mark, targetId 4465642A…, timeOrigin)   uncaught / console: 0 / 0
admin:    strip as above, localStorage null
          frame: en-US  <html lang>=ja  tabs ["要対応*","月次","名簿"]  従業員レコード、アカウントコード、報告ラインの管理。
          right after first paint → "ja";  5,083 ms after first paint → "ja", tabs still Japanese
          flip 1: dark → light, tabs ["要対応*","月次","名簿"], whoAmI().language "ja"
          flip 2: light → dark, tabs ["要対応*","月次","名簿"], whoAmI().language "ja"
          no reload (targetId 97BBEAC9…)   uncaught / console: 0 / 0
```

Neither the late accent-colour push on open nor two theme re-pushes touched the account row; the
screen stayed 日本語 through all of them while the strip kept saying `system (English)`.

### §4g — from that device, the language button to system → English at once, row null — **PASS** (both roles)

**Rig error first, recorded as driven.** The first driver clicked the button once on the §4f device
and expected system. But on that device the strip is *already* on system (`localStorage["gadgets:locale"]`
null; it is the account, not the browser, that is showing 日本語), so the three-state cycle's one
click went system → **`EN`**:

```
employee: strip "Language: English. Switch to 日本語."  text "EN"  localStorage["gadgets:locale"]="en"
          frame → English after 7 ms (no reload)   whoAmI().language → "en"  (the driver's poll for null timed out at 10 s)
admin:    same — frame → English after 9 ms, whoAmI().language → "en"
```

That is the correct behaviour of the control (the OS choice `EN`, mirrored onto the account) and not
what the scenario asks. Both rows were left `"en"` by it. The §4f state was rebuilt (row to `"ja"` in
a throwaway `en-US` context; a new `en-US` context with `localStorage` `["authToken"]` → strip
system, frame 日本語, `whoAmI().language` `"ja"`) and the button cycled to system, every click timed:

```
employee: click 1 system → EN:   strip "Language: English. Switch to 日本語."  localStorage "en"     frame English  6 ms   row "en"  34 ms
          click 2 EN → 日本:      strip "Language: 日本語. Switch to system."   localStorage "ja"     frame 日本語   28 ms   row "ja"  72 ms
          click 3 日本 → system:  strip "Language: system (English). Switch to English."  localStorage "system"
                                  frame → <html lang>=en  tabs ["Today*","This month"]                 after  9 ms
                                  whoAmI().language → null                                              after 59 ms
                                  mark "mark-before-§4g click 3 …" intact · targetId unchanged · timeOrigin unchanged
                                  Japanese strings on the English screen: []   uncaught / console: 0 / 0
admin:    click 1 system → EN:   frame English  8 ms   row "en"  35 ms
          click 2 EN → 日本:      frame 日本語   34 ms   row "ja"  74 ms
          click 3 日本 → system:  strip "Language: system (English). Switch to English."  localStorage "system"
                                  frame → <html lang>=en  tabs ["Needs attention*","Monthly","Roster"]  after 15 ms
                                  whoAmI().language → null                                              after 59 ms
                                  mark intact · targetId unchanged · timeOrigin unchanged · Japanese strings: [] · 0 / 0
```

Every click switched the frame in the same push it wrote the row, in the browser's language the
moment the row was deleted. The first context's tab, left on `日本` throughout, still showed 日本語
when the other device's row went null — §4b's "no live cross-device push", unchanged.

### Observations (none is a defect)

1. **The §4g rig error is worth keeping** as a description of the control: on a device that has never
   picked a language, the strip reads `system (English)` while Kintai, following the account, shows
   日本語 — and the one-click route from there is to `EN`, not to "system", because system is what is
   already selected. Making Kintai forget the account from such a device takes the full cycle
   (`EN` → `日本` → system), writing `"en"` and `"ja"` on the way. This is the three-state control the
   spec chose; recorded so the next reader does not mistake the `EN` click for a failure to reach system.
2. **Latencies.** Frame switch 3–34 ms after the click (the 日本 direction is the slower one, ~20–35 ms;
   it re-renders more text), row write/delete 33–74 ms, on every one of the fourteen timed clicks. The
   first pass's "within ~1 s" for the row was the poll interval, not the write.
3. **The frame's `data-mode` flipped with each theme click**, so the re-pushes in §4f demonstrably
   reached the frame that kept its language — the comparison the fix relies on was exercised, not
   assumed.

### State left in the owner's `.wrangler/state`

File list snapshotted before the stack started and after it stopped: **347 files both times, none
added, none removed.** The only Kintai file that changed is the `KintaiStore` SQLite (same size,
159,744 bytes; the row writes `en` → `ja` → deleted, twice per account in the first run and once more
in the second, plus the reads). No new Workshop account, no employee, no punch, no period, no link:
the two `UserDurableObject` SQLites touched are the probes' own (same sizes). `account_preferences`:
**no row for either probe** — `whoAmI().language === null` for `probe10emp` and `probe10admin` at the
end, read after the last tab closed. Everything else in the delta is `metadata.sqlite-shm` mtimes
(unchanged 32,768 bytes) and Miniflare's observability trace store growing 54.7 → 61.3 MB, which it
does on every run. `E-01` / `A-02` appear in the admin's 108 strings as data, read only.

Reverted before committing: `config.vars.ADMINS` back to `["admin"]`. `git status` clean apart from
this record; the generated `wrangler.dev.jsonc` files and the bundles under `src/generated/` are
ignored and were left as the dev server wrote them. Dev server stopped (SIGINT to `run-local`, gone
in 2 s; 8799 free; the owner's 8787 was not in use before, during or after), headless Chrome exited
with the driver, `pgrep -fl "vite.js build.*--watch"` empty, no `workerd` left.
