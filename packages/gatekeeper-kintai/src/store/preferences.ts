import type { UiLanguage } from "../types.js";

/**
 * The caller's own saved UI language, or `null` if they have never chosen one.
 *
 * Keyed on `accountId`, not on an employee id — see `account_preferences`'s comment in
 * `schema.ts` for why. `null` is a real, distinct answer (never chosen), not the absence of a
 * row read as a default: `identify()` passes it straight onto `KintaiIdentity.language`, and the
 * page is what decides what an unset preference means.
 */
export function languageFor(sql: SqlStorage, accountId: string): UiLanguage | null {
  const row = sql
    .exec<{ language: UiLanguage }>(
      `SELECT language FROM account_preferences WHERE account_id = ?`, accountId,
    )
    .toArray()[0];
  return row?.language ?? null;
}

/**
 * Record the caller's UI language, replacing any previous choice for this account — or, given
 * `null`, forget it entirely.
 *
 * `INSERT ... ON CONFLICT DO UPDATE` rather than a `languageFor` read followed by an `INSERT` or
 * `UPDATE`, because there is nothing to branch on: this table has exactly one row per account and
 * the write is the same whether that row already exists.
 *
 * `null` DELETEs the row instead of writing one, rather than storing a NULL `language` column: the
 * OS's own choice is `AppLocale | null`, sent as `theme.locale`, and null there means "system" —
 * the shell wants the app to decide for itself, from ITS OWN memory (a saved account preference)
 * and then the browser. If null just overwrote the row with a NULL language, "system" would
 * silently pin "keep whatever this account last chose" instead of genuinely un-remembering, and
 * Kintai's account save would never let the browser's own language take over again. `DELETE` makes
 * `languageFor` fall back to its `null` "never chosen" answer, exactly as if this account had never
 * called `setLanguage` at all — which is the honest description of what "system" asked for. A
 * `null` on an account with no row is a no-op: the `DELETE` matches nothing and still succeeds.
 *
 * `language` is not re-validated here. It is `UiLanguage | null`, a string-literal union plus
 * `null`, and `@validateRpc()` on `setLanguage` refuses anything outside it before this ever runs —
 * the same reason `setWorkDatePolicy` does not re-check its own literal union. `account_preferences`'s
 * foreign key onto `ui_languages(code)` is the backstop behind the non-null half, not a second
 * opinion here.
 *
 * No audit entry, unlike the mutating admin methods in this package — see the doc comment on
 * `account_preferences` in `schema.ts`: this is a personal display preference, not an
 * administrative act. That is true of forgetting it too.
 */
export function setLanguage(
  sql: SqlStorage, accountId: string, language: UiLanguage | null, now: number,
): void {
  if (language === null) {
    sql.exec(`DELETE FROM account_preferences WHERE account_id = ?`, accountId);
    return;
  }
  sql.exec(
    `INSERT INTO account_preferences (account_id, language, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET language = excluded.language,
       updated_at = excluded.updated_at`,
    accountId, language, now,
  );
}
