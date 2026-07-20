-- Stop auditing ohlcv_candles (and Timescale chunks): each candle INSERT was duplicating
-- full row JSON into audit_log (~50GB). Market data stays in ohlcv_candles; audit is not useful.

-- 1) Drop audit trigger on hypertable parent (covers new chunk writes on recent Timescale).
DROP TRIGGER IF EXISTS trg_audit_ohlcv_candles ON public.ohlcv_candles;

-- 2) Drop audit triggers on existing chunk tables (012_audit attached per physical chunk).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT chunk_schema, chunk_name
    FROM timescaledb_information.chunks
    WHERE hypertable_name = 'ohlcv_candles'
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_audit_%I ON %I.%I',
      r.chunk_name,
      r.chunk_schema,
      r.chunk_name
    );
  END LOOP;
END;
$$;

-- 3) Purge historical ohlcv candle audit rows (parent name + chunk prefix for retired chunks).
DO $$
DECLARE
  v_hid TEXT;
  v_batch INT;
  v_total BIGINT := 0;
BEGIN
  SELECT (regexp_match(chunk_name, '^_hyper_(\d+)_'))[1]
    INTO v_hid
    FROM timescaledb_information.chunks
   WHERE hypertable_name = 'ohlcv_candles'
   LIMIT 1;

  LOOP
    DELETE FROM audit_log
    WHERE id IN (
      SELECT id
        FROM audit_log
       WHERE table_name = 'ohlcv_candles'
          OR (v_hid IS NOT NULL AND table_name ~ ('^_hyper_' || v_hid || '_'))
       LIMIT 100000
    );
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
    EXIT WHEN v_batch = 0;
  END LOOP;

  RAISE NOTICE 'audit_log: deleted % ohlcv_candles audit rows', v_total;
END;
$$;
