import { useCallback, useEffect, useRef, useState } from "react";

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export type RangeSliderReleaseCommitProps = {
  min: number;
  max: number;
  step: number;
  value: number;
  onCommit: (v: number) => void;
  /** Live value while dragging; `null` when the pointer is released (after `onCommit`). For labels only. */
  onPreviewValue?: (v: number | null) => void;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
};

/**
 * Range input that updates visually while dragging but calls `onCommit` only on pointer release
 * (global capture so release off the track still commits).
 */
export function RangeSliderReleaseCommit({
  min,
  max,
  step,
  value,
  onCommit,
  onPreviewValue,
  className,
  disabled,
  "aria-label": ariaLabel,
}: RangeSliderReleaseCommitProps) {
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

  const finishDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    clearUp();
    const v = clamp(localRef.current, min, max);
    setLocal(v);
    onCommitRef.current(v);
    onPreviewValueRef.current?.(null);
  }, [min, max, clearUp]);

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
      onBlur={() => {
        if (draggingRef.current) return;
        const v = clamp(localRef.current, min, max);
        if (Math.abs(v - value) < 1e-12) return;
        setLocal(v);
        onCommitRef.current(v);
        onPreviewValueRef.current?.(null);
      }}
    />
  );
}
