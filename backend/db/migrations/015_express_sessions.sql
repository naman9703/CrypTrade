-- Phase 1B — express-session store for connect-pg-simple (not the app-level user_sessions shape)
-- https://github.com/voxpelli/node-connect-pg-simple

CREATE TABLE express_sessions (
  sid VARCHAR NOT NULL COLLATE "default",
  sess JSON NOT NULL,
  expire TIMESTAMPTZ(6) NOT NULL,
  PRIMARY KEY (sid)
);

CREATE INDEX idx_express_sessions_expire ON express_sessions (expire);
