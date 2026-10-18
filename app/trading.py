from datetime import datetime
import math

import numpy as np

from .storage import UTC, parse_time


def fill_order(asks, budget, expense_rate):
    """Buy asks in ascending price order; budget includes the expense reserve."""
    remaining = budget / (1 + expense_rate)
    shares = cost = 0.0
    for level in sorted(asks,key=lambda x:x["price"]):
        price, size = float(level["price"]),float(level["size"])
        if not math.isfinite(price) or not math.isfinite(size) or not 0 < price < 1 or size <= 0:
            continue
        quantity = min(size, remaining / price)
        shares += quantity
        spent = quantity * price
        cost += spent
        remaining -= spent
        if remaining < 1e-9:
            break
    total = cost*(1+expense_rate)
    return {"shares":shares,"cost":cost,"expenses":cost*expense_rate,"total":total,
            "vwap":cost/shares if shares else None,"filled_fraction":total/budget if budget else 0}


def evaluate(draws, event, budget, expense_bps, safety_pp, eligible=True, now=None):
    now = now or datetime.now(UTC)
    rows = []
    for market in event["markets"]:
        hit = (draws >= market["lower"]) & ((draws <= market["upper"]) if market["upper"] is not None else True)
        probability = float(np.mean(hit))
        for side in ("yes","no"):
            p = probability if side=="yes" else 1-probability
            book = market["books"].get(side,{})
            fill = fill_order(book.get("asks",[]), budget, expense_bps/10000)
            reasons = []
            if not eligible:
                reasons.append("Не подтверждены правила или свежесть истории")
            if not market["active"]:
                reasons.append("Рынок не принимает ордера")
            fetched = book.get("fetched_at")
            if not fetched or abs((now-parse_time(fetched)).total_seconds()) > 120:
                reasons.append("Стакан старше 120 секунд или недоступен")
            if not fill["shares"]:
                reasons.append("Нет предложений продажи")
            if fill["filled_fraction"] < .95:
                reasons.append("Глубины стакана не хватает на 95% бюджета")
            cost = fill["total"]
            payout = p*fill["shares"]
            conservative_p = max(0,p-safety_pp/100)
            conservative_profit = conservative_p*fill["shares"]-cost
            roi = (payout/cost-1) if cost else None
            signal = not reasons and conservative_profit > 0
            rows.append({"market_id":market["id"],"label":market["label"],"side":side.upper(),"probability":p,
                "book_fetched_at":fetched,
                "mc_standard_error":float(np.sqrt(p*(1-p)/len(draws))),
                "token_id":market.get("tokens",{}).get(side), **fill,
                "expected_profit":payout-cost if cost else None, "roi":roi,
                "conservative_profit":conservative_profit if cost else None,
                "edge":p-cost/fill["shares"] if fill["shares"] else None,
                "signal":signal,"reasons":reasons,"fees_enabled":market.get("fees_enabled",False)})
    return sorted(rows,key=lambda x:(x["signal"],x["roi"] if x["roi"] is not None else -1e10),reverse=True)
