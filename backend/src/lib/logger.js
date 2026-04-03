export function createLogger() {
  function emit(level, event, data = {}) {
    const msg = { ts: new Date().toISOString(), level, event, ...data };
    // Keep stdout structured for log streaming + later storage
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(msg));
  }
  return {
    info: (event, data) => emit("info", event, data),
    warn: (event, data) => emit("warn", event, data),
    error: (event, data) => emit("error", event, data),
  };
}

