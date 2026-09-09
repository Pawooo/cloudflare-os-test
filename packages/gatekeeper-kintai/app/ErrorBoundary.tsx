import { Component, type ReactNode } from "react";
import { reportIssue } from "./error-reporting";

/**
 * The two words the crash screen says.
 *
 * Given by the entry rather than read from the dictionary here, because this is a class component:
 * it cannot call `useT()`, and a hook is the only way into the language context. Both entries mount
 * a `<LanguageProvider>` above this boundary and pass them down through a one-line
 * `TranslatedBoundary` wrapper that reads `useT()` on the provider's side of it — see `main.tsx`
 * and `employee-main.tsx`.
 *
 * REQUIRED, with no English default behind it. There was one, for exactly as long as the admin
 * entry had no provider: a fallback screen that threw looking for a language context would replace
 * a caught render error with an uncaught one, the one failure mode a boundary must not have. Now
 * that every call site has a language to give, a default would only be a way for a screen to end
 * up in the wrong one silently — so the prop carries the words and the type insists on them.
 */
type CrashLabels = { crashed: string; reload: string };

export default class ErrorBoundary extends Component<
  { children: ReactNode; labels: CrashLabels },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: Error) {
    reportIssue("kintai.react-render", error, {
      handled: false,
      severity: "fatal",
      captureMechanism: "react",
    });
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    const { labels } = this.props;
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-lg font-semibold">{labels.crashed}</h1>
        <button
          type="button"
          className="rounded-md border px-3 py-2"
          onClick={() => location.reload()}
        >
          {labels.reload}
        </button>
      </main>
    );
  }
}
