import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };

type State = { error: Error | null; resetKey: number };

/** Prevents lightweight-charts / data glitches from unmounting the whole app. */
export class ChartErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("ChartErrorBoundary", error?.message, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col gap-3 p-4">
          <div className="rounded-lg border border-amber-300/70 bg-amber-50/95 px-3 py-2 text-sm text-amber-950 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100/90">
            Chart paused after an error (usually bad market data or a chart library glitch).{" "}
            <span className="text-amber-800 dark:text-amber-200/80">{this.state.error.message}</span>
          </div>
          <button
            type="button"
            className="w-fit rounded-md border border-slate-300 bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            onClick={() => this.setState({ error: null, resetKey: this.state.resetKey + 1 })}
          >
            Reload chart
          </button>
        </div>
      );
    }
    return <div key={this.state.resetKey}>{this.props.children}</div>;
  }
}
