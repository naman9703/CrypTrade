#!/usr/bin/env bash
# kill_port PORT — terminate listeners on a TCP port (TERM, then KILL).
kill_port() {
  local port="$1"
  local pids
  pids=$(lsof -ti ":$port" 2>/dev/null || true)
  [[ -z "$pids" ]] && return 0
  echo "Stopping port $port (PIDs: $(echo "$pids" | tr '\n' ' ' | sed 's/ $//'))"
  echo "$pids" | xargs kill -TERM 2>/dev/null || true
  sleep 0.4
  pids=$(lsof -ti ":$port" 2>/dev/null || true)
  [[ -n "$pids" ]] && echo "$pids" | xargs kill -KILL 2>/dev/null || true
}
