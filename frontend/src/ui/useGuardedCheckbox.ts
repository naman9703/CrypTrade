import { useEffect, useRef, useState } from "react";

/**
 * Keeps checkbox state stable while `/api/bot/config` + WS `state` race.
 * Pending value wins until server bot matches the user intent.
 */
export function useGuardedCheckbox(serverChecked: boolean) {
  const [pending, setPending] = useState<boolean | null>(null);
  const pendingRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (pendingRef.current !== null && serverChecked === pendingRef.current) {
      pendingRef.current = null;
      setPending(null);
    }
  }, [serverChecked]);

  const checked = pending ?? serverChecked;

  const setChecked = (next: boolean) => {
    pendingRef.current = next;
    setPending(next);
  };

  return [checked, setChecked] as const;
}
