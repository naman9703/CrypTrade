import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../ws/store";
import "./aiTradeMotion.css";

const LOAD_MS = 200;
const PLAY_MS = 4800;

function CirclesC1() {
  return Array.from({ length: 15 }, (_, i) => (
    <span
      key={i}
      className="ai-m-circle"
      style={{
        animationDelay: `${i * 0.05}s`,
        opacity: Math.min(0.04 * (i + 1), 0.72),
        borderColor: `hsl(${(i * 11 + 300) % 360}, 74%, 58%)`,
      }}
    />
  ));
}

function CirclesC2() {
  return Array.from({ length: 15 }, (_, i) => (
    <span
      key={i}
      className="ai-m-circle"
      style={{
        animationDelay: `${i * 0.075}s`,
        opacity: Math.min(0.05 * (i + 1), 0.8),
        borderColor: `hsl(${(i * 9 + 280) % 360}, 70%, 56%)`,
      }}
    />
  ));
}

function CirclesD3() {
  return Array.from({ length: 45 }, (_, i) => (
    <span
      key={i}
      className="ai-m-circle"
      style={{
        animationDelay: `${i * 0.04}s`,
        opacity: Math.min(0.01 * (i + 1), 0.55),
        borderColor: `hsl(${(i * 6 + 330) % 360}, 78%, 55%)`,
      }}
    />
  ));
}

export type AiTradeMotionVisualProps = {
  /** If set, expand once and keep CSS motion running for this many ms (e.g. login screen), then stop. No store triggers. */
  continuousPlayMs?: number;
};

/**
 * Non-blocking decorative motion: expands and runs layered CSS animations, then winds down.
 * Triggered on OPEN/CLOSE trade rows, engine start, and position count decrease (close).
 * Or pass `continuousPlayMs` for a timed loop (no WebSocket / store triggers).
 */
export function AiTradeMotionVisual({ continuousPlayMs }: AiTradeMotionVisualProps = {}) {
  const trades = useAppStore((s) => s.trades);
  const bot = useAppStore((s) => s.bot);
  const positions = useAppStore((s) => s.positions);
  const [expanded, setExpanded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [session, setSession] = useState(0);
  const timersRef = useRef<number[]>([]);
  const prevHeadRef = useRef<string | null>(null);
  const prevRunningRef = useRef<boolean | undefined>(undefined);
  const prevPosLenRef = useRef<number | undefined>(undefined);
  const debounceRef = useRef<number | null>(null);
  const standalone = continuousPlayMs != null && continuousPlayMs > 0;

  const clearTimers = () => {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
  };

  const startPlayback = useCallback(() => {
    clearTimers();
    setSession((s) => s + 1);
    setExpanded(false);
    setPlaying(false);
    const tExpand = window.setTimeout(() => {
      setExpanded(true);
      setPlaying(true);
    }, LOAD_MS);
    const tStop = window.setTimeout(() => {
      setExpanded(false);
      setPlaying(false);
      clearTimers();
    }, LOAD_MS + PLAY_MS);
    timersRef.current.push(tExpand, tStop);
  }, []);

  const bump = useCallback(() => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      queueMicrotask(startPlayback);
    }, 120);
  }, [startPlayback]);

  useEffect(() => {
    if (standalone) return;
    const t0 = trades[0] as { id?: string; type?: string } | undefined;
    const sig = t0?.id != null ? `${t0.id}:${t0.type ?? ""}` : "";
    if (
      prevHeadRef.current !== null &&
      sig &&
      sig !== prevHeadRef.current &&
      (t0?.type === "OPEN" || t0?.type === "CLOSE")
    ) {
      bump();
    }
    prevHeadRef.current = sig || null;
  }, [standalone, trades, bump]);

  useEffect(() => {
    if (standalone) return;
    const r = Boolean(bot?.running);
    if (prevRunningRef.current === false && r) bump();
    if (prevRunningRef.current === undefined && r) queueMicrotask(bump);
    prevRunningRef.current = r;
  }, [standalone, bot?.running, bump]);

  useEffect(() => {
    if (standalone) return;
    const n = positions?.length ?? 0;
    if (prevPosLenRef.current !== undefined && n < prevPosLenRef.current) bump();
    prevPosLenRef.current = n;
  }, [standalone, positions?.length, bump]);

  useEffect(() => {
    if (!standalone || !continuousPlayMs) return;
    clearTimers();
    setSession((s) => s + 1);
    setExpanded(false);
    setPlaying(false);
    const tExpand = window.setTimeout(() => {
      setExpanded(true);
      setPlaying(true);
    }, LOAD_MS);
    const tStop = window.setTimeout(() => {
      setExpanded(false);
      setPlaying(false);
    }, LOAD_MS + continuousPlayMs);
    timersRef.current.push(tExpand, tStop);
    return () => clearTimers();
  }, [standalone, continuousPlayMs]);

  useEffect(() => () => clearTimers(), []);

  const cls = (variant: string) =>
    ["ai-m-visual", variant, expanded ? "ai-m-active" : "", playing ? "ai-m-playing" : ""]
      .filter(Boolean)
      .join(" ");

  return (
    <div className="ai-m-area" aria-hidden>
      <div className="ai-m-visuals" key={session}>
        <div className={cls("c1")}>
          <div className="ai-m-inner">
            <CirclesC1 />
          </div>
        </div>
        <div className={cls("c2")}>
          <div className="ai-m-inner">
            <CirclesC2 />
          </div>
        </div>
        <div className={cls("d3")}>
          <div className="ai-m-inner ai-m-p3d">
            <CirclesD3 />
          </div>
        </div>
      </div>
    </div>
  );
}
