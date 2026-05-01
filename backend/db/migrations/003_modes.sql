-- Phase 1A — 003: trading_modes + seed (slugs match backend/src/lib/tradingModePersistence.js)

CREATE TABLE trading_modes (
  id SMALLINT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  requires_api BOOLEAN NOT NULL DEFAULT false,
  is_real_money BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO trading_modes (id, slug, label, requires_api, is_real_money) VALUES
  (1, 'paper', 'Paper', false, false),
  (2, 'demo_api', 'Demo', true, false),
  (3, 'testnet', 'Testnet', true, false),
  (4, 'live', 'Live', true, true)
ON CONFLICT (id) DO NOTHING;
