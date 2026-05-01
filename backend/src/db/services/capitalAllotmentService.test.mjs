import test from "node:test";
import assert from "node:assert";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env"), override: false });

const { initPool, getPool } = await import("../pool.js");
const { query } = await import("../query.js");
const capital = await import("./capitalAllotmentService.js");

test("getAccountReservedTotal and getAccountFreeCapital", async (t) => {
  await initPool({ info: () => {}, warn: () => {}, error: () => {} });
  if (!getPool()) {
    t.skip("no DATABASE_URL");
    return;
  }

  const suffix = `cap_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const email = `${suffix}@test.local`;
  let accountId = null;
  let allotmentId = null;
  let userId = null;
  let strategyId = null;

  try {
    const u = await query(
      `INSERT INTO users (username, password_hash, role, is_active)
       VALUES ($1, '$2b$12$AAAAAAAAAAAAAAAAAAAAAAe8BRTfE5NfnVnqBxGpq1FILLME/hV2T', 'admin', true)
       RETURNING id`,
      [email],
    );
    userId = u.rows[0].id;
    const tm = await query(`SELECT id FROM trading_modes WHERE slug = 'paper' LIMIT 1`);
    const modeId = tm.rows[0]?.id;
    assert.ok(modeId, "trading_modes.paper required");

    const acc = await query(
      `INSERT INTO accounts (mode_id, user_id, label, account_type, is_active, requires_api)
       VALUES ($1, $2, $3, 'user', true, false)
       RETURNING id`,
      [modeId, userId, `Test ${suffix}`],
    );
    accountId = acc.rows[0].id;

    await query(
      `INSERT INTO wallet_snapshots (account_id, snapshot_type, total_usdt, available_usdt, in_positions_usdt, balances)
       VALUES ($1, 'scheduled', 1000, 1000, 0, '[]'::jsonb)`,
      [accountId],
    );

    const strat = await query(
      `INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id`,
      [userId, `Strat ${suffix}`],
    );
    strategyId = strat.rows[0].id;
    const ver = await query(
      `INSERT INTO strategy_versions (strategy_id, label, cfg_raw, created_by)
       VALUES ($1, 'v1', '{}'::jsonb, $2)
       RETURNING id`,
      [strategyId, userId],
    );
    const versionId = ver.rows[0].id;
    const inst = await query(
      `INSERT INTO bot_instances (account_id, strategy_version_id, label, status)
       VALUES ($1, $2, 'i1', 'stopped')
       RETURNING id`,
      [accountId, versionId],
    );
    const instanceId = inst.rows[0].id;

    const row = await capital.createAllotment(instanceId, accountId, "FIXED", 400, null, null, null);
    allotmentId = row.id;

    let reserved = await capital.getAccountReservedTotal(accountId);
    assert.strictEqual(reserved, 0);
    let free = await capital.getAccountFreeCapital(accountId);
    assert.strictEqual(free, 1000);

    await capital.reserveCapital(allotmentId, 150);
    reserved = await capital.getAccountReservedTotal(accountId);
    assert.ok(Math.abs(reserved - 150) < 1e-6);
    free = await capital.getAccountFreeCapital(accountId);
    assert.ok(Math.abs(free - 850) < 1e-6);
  } finally {
    if (accountId) {
      await query(`DELETE FROM bot_instances WHERE account_id = $1`, [accountId]).catch(() => {});
      await query(`DELETE FROM capital_allotments WHERE account_id = $1`, [accountId]).catch(() => {});
      await query(`DELETE FROM wallet_snapshots WHERE account_id = $1`, [accountId]).catch(() => {});
      await query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => {});
    }
    if (strategyId) {
      await query(`DELETE FROM strategy_versions WHERE strategy_id = $1`, [strategyId]).catch(() => {});
      await query(`DELETE FROM strategies WHERE id = $1`, [strategyId]).catch(() => {});
    }
    if (userId) await query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => {});
  }
});

test("concurrent createAllotment: only one succeeds when caps exceed wallet", async (t) => {
  await initPool({ info: () => {}, warn: () => {}, error: () => {} });
  if (!getPool()) {
    t.skip("no DATABASE_URL");
    return;
  }

  const suffix = `cap_conc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const email = `${suffix}@test.local`;
  let accountId = null;
  let userId = null;
  let strategyId = null;

  try {
    const u = await query(
      `INSERT INTO users (username, password_hash, role, is_active)
       VALUES ($1, '$2b$12$AAAAAAAAAAAAAAAAAAAAAAe8BRTfE5NfnVnqBxGpq1FILLME/hV2T', 'admin', true)
       RETURNING id`,
      [email],
    );
    userId = u.rows[0].id;
    const tm = await query(`SELECT id FROM trading_modes WHERE slug = 'paper' LIMIT 1`);
    const modeId = tm.rows[0]?.id;
    assert.ok(modeId);

    const acc = await query(
      `INSERT INTO accounts (mode_id, user_id, label, account_type, is_active, requires_api)
       VALUES ($1, $2, $3, 'user', true, false)
       RETURNING id`,
      [modeId, userId, `Conc ${suffix}`],
    );
    accountId = acc.rows[0].id;

    await query(
      `INSERT INTO wallet_snapshots (account_id, snapshot_type, total_usdt, available_usdt, in_positions_usdt, balances)
       VALUES ($1, 'scheduled', 1000, 1000, 0, '[]'::jsonb)`,
      [accountId],
    );

    const strat = await query(
      `INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id`,
      [userId, `StratC ${suffix}`],
    );
    strategyId = strat.rows[0].id;
    const ver = await query(
      `INSERT INTO strategy_versions (strategy_id, label, cfg_raw, created_by)
       VALUES ($1, 'v1', '{}'::jsonb, $2)
       RETURNING id`,
      [strategyId, userId],
    );
    const versionId = ver.rows[0].id;

    const i1 = await query(
      `INSERT INTO bot_instances (account_id, strategy_version_id, label, status)
       VALUES ($1, $2, 'a', 'stopped') RETURNING id`,
      [accountId, versionId],
    );
    const i2 = await query(
      `INSERT INTO bot_instances (account_id, strategy_version_id, label, status)
       VALUES ($1, $2, 'b', 'stopped') RETURNING id`,
      [accountId, versionId],
    );
    const inst1 = i1.rows[0].id;
    const inst2 = i2.rows[0].id;

    const results = await Promise.allSettled([
      capital.createAllotment(inst1, accountId, "FIXED", 600, null, null, null),
      capital.createAllotment(inst2, accountId, "FIXED", 600, null, null, null),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected");
    assert.strictEqual(ok.length, 1, "exactly one allotment should commit");
    assert.strictEqual(bad.length, 1);
    assert.ok(bad[0].reason instanceof capital.InsufficientCapitalError);
  } finally {
    if (accountId) {
      await query(`DELETE FROM bot_instances WHERE account_id = $1`, [accountId]).catch(() => {});
      await query(`DELETE FROM capital_allotments WHERE account_id = $1`, [accountId]).catch(() => {});
      await query(`DELETE FROM wallet_snapshots WHERE account_id = $1`, [accountId]).catch(() => {});
      await query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => {});
    }
    if (strategyId) {
      await query(`DELETE FROM strategy_versions WHERE strategy_id = $1`, [strategyId]).catch(() => {});
      await query(`DELETE FROM strategies WHERE id = $1`, [strategyId]).catch(() => {});
    }
    if (userId) await query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => {});
  }
});
