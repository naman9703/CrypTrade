/**
 * Schedule work immediately after the current browser event / React handler returns.
 * Async `onChange` / `onClick` handlers keep the task open until `await` completes, which
 * makes Chrome report "[Violation] 'change' handler took …ms" for network + server time.
 */
export function deferTask(fn: () => void): void {
  queueMicrotask(fn);
}
