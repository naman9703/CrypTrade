import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("app_render_error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 px-4 text-slate-800 dark:bg-slate-950 dark:text-slate-100">
          <h1 className="text-lg font-semibold">The app hit a rendering error</h1>
          <p className="max-w-lg text-center text-sm text-slate-600 dark:text-slate-400">
            This is usually a bug in the UI layer. You can reload the page. If it keeps happening after login, check the browser
            console for details.
          </p>
          <pre className="max-h-40 max-w-full overflow-auto rounded-lg border border-slate-200 bg-white p-3 text-xs dark:border-slate-700 dark:bg-slate-900">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
