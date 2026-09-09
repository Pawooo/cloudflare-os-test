import { Component, type ReactNode } from "react";
import { reportIssue } from "./error-reporting";

/**
 * The two words the crash screen says.
 *
 * Given by the entry rather than read from the dictionary here, because this is a class component:
 * it cannot call `useT()`, and a hook is the only way into the language context. The entry that
 * mounts a `<LanguageProvider>` above this boundary passes them (see `employee-main.tsx`, where a
 * one-line wrapper reads `useT()` on the provider's side of the boundary and hands them down); an
 * entry with no provider yet passes nothing and gets the English default.
 *
 * The default is what keeps this component safe to mount outside a provider. A fallback screen that
 * threw because it could not find a language context would replace a caught render error with an
 * uncaught one — the one failure mode a boundary must not have.
 */
type CrashLabels = { crashed: string; reload: string };

const DEFAULT_LABELS: CrashLabels = { crashed: "Something went wrong", reload: "Reload" };

export default class ErrorBoundary extends Component<
  { children: ReactNode; labels?: CrashLabels },
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
    const labels = this.props.labels ?? DEFAULT_LABELS;
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
