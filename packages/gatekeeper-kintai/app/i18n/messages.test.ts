import { describe, expect, it } from "vitest";
import { en, ja, resolveLanguage, type Messages } from "./messages";

/**
 * The two dictionaries, walked side by side.
 *
 * `ja satisfies Messages` already fails the BUILD on a missing key, which is the guard that
 * matters; this walk costs nothing and catches the two things `satisfies` lets through. A key
 * declared `string` in `en` and written as a function in `ja` is one (the wider structural check
 * passes as long as the function is assignable nowhere — it is not, but the walk says so in one
 * line rather than in a type error nobody reads). A function of the WRONG ARITY is the other, and
 * it is the real one: `(n: number) => string` and `() => string` are mutually assignable in
 * TypeScript, so a Japanese entry that quietly drops its parameter type-checks clean and then
 * renders a sentence with the number missing from it.
 */
function walk(
  path: string,
  english: unknown,
  japanese: unknown,
  report: (line: string) => void,
): void {
  if (typeof english !== typeof japanese) {
    report(`${path}: en is ${typeof english}, ja is ${typeof japanese}`);
    return;
  }
  if (typeof english === "function" && typeof japanese === "function") {
    if (english.length !== japanese.length) {
      report(`${path}: en takes ${english.length} argument(s), ja takes ${japanese.length}`);
    }
    return;
  }
  if (typeof english === "object" && english !== null && japanese !== null) {
    const left = Object.keys(english as object).sort();
    const right = Object.keys(japanese as object).sort();
    if (left.join() !== right.join()) {
      report(`${path}: en has [${left.join(", ")}], ja has [${right.join(", ")}]`);
      return;
    }
    for (const key of left) {
      walk(
        path === "" ? key : `${path}.${key}`,
        (english as Record<string, unknown>)[key],
        (japanese as Record<string, unknown>)[key],
        report,
      );
    }
    return;
  }
  if (typeof english === "string" && (english as string).trim() === "") {
    report(`${path}: en is empty`);
  }
  if (typeof japanese === "string" && (japanese as string).trim() === "") {
    report(`${path}: ja is empty`);
  }
}

describe("the dictionary", () => {
  it("has the same shape in both languages, function arities included", () => {
    const problems: string[] = [];
    walk("", en, ja, (line) => problems.push(line));
    expect(problems).toEqual([]);
  });

  // `Messages` is `typeof en`, so this is the compile-time half of the same promise, asserted at
  // runtime too: a reader holding `Messages` is holding whichever of the two the language chose.
  it("types both objects as Messages", () => {
    const dictionaries: Messages[] = [en, ja];
    expect(dictionaries).toHaveLength(2);
  });

  /*
   * The formats the design pins by example, and the reason they are pinned: a duration and an age
   * are the two pieces of copy on these screens that are ARITHMETIC as well as words, so a
   * translation that drops a unit or rounds the wrong way is wrong in a way no reviewer sees.
   */
  describe("durations", () => {
    it("writes a full duration with both units in either language", () => {
      expect(en.labels.durations.full(8 * 60 + 15)).toBe("8h 15m");
      expect(ja.labels.durations.full(8 * 60 + 15)).toBe("8時間15分");
      expect(en.labels.durations.full(162 * 60 + 30)).toBe("162h 30m");
      expect(en.labels.durations.full(60)).toBe("1h 0m");
      expect(ja.labels.durations.full(60)).toBe("1時間0分");
    });

    // The other formatter drops the empty half, because it labels one request inside a sentence
    // rather than filling a column a reader runs their eye down.
    it("writes a short duration without the empty half", () => {
      expect(en.labels.durations.short(150)).toBe("2h 30m");
      expect(en.labels.durations.short(45)).toBe("45m");
      expect(en.labels.durations.short(180)).toBe("3h");
      expect(ja.labels.durations.short(150)).toBe("2時間30分");
      expect(ja.labels.durations.short(45)).toBe("45分");
      expect(ja.labels.durations.short(180)).toBe("3時間");
    });
  });

  describe("ages", () => {
    const HOUR = 60 * 60 * 1000;

    it("buckets a wait the same way in both languages", () => {
      expect(en.labels.ages.waiting(0)).toBe("< 1h");
      expect(en.labels.ages.waiting(3 * HOUR)).toBe("3h");
      expect(en.labels.ages.waiting(2 * 24 * HOUR)).toBe("2d");
      expect(ja.labels.ages.waiting(0)).toBe("1時間未満");
      expect(ja.labels.ages.waiting(3 * HOUR)).toBe("3時間");
      expect(ja.labels.ages.waiting(2 * 24 * HOUR)).toBe("2日");
    });

    // Truncated, never rounded: a row must not claim to be older than it is. And clamped at zero,
    // because a clock that moved backwards between the write and the read would otherwise render
    // "-1h" — a bug in the queue, to a reader, rather than in a clock.
    it("truncates rather than rounding, and never goes negative", () => {
      expect(en.labels.ages.waiting(23.9 * HOUR)).toBe("23h");
      expect(en.labels.ages.waiting(47 * HOUR)).toBe("1d");
      expect(en.labels.ages.waiting(-HOUR)).toBe("< 1h");
      expect(ja.labels.ages.waiting(-HOUR)).toBe("1時間未満");
    });
  });

  // A language's own name is never translated: a reader looking for their language finds the word
  // they would write it with, whichever screen they are on.
  it("names each language in that language, identically in both dictionaries", () => {
    expect(en.labels.languageNames).toEqual({ en: "English", ja: "日本語" });
    expect(ja.labels.languageNames).toEqual(en.labels.languageNames);
  });
});

/**
 * Which language a screen opens in.
 *
 * The Workshop exposes no locale to a gatekeeper app (`startAppUi` receives `{ isAdmin }`), and
 * the sandboxed iframe has no storage, so these two inputs are all there is: the choice saved
 * server-side against the account, and the browser's own language. A saved choice always wins —
 * it is the only thing in the system that records what this person actually asked for.
 */
describe("resolveLanguage", () => {
  it("follows the browser when nothing has been chosen", () => {
    expect(resolveLanguage(null, "ja-JP")).toBe("ja");
    expect(resolveLanguage(null, "en-GB")).toBe("en");
    expect(resolveLanguage(null, undefined)).toBe("en");
  });

  it("prefers the saved choice over the browser", () => {
    expect(resolveLanguage("en", "ja-JP")).toBe("en");
    expect(resolveLanguage("ja", "en")).toBe("ja");
  });

  // `ja` alone, `ja-JP`, `JA-jp`: the prefix decides, case-insensitively. Anything else is
  // English, because English is the fallback and not a match — a language this dictionary has no
  // words for must not resolve to itself.
  it("reads any ja tag as Japanese and everything else as English", () => {
    expect(resolveLanguage(null, "ja")).toBe("ja");
    expect(resolveLanguage(null, "JA-JP")).toBe("ja");
    expect(resolveLanguage(null, "fr-FR")).toBe("en");
    expect(resolveLanguage(null, "")).toBe("en");
  });
});
