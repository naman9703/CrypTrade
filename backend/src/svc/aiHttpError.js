/**
 * Surface FastAPI / AI service JSON body on axios failures (default message hides the real reason).
 * Also unwraps Node AggregateError / axios cause chains (common when localhost:8001 is down).
 */
const defaultAiBaseUrl = () => process.env.AI_BASE_URL || "http://localhost:8001";

export function formatAiServiceError(err, depth = 0) {
  if (err == null) return "unknown_error";
  if (depth > 5) return String(err?.message || err);

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

  if (typeof AggregateError !== "undefined" && err instanceof AggregateError && Array.isArray(err.errors) && err.errors.length) {
    const parts = err.errors.map((e) => formatAiServiceError(e, depth + 1)).filter(Boolean);
    const joined = parts.length ? parts.join(" | ") : "";
    const head = String(err.message || "").trim();
    if (joined) {
      return head && !joined.toLowerCase().includes("aggregateerror") ? `${head}: ${joined}` : joined;
    }
  }

  const code = err.code;
  const msg = String(err.message || "");

  if (code === "ECONNREFUSED" || /ECONNREFUSED/i.test(msg)) {
    return `Cannot connect to AI service at ${defaultAiBaseUrl()} (${code || "ECONNREFUSED"}). Start it from the repo root: npm run dev:ai — or: cd ai-service && ./scripts/run-dev-ai.sh`;
  }
  if (code === "ENOTFOUND") {
    return `AI host not found (${code}). Check AI_BASE_URL in backend/.env (current: ${defaultAiBaseUrl()}).`;
  }
  if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
    return `AI service request timed out (${code}). Is uvicorn running and healthy on ${defaultAiBaseUrl()}?`;
  }

  if (err.cause != null && err.cause !== err) {
    const inner = formatAiServiceError(err.cause, depth + 1);
    if (inner && inner !== "unknown_error" && inner !== msg) {
      return msg ? `${msg} — ${inner}` : inner;
    }
  }

  return String(err.message || err);
}
