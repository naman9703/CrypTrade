/** Deep-freeze snapshot for immutability at signal time (replay-safe). */
export function deepFreezeSnapshot<T extends object>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const k of Object.keys(obj) as (keyof T)[]) {
    const v = obj[k];
    if (v !== null && typeof v === "object") deepFreezeSnapshot(v as object);
  }
  return obj;
}
