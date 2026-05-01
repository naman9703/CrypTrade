-- Phase 1A — 014: seed paper-mode system account (requires users table)
-- Placeholder bcrypt hash is intentionally invalid for login; user is inactive.

INSERT INTO users (username, password_hash, role, is_active)
VALUES (
  '_paper_system',
  '$2b$12$AAAAAAAAAAAAAAAAAAAAAAe8BRTfE5NfnVnqBxGpq1FILLME/hV2T',
  'admin',
  false
)
ON CONFLICT (username) DO NOTHING;

INSERT INTO accounts (mode_id, user_id, label, account_type, is_active)
SELECT tm.id, u.id, 'Paper (system)', 'main', true
FROM trading_modes tm
JOIN users u ON u.username = '_paper_system'
WHERE tm.slug = 'paper'
  AND NOT EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.mode_id = tm.id AND a.label = 'Paper (system)'
  );
