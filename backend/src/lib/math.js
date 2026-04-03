export function clamp(x, min, max) {
  return Math.min(max, Math.max(min, x));
}

export function roundTo(x, decimals = 2) {
  const p = 10 ** decimals;
  return Math.round(x * p) / p;
}

export function pctChange(a, b) {
  if (a === 0) return 0;
  return (b - a) / a;
}

