import { describe, expect, it } from "vitest";
import { APP_LOCALES } from "@gadgets/workshop-shared/theme";
import { UI_LANGUAGES } from "../src/types.js";

// `src/types.ts` is a zero-import leaf (see its own comment on why) and so cannot import
// `APP_LOCALES` itself -- this test is the drift guard in its place. `UI_LANGUAGES` is the set the
// shell's `locale` can ever carry into Kintai (`AppLocale`, via `theme.locale`) AND the set
// `setLanguage` on both facets accepts and `account_preferences.language`'s foreign key seeds from.
// If the shell ever adds a third language and this package does not, `theme.locale` could carry a
// value `setLanguage` refuses -- the OS's own choice, rejected by the app it is choosing for. This
// is a worker test, not an app test, because it is `UI_LANGUAGES` (the worker's own leaf) being
// pinned against the shell's list, not anything `app/` renders.
describe("UI_LANGUAGES vs APP_LOCALES", () => {
  it("cannot drift from the shell's list of languages", () => {
    expect(UI_LANGUAGES).toEqual(APP_LOCALES);
  });
});
