"""Recency-weighted hourly seasonality + daily Gamma-Poisson variation.

This is an empirical count forecast, not a calibrated claim about true odds.
All fits use completed, explicitly covered local days strictly before cutoff.
"""
from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np

from .storage import UTC, hour


def hours_between(start, end):
    t = start
    while t < end:
        yield t
        t += timedelta(hours=1)


def complete_days(data, cutoff, timezone):
    zone = ZoneInfo(timezone)
    groups = defaultdict(list)
    for t, count in data.items():
        if t + timedelta(hours=1) <= cutoff:
            groups[t.astimezone(zone).date()].append((t, count))
    result = []
    for day, rows in sorted(groups.items()):
        a = datetime.combine(day, datetime.min.time(), zone).astimezone(UTC)
        b = datetime.combine(day + timedelta(days=1), datetime.min.time(), zone).astimezone(UTC)
        if b <= cutoff and len(rows) == int((b-a).total_seconds()/3600):
            result.append((day, rows))
    return result[-120:]


def fit(data, cutoff, timezone):
    days = complete_days(data, cutoff, timezone)
    if len(days) < 14:
        raise ValueError(f"Нужно не менее 14 полностью покрытых дней истории; найдено {len(days)}. Пропуски не считаются нулями.")
    zone = ZoneInfo(timezone)
    last = days[-1][0]
    weights = np.array([2 ** (-(last-d).days / 21) for d, _ in days])
    totals = np.array([sum(c for _, c in rows) for _, rows in days], dtype=float)
    mu = float(np.average(totals, weights=weights))
    if mu <= 0:
        raise ValueError("История состоит из нулей: модель активности не может быть оценена")
    var = float(np.average((totals-mu)**2, weights=weights))
    effective_n = float(weights.sum()**2 / (weights**2).sum())
    var *= effective_n / max(1, effective_n - 1)
    shape = max(0.5, min(1e6, mu**2 / max(var-mu, 1e-6)))
    global_counts = np.zeros(24)
    global_exposure = np.zeros(24)
    wd_counts = np.zeros((7,24))
    wd_exposure = np.zeros((7,24))
    for (_, rows), weight in zip(days, weights):
        for t, c in rows:
            local = t.astimezone(zone)
            h, wd = local.hour, local.weekday()
            global_counts[h] += weight*c
            global_exposure[h] += weight
            wd_counts[wd,h] += weight*c
            wd_exposure[wd,h] += weight
    # Shrink sparse weekday/hour cells toward the global hour pattern (7 prior days).
    base = (global_counts + mu/24) / (global_exposure + 1)
    rates = (wd_counts + 7*base[None,:]) / (wd_exposure + 7)
    return {"rates": rates, "shape": shape, "mean": mu, "variance": var,
            "effective_days": effective_n, "days": days,
            "uncertainty_shape": max(2, effective_n*shape)}


def simulate(fitted, start, end, timezone, samples=20000, seed=42):
    rng = np.random.default_rng(seed)
    zone = ZoneInfo(timezone)
    intensities = defaultdict(float)
    for t in hours_between(start, end):
        local = t.astimezone(zone)
        intensities[local.date()] += float(fitted["rates"][local.weekday(),local.hour])
    common = rng.gamma(fitted["uncertainty_shape"], 1/fitted["uncertainty_shape"], samples)
    result = np.zeros(samples, dtype=np.int64)
    for intensity in intensities.values():
        factor = rng.gamma(fitted["shape"], 1/fitted["shape"], samples)
        result += rng.poisson(intensity*factor*common)
    return result


def backtest(data, cutoff, timezone):
    days = complete_days(data, cutoff, timezone)
    checks = []
    for day, rows in days[-14:]:
        start = min(t for t, _ in rows)
        if len(complete_days(data, start, timezone)) < 14:
            continue
        fitted = fit(data, start, timezone)
        end = max(t for t, _ in rows) + timedelta(hours=1)
        draws = simulate(fitted, start, end, timezone, samples=2500)
        actual = sum(c for _, c in rows)
        lo, hi = np.quantile(draws, [.1,.9])
        checks.append({"date": str(day), "actual": actual, "prediction": round(float(draws.mean()),1), "low": int(lo), "high": int(hi)})
    return {"days": len(checks), "mae": round(float(np.mean([abs(c["actual"]-c["prediction"]) for c in checks])),1) if checks else None,
            "coverage80": float(np.mean([c["low"] <= c["actual"] <= c["high"] for c in checks])) if checks else None,
            "results": checks}


def forecast(data, start, end, timezone, now=None, samples=20000):
    now = now or datetime.now(UTC)
    if start != hour(start) or end != hour(end) or end <= start:
        raise ValueError("Границы периода должны совпадать с часами UTC; конец позже начала")
    if end-start > timedelta(days=31) or end > now+timedelta(days=31):
        raise ValueError("Горизонт прогноза ограничен 31 днём")
    available = [t for t in data if t < hour(now)]
    if not available:
        raise ValueError("Сначала импортируйте историю или включите демо")
    cutoff = min(hour(now), max(available)+timedelta(hours=1))
    known_end = min(end, cutoff)
    missing = [t for t in hours_between(start,known_end) if t not in data]
    if missing:
        raise ValueError(f"В периоде рынка отсутствуют {len(missing)} часов истории; первый: {missing[0].isoformat()}")
    current = sum(data[t] for t in hours_between(start,known_end))
    fitted = fit(data, min(cutoff, end), timezone)
    draws = current + simulate(fitted, max(start,cutoff), end, timezone, samples)
    zone = ZoneInfo(timezone)
    daily = [{"date": str(day), "count": sum(c for _,c in rows)} for day, rows in fitted["days"]]
    hist, edges = np.histogram(draws, bins=min(40, max(1, int(np.ptp(draws))+1)))
    warnings = []
    stale_hours = max(0,(now-cutoff).total_seconds()/3600)
    if stale_hours > 3:
        warnings.append(f"История отстаёт на {stale_hours:.1f} ч. Торговые сигналы отключены.")
    if len(fitted["days"]) < 28:
        warnings.append("Менее 28 полных дней: оценка сезонности нестабильна.")
    last_training_hour = max(t for t, _ in fitted["days"][-1][1]) + timedelta(hours=1)
    training_fresh = (min(cutoff,end)-last_training_hour).total_seconds() <= 72*3600
    if not training_fresh:
        warnings.append("Последний полный день обучения старше 72 часов. Обновите историю; торговые сигналы отключены.")
    return draws, {"current_count": current, "cutoff": cutoff.isoformat(), "mean": round(float(draws.mean()),1),
        "median": int(np.median(draws)), "low": int(np.quantile(draws,.1)), "high": int(np.quantile(draws,.9)),
        "training_days": len(fitted["days"]), "daily_mean": round(fitted["mean"],1), "dispersion": round(fitted["shape"],2),
        "daily": daily, "hourly_pattern": [round(float(x),2) for x in fitted["rates"].mean(axis=0)],
        "histogram": [{"from": float(edges[i]), "to":float(edges[i+1]), "probability": int(n)/len(draws)} for i,n in enumerate(hist)],
        "warnings": warnings, "fresh": stale_hours <= 3 and training_fresh, "timezone": str(zone), "samples": samples,
        "backtest": backtest(data,min(cutoff,end),timezone)}
