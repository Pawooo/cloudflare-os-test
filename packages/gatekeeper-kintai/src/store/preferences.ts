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
 * Record the caller's UI language, replacing any previous choice for this account.
 *
 * `INSERT ... ON CONFLICT DO UPDATE` rather than a `languageFor` read followed by an `INSERT` or
 * `UPDATE`, because there is nothing to branch on: this table has exactly one row per account and
 * the write is the same whether that row already exists.
 *
 * `language` is not re-validated here. It is `UiLanguage`, a string-literal union, and
 * `@validateRpc()` on `setLanguage` refuses anything outside it before this ever runs — the same
 * reason `setWorkDatePolicy` does not re-check its own literal union. `account_preferences`'s
 * foreign key onto `ui_languages(code)` is the backstop behind that, not a second opinion here.
 *
 * No audit entry, unlike the mutating admin methods in this package — see the doc comment on
 * `account_preferences` in `schema.ts`: this is a personal display preference, not an
 * administrative act.
 */
export function setLanguage(
  sql: SqlStorage, accountId: string, language: UiLanguage, now: number,
): void {
  sql.exec(
    `INSERT INTO account_preferences (account_id, language, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET language = excluded.language,
       updated_at = excluded.updated_at`,
    accountId, language, now,
  );
}
