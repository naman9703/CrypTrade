import { useEffect, useRef, useState } from "react";

/**
 * Keeps numeric display stable while WS / staged draft / in-flight guards race.
 * Pending value wins until the server bot matches the user intent.
 */
export function useGuardedNumber(serverValue: number, epsilon = 1e-9) {
  const [pending, setPending] = useState<number | null>(null);
  const pendingRef = useRef<number | null>(null);

  useEffect(() => {
    if (pendingRef.current !== null && Math.abs(serverValue - pendingRef.current) <= epsilon) {
      pendingRef.current = null;
      setPending(null);
    }
  }, [serverValue, epsilon]);

  const value = pending ?? serverValue;

  const setValue = (next: number) => {
    pendingRef.current = next;
    setPending(next);
  };

  return [value, setValue] as const;
}
