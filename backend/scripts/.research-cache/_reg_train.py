
import json, numpy as np
from pathlib import Path
cols = ["atr14_pct","atr_percentile","adx14","rsi14","dist_ema20_pct","dist_ema50_pct","dist_ema200_pct","ema_stack","vol_vs_avg20","body_pct","upper_wick_pct","lower_wick_pct","dist_swing_high_pct","dist_swing_low_pct","entry_hour_utc","entry_weekday","session","side"]
payload = json.loads(Path("/Users/namanpaliwal/Desktop/trading/backend/scripts/.research-cache/st-xgb-fine-in.json").read_text())
rows = sorted(payload['rows'], key=lambda r: int(r['entry_ts']))
def vec(f):
  return [float(f.get(k,0) or 0) for k in cols]
X = np.array([vec(r['features']) for r in rows], float)
y = np.array([float(r['rr']) for r in rows], float)
n=len(X); i1=max(1,int(n*0.6)); i2=max(i1+1,int(n*0.8))
try:
  from xgboost import XGBRegressor
  m = XGBRegressor(n_estimators=200, max_depth=3, learning_rate=0.05, random_state=42)
except Exception:
  from sklearn.ensemble import HistGradientBoostingRegressor
  m = HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, random_state=42)
m.fit(X[:i1], y[:i1])
flips = payload['flips']
XF = np.array([vec(f['features']) for f in flips], float)
pred = m.predict(XF)
# map predicted R to pseudo-prob via sigmoid of R
pseudo = 1/(1+np.exp(-np.clip(pred, -3, 3)))
out = {str(int(f['idx'])): float(p) for f,p in zip(flips, pseudo)}
# also store raw pred by idx
raw = {str(int(f['idx'])): float(p) for f,p in zip(flips, pred)}
Path("/Users/namanpaliwal/Desktop/trading/backend/scripts/.research-cache/st-xgb-reg-out.json").write_text(json.dumps({"probs_by_idx": out, "pred_r_by_idx": raw}))
print(json.dumps({"model": type(m).__name__, "pred_r_p50": float(np.median(pred))}))
