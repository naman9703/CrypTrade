-- Signal-brain strategies are shared across paper / demo / testnet / live.
-- Instances and accounts remain mode-scoped; only strategies.mode_id is cleared.

UPDATE strategies SET mode_id = NULL WHERE mode_id IS NOT NULL;
