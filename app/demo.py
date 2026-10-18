"""Deterministic synthetic data, physically separated from live observations."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np

from .storage import UTC, hour


def demo_hours(now=None):
    end = hour(now or datetime.now(UTC))
    start = end-timedelta(days=120)
    rng = np.random.default_rng(731)
    rows = []
    factors = {}
    for i in range(120*24):
        t = start+timedelta(hours=i)
        local = t.astimezone(ZoneInfo("America/New_York"))
        if local.date() not in factors:
            factors[local.date()] = rng.gamma(4,1/4)
        pattern = .35 + 1.3*np.exp(-((local.hour-14)/5)**2) + .65*np.exp(-((local.hour-23)/3)**2)
        rate = 3.2*pattern*factors[local.date()]*(1.12 if local.weekday() < 5 else .8)
        rows.append((t,int(rng.poisson(rate))))
    return rows


def demo_event(now=None):
    now = now or datetime.now(UTC)
    zone = ZoneInfo("America/New_York")
    start = (now.astimezone(zone)-timedelta(days=5)).replace(hour=12,minute=0,second=0,microsecond=0)
    end = start+timedelta(days=7)
    limits = [(0,199),(200,279),(280,359),(360,439),(440,519),(520,599),(600,None)]
    prices = [.035,.10,.21,.27,.21,.11,.065]
    markets = []
    for i, ((lo,hi),p) in enumerate(zip(limits,prices)):
        label = f"{lo}-{hi}" if hi is not None else f"{lo}+"
        books = {}
        for side, price in [("yes",p),("no",1-p)]:
            books[side] = {"asks":[{"price":min(.999,price+.008),"size":250},{"price":min(.999,price+.02),"size":2500}],"fetched_at":now.isoformat()}
        markets.append({"id":f"demo-{i}","label":label,"lower":lo,"upper":hi,"active":True,"fees_enabled":False,"tokens":{},"books":books})
    return {"slug":"demo","title":"Демонстрация • публикации за 7 дней","description":"Искусственная история и искусственные стаканы. Эти данные не относятся к реальному рынку и не подходят для ставок.",
        "resolution_source":"Синтетический генератор", "markets":markets,"excluded":[],"fetched_at":now.isoformat(),"demo":True,
        "start":start.strftime("%Y-%m-%dT%H:%M"),"end":end.strftime("%Y-%m-%dT%H:%M"),"timezone":"America/New_York"}
