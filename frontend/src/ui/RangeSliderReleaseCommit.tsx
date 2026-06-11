import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export type RangeSliderReleaseCommitHandle = {
  /** Commit the current thumb position (e.g. when locking a threshold slider). */
  commitPending: () => void;
};

export type RangeSliderReleaseCommitProps = {
  min: number;
  max: number;
  step: number;
  value: number;
  onCommit: (v: number) => void;
  /**
   * Optional live value while dragging — for custom UI only.
   * Omit to keep bound labels on `value` until release (recommended).
   */
  onPreviewValue?: (v: number | null) => void;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
};

/**
 * Range input: thumb moves while dragging; `onCommit` runs only on pointer release
 * (global capture so release off the track still commits).
 */
export const RangeSliderReleaseCommit = forwardRef<
  RangeSliderReleaseCommitHandle,
  RangeSliderReleaseCommitProps
>(function RangeSliderReleaseCommit(
  {
    min,
    max,
    step,
    value,
    onCommit,
    onPreviewValue,
    className,
    disabled,
    "aria-label": ariaLabel,
  },
  ref,
) {
  const [local, setLocal] = useState(() => clamp(value, min, max));
  const draggingRef = useRef(false);
  const localRef = useRef(local);
  const removeUpRef = useRef<(() => void) | null>(null);
  const onCommitRef = useRef(onCommit);
  const onPreviewValueRef = useRef(onPreviewValue);
  onCommitRef.current = onCommit;
  onPreviewValueRef.current = onPreviewValue;

  localRef.current = local;

  useEffect(() => {
    if (!draggingRef.current) setLocal(clamp(value, min, max));
  }, [value, min, max]);

  const clearUp = useCallback(() => {
    removeUpRef.current?.();
    removeUpRef.current = null;
  }, []);

  useEffect(() => () => clearUp(), [clearUp]);

  const commitValue = useCallback(
    (v: number) => {
      const clamped = clamp(v, min, max);
      setLocal(clamped);
      localRef.current = clamped;
      onCommitRef.current(clamped);
      onPreviewValueRef.current?.(null);
    },
    [min, max],
  );

  const finishDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    clearUp();
    commitValue(localRef.current);
  }, [clearUp, commitValue]);

  useImperativeHandle(
    ref,
    () => ({
      commitPending: () => {
        if (draggingRef.current) {
          finishDrag();
          return;
        }
        const v = clamp(localRef.current, min, max);
        if (Math.abs(v - value) < 1e-12) return;
        commitValue(v);
      },
    }),
    [finishDrag, commitValue, min, max, value],
  );

  const onPointerDown = () => {
    if (disabled) return;
    draggingRef.current = true;
    clearUp();
    const up = () => {
      finishDrag();
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    removeUpRef.current = () => {
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  };

  return (
    <input
      type="range"
      className={className}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={ariaLabel}
      value={local}
      onPointerDown={onPointerDown}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (!Number.isFinite(n)) return;
        localRef.current = n;
        setLocal(n);
        if (draggingRef.current) onPreviewValueRef.current?.(n);
      }}
    />
  );
});
