import { describe, expect, it } from "vitest";

/*
 * THE MECHANICAL GUARD THAT NO LABEL ESCAPED THE DICTIONARY.
 *
 * Every word either screen says lives in `messages.ts`, in both languages, and call sites reach it
 * as `t.<group>.<key>`. Nothing enforces that for English — an English literal in a component is
 * indistinguishable from an identifier to any scan, and the review carries it — but Japanese is a
 * different script, so a Japanese literal ANYWHERE outside the dictionary is provably a label that
 * did not make the move: it would render in Japanese to an English reader. This test reads the
 * source and says so, by `file:line`.
 *
 * WHICH FILES. Every `.ts`/`.tsx` under `app/`, with exactly two exemptions: the tests (they assert
 * Japanese copy on purpose) and `messages.ts` (the one file whose job is to hold it). NOT exempt:
 * the rest of `app/i18n/` — `LanguageToggle.tsx` and `index.tsx` are components like any other, and
 * a literal there would evade every other sweep precisely because a reader assumes that directory
 * is where the Japanese is supposed to be.
 *
 * WHAT IS STRIPPED FIRST. Comments — `//`, `/* *​/`, and the JSX `{/* *​/}` form, which is the same
 * block comment between braces — because the source is full of Japanese in prose ("要対応's third
 * section renders…") that is documentation and not copy. The strip is string-aware: a `//` inside a
 * string literal is not a comment, and a `"確認"` after one is still a finding. Newlines are kept
 * where the comments were so the line numbers reported are the file's own.
 *
 * WHY THE SCANNER TESTS ITSELF. A guard that passes on an empty match set proves nothing unless it
 * is also shown to fail on a positive: the last two cases below hand `stripComments` and `scan`
 * synthetic sources and assert the Japanese IS found where it is a literal and is NOT where it is a
 * comment. If either of those breaks, the green sweep above is meaningless, and the suite says so.
 */

