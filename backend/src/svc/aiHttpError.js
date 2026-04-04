/**
 * Surface FastAPI / AI service JSON body on axios failures (default message hides the real reason).
 */
export function formatAiServiceError(err) {
  if (err == null) return "unknown_error";
  const data = err.response?.data;
  if (data != null && typeof data === "object") {
    const d = data.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) {
      return d
        .map((x) => {
          if (x && typeof x === "object" && x.msg) {
            const loc = Array.isArray(x.loc) ? x.loc.filter((p) => p !== "body").join(".") : "";
            return loc ? `${loc}: ${x.msg}` : x.msg;
          }
          try {
            return JSON.stringify(x);
          } catch {
            return String(x);
          }
        })
        .join("; ");
    }
    if (d != null && typeof d === "object") {
      try {
        return JSON.stringify(d);
      } catch {
        /* fallthrough */
      }
    }
    if (typeof data.message === "string") return data.message;
    if (typeof data.error === "string") return data.error;
    try {
      return JSON.stringify(data);
    } catch {
      /* fallthrough */
    }
  }
  return String(err.message || err);
}