/** Hiragana, katakana, CJK ideographs, halfwidth katakana — the same class `AdminPage.test.tsx` sweeps with. */
const JAPANESE = /[぀-ゟ゠-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;

const ONLY_LEGITIMATE_HOME = "i18n/messages.ts";

/**
 * Every `app/**` source this guard reads, as `{ "path/from/app": source }`: `.ts`/`.tsx`, not a
 * test, not the dictionary.
 *
 * `import.meta.glob` with `?raw` rather than `node:fs`: this file is type-checked with the rest of
 * `app/` under `tsconfig.app.json`, whose types are the browser's plus `vite/client`, and `app/` is
 * deliberately not given Node's — a `process` or `Buffer` reaching a component would then type-check
 * and fail in the iframe. Vite resolves the glob relative to this file and hands over the text of
 * each match, which is all the scan needs, and Vitest runs it through the same transform.
 */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>(
      // Literals, because Vite resolves this at transform time; the last one is
      // `ONLY_LEGITIMATE_HOME`, and the first case below asserts the two agree.
      ["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../i18n/messages.ts"],
      { query: "?raw", import: "default", eager: true },
    ),
  // Vite keys a sibling as `./X` and a parent as `../X`; both become paths from `app/`.
  ).map(([path, source]) => [path.replace(/^\.\.\//, "").replace(/^\.\//, "i18n/"), source]),
);

function sourceFiles(): string[] {
  return Object.keys(SOURCES).sort();
}

/**
 * The source with every comment blanked to spaces (newlines kept), leaving strings intact.
 *
 * A small state machine rather than a regex: `"//"` inside a string is text, `'/*'` inside a
 * template is text, and a regex-only approach gets one or the other wrong. Template literals track
 * `${ … }` so a comment inside an interpolation is still stripped and a `}` inside a nested string
 * does not end the interpolation early. Single- and double-quoted strings end at a newline too —
 * they cannot legally span one, so an apostrophe in JSX text (`Couldn't`) can mislead this scanner
 * for at most the rest of its own line rather than the rest of the file.
 */
export function stripComments(source: string): string {
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  const out: string[] = [];
  const stack: Mode[] = ["code"];
  // Brace depth inside each open `${ … }`, innermost last, so a `}` closes the interpolation only
  // when it is the one that matches the `${`.
  const interpolationDepth: number[] = [];
  const mode = () => stack[stack.length - 1];

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    switch (mode()) {
      case "line":
        if (c === "\n") {
          stack.pop();
          out.push("\n");
        } else {
          out.push(" ");
        }
        i += 1;
        break;
      case "block":
        if (c === "*" && next === "/") {
          stack.pop();
          out.push("  ");
          i += 2;
        } else {
          out.push(c === "\n" ? "\n" : " ");
          i += 1;
        }
        break;
      case "single":
      case "double": {
        const quote = mode() === "single" ? "'" : '"';
        if (c === "\\" && next !== undefined) {
          out.push(c, next);
          i += 2;
        } else {
          if (c === quote || c === "\n") stack.pop();
          out.push(c);
          i += 1;
        }
        break;
      }
      case "template":
        if (c === "\\" && next !== undefined) {
          out.push(c, next);
          i += 2;
        } else if (c === "`") {
          stack.pop();
          out.push(c);
          i += 1;
        } else if (c === "$" && next === "{") {
          stack.push("code");
          interpolationDepth.push(0);
          out.push(c, next);
          i += 2;
        } else {
          out.push(c);
          i += 1;
        }
        break;
      case "code":
        if (c === "/" && next === "/") {
          stack.push("line");
          out.push("  ");
          i += 2;
        } else if (c === "/" && next === "*") {
          stack.push("block");
          out.push("  ");
          i += 2;
        } else if (c === "'" || c === '"' || c === "`") {
          stack.push(c === "'" ? "single" : c === '"' ? "double" : "template");
          out.push(c);
          i += 1;
        } else if (interpolationDepth.length > 0 && stack.length >= 2 && stack[stack.length - 2] === "template") {
          // Code inside a `${ … }`: count braces so the closing one returns to the template.
          const depth = interpolationDepth.length - 1;
          if (c === "{") interpolationDepth[depth] += 1;
          if (c === "}") {
            if (interpolationDepth[depth] === 0) {
              stack.pop();
              interpolationDepth.pop();
            } else {
              interpolationDepth[depth] -= 1;
            }
          }
          out.push(c);
          i += 1;
        } else {
          out.push(c);
          i += 1;
        }
        break;
    }
  }
  return out.join("");
}

/** The 1-based lines of `source` that still carry Japanese once the comments are gone. */
export function scan(source: string): number[] {
  const lines = stripComments(source).split("\n");
  const hits: number[] = [];
  lines.forEach((line, index) => {
    if (JAPANESE.test(line)) hits.push(index + 1);
  });
  return hits;
}

describe("no stray Japanese literals outside the dictionary", () => {
  it("reads the whole of app/, not a hand-picked list", () => {
    const files = sourceFiles();
    // The screens, the entries, and — deliberately — the i18n module's own components.
    for (const expected of [
      "AdminPage.tsx", "EmployeePage.tsx", "main.tsx", "employee-main.tsx",
      "i18n/LanguageToggle.tsx", "i18n/index.tsx",
    ]) {
      expect(files).toContain(expected);
    }
    expect(files).not.toContain(ONLY_LEGITIMATE_HOME);
    expect(files.some((file) => /\.test\.tsx?$/.test(file))).toBe(false);
  });

  it("finds no Japanese in any source file outside messages.ts (comments excluded)", () => {
    const findings: string[] = [];
    for (const file of sourceFiles()) {
      for (const line of scan(SOURCES[file])) {
        findings.push(`${file}:${line}`);
      }
    }
    // Listed by `file:line` so a failure points at the label that missed the move — which is fixed
    // in that file, by adding the key to BOTH dictionaries, never by exempting the file here.
    expect(findings, `Japanese outside the dictionary:\n  ${findings.join("\n  ")}`).toEqual([]);
  });

  // The positive: the scanner MUST flag a literal, or the green sweep above is vacuous.
  it("flags a Japanese string literal, by line", () => {
    const source = [
      'const a = "fine";',
      'const b = "確認";',
      "const c = `${a} 確認`;",
      "const d = <p>確認</p>;",
    ].join("\n");
    expect(scan(source)).toEqual([2, 3, 4]);
  });

  // And the negative: prose in comments is documentation, not copy, in every comment form the
  // source uses — and a `//` inside a string does not hide the literal after it.
  it("ignores comments in every form, but is not fooled by one inside a string", () => {
    const source = [
      "// 要対応 is the default tab",
      "/* 月次's close, two-step */",
      "const x = 1; // 確認",
      "return <p>{/* 労働基準法41条 */}ok</p>;",
      "/*",
      " * 管理監督者",
      " */",
      'const url = "http://example.test/確認"; // not a comment: the // is inside the string',
      'const y = `template ${"//"} 確認`;',
    ].join("\n");
    expect(scan(source)).toEqual([8, 9]);
    expect(stripComments(source)).not.toContain("要対応");
    expect(stripComments(source)).toContain("http://example.test/確認");
  });
});
