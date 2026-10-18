"""Read-only HTTPS adapters. No wallet, signing, arbitrary URL fetching or orders."""
import asyncio
import json
import math
import re
from datetime import datetime, timedelta
from urllib.parse import urlparse

import httpx

from .storage import UTC, hour, parse_time


class ProviderError(ValueError):
    pass


async def get_json(client, url, params=None):
    try:
        response = await client.get(url, params=params)
        response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as exc:
        raise ProviderError(f"Источник {urlparse(url).hostname} вернул HTTP {exc.response.status_code}. Запрошенный ресурс может быть недоступен или отсутствовать.") from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise ProviderError(f"Источник {urlparse(url).hostname} недоступен или вернул неверный JSON. Проверьте доступ к домену и повторите запрос.") from exc


def slug_from(value):
    value = value.strip()
    if value.startswith("https://"):
        parsed = urlparse(value)
        if parsed.hostname not in {"polymarket.com", "www.polymarket.com"}:
            raise ValueError("Ожидается ссылка polymarket.com/event/…")
        parts = parsed.path.strip("/").split("/")
        if "event" not in parts or parts.index("event")+1 >= len(parts):
            raise ValueError("В ссылке нет slug события")
        value = parts[parts.index("event")+1]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,220}", value):
        raise ValueError("Некорректный slug события")
    return value


def bounds(label):
    s = label.lower().strip().replace(",", "").replace("–", "-").replace("—", "-")
    match = re.fullmatch(r"(\d+)\s*-\s*(\d+)(?:\s+(?:tweets|posts))?", s)
    if match:
        lo, hi = map(int,match.groups())
        if lo <= hi:
            return lo, hi
    match = re.fullmatch(r"(?:<\s*(\d+)|(?:less than|under|below)\s+(\d+))(?:\s+(?:tweets|posts))?", s)
    if match:
        return 0, int(next(g for g in match.groups() if g is not None))-1
    match = re.fullmatch(r"(\d+)\s*\+(?:\s+(?:tweets|posts))?", s)
    if match:
        return int(match[1]), None
    match = re.fullmatch(r"(?:>=\s*(\d+)|(\d+)\s+or\s+(?:more|above))(?:\s+(?:tweets|posts))?",s)
    if match:
        return int(next(g for g in match.groups() if g is not None)), None
    match = re.fullmatch(r">\s*(\d+)",s)
    if match:
        return int(match[1])+1, None
    raise ValueError("Не распознан диапазон количества: " + label)


def array(value):
    if isinstance(value, str):
        return json.loads(value)
    return value


def normalize_event(event):
    if not isinstance(event,dict) or not isinstance(event.get("markets"),list):
        raise ProviderError("Gamma API вернул неизвестную структуру события")
    markets = []
    excluded = []
    for market in event.get("markets", []):
        if not isinstance(market,dict):
            raise ProviderError("Gamma API вернул неизвестную структуру рынка")
        label = str(market.get("groupItemTitle") or "")
        try:
            lo, hi = bounds(label)
            outcomes = array(market.get("outcomes", []))
            tokens = array(market.get("clobTokenIds", []))
            if not isinstance(outcomes,list) or not isinstance(tokens,list) or len(outcomes) != 2 or len(tokens) != 2 or set(str(x).lower() for x in outcomes) != {"yes", "no"}:
                raise ValueError("Отсутствуют бинарные YES/NO токены")
            token_map = {str(o).lower(): str(t) for o,t in zip(outcomes,tokens)}
            markets.append({"id": str(market.get("id", "")), "label": label, "lower":lo, "upper": hi,
                "tokens":token_map, "active": bool(market.get("active")) and not bool(market.get("closed")) and bool(market.get("acceptingOrders")),
                "fees_enabled":bool(market.get("feesEnabled")), "books": {}, "question":market.get("question", "")})
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            excluded.append(f"{label or market.get('question', '?')}: {exc}")
    if not markets:
        raise ProviderError("В событии не найдены распознаваемые диапазоны твитов с YES/NO токенами")
    markets.sort(key=lambda x:x["lower"])
    for a,b in zip(markets,markets[1:]):
        if a["upper"] is None or a["upper"] >= b["lower"]:
            raise ProviderError("Диапазоны рынка пересекаются — проверьте структуру события")
    descriptions = list(dict.fromkeys(m.get("description", "") for m in event.get("markets",[]) if m.get("description")))
    description = event.get("description") or "\n\n".join(descriptions)
    resolution = event.get("resolutionSource") or next((m.get("resolutionSource") for m in event.get("markets",[]) if m.get("resolutionSource")), "")
    return {"slug":event["slug"], "title":event.get("title", ""), "description":description,
        "resolution_source":resolution, "markets":markets, "excluded":excluded,
        "fetched_at":datetime.now(UTC).isoformat(), "demo":False}


async def fetch_event(slug, client=None):
    if client is None:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False, headers={"User-Agent":"TweetScope/1.0"}) as c:
            return await fetch_event(slug,c)
    raw = await get_json(client, "https://gamma-api.polymarket.com/events", {"slug":slug})
    if not isinstance(raw,list) or not raw:
        raise ProviderError("Событие не найдено. Проверьте ссылку; указанный рынок может ещё не существовать.")
    exact = next((e for e in raw if isinstance(e,dict) and e.get("slug")==slug), None)
    if exact is None:
        raise ProviderError("API вернул другое событие")
    event = normalize_event(exact)
    semaphore = asyncio.Semaphore(6)
    async def load_book(market, side, token):
        if not market["active"]:
            market["books"][side] = {"asks":[],"error":"Рынок не принимает заявки"}
            return
        async with semaphore:
            try:
                book = await get_json(client,"https://clob.polymarket.com/book", {"token_id":token})
                if not isinstance(book,dict) or not isinstance(book.get("asks"),list):
                    raise ProviderError("Неизвестная структура стакана CLOB")
                levels = []
                for item in book.get("asks",[]):
                    p, size = float(item["price"]), float(item["size"])
                    if math.isfinite(p) and math.isfinite(size) and 0 < p < 1 and size > 0:
                        levels.append({"price":p,"size":size})
                levels.sort(key=lambda x:x["price"])
                market["books"][side] = {"asks": levels, "fetched_at":datetime.now(UTC).isoformat()}
            except (ValueError, TypeError, KeyError) as exc:
                market["books"][side] = {"asks":[],"error":str(exc)}
    await asyncio.gather(*(load_book(m,s,t) for m in event["markets"] for s,t in m["tokens"].items()))
    event["fetched_at"] = datetime.now(UTC).isoformat()
    return event


def post_kind(post):
    kind = str(post.get("type", post.get("postType", ""))).lower()
    aliases = {"tweet":"post", "original":"post", "retweet":"repost", "quote_tweet":"quote", "quote-tweet":"quote"}
    kind = aliases.get(kind,kind)
    if kind in {"post","reply","repost","quote"}:
        return kind
    # Never classify an unknown record as a counted post by default.
    raise ProviderError("XTracker не указал распознаваемый тип публикации. Импортируйте почасовой CSV, сверенный с правилами рынка.")


async def collect_posts(days, include_replies, include_reposts, client=None):
    """Stage a public feed for review; date coverage must be confirmed by the user.

    XTracker is not a guaranteed stable API. Unsupported shapes/pagination fail
    explicitly instead of returning an apparently complete, truncated history.
    """
    if client is None:
        async with httpx.AsyncClient(timeout=25, follow_redirects=False) as c:
            return await collect_posts(days,include_replies,include_reposts,c)
    end = hour(datetime.now(UTC))
    start = end-timedelta(days=days)
    posts = {}
    cursor = None
    finished = False
    for page in range(1,101):
        params = {"startDate":start.isoformat(),"endDate":end.isoformat(),"limit":200,"page":page}
        if cursor:
            params["cursor"] = cursor
        raw = await get_json(client,"https://xtracker.polymarket.com/api/users/elonmusk/posts",params)
        body = raw.get("data",raw) if isinstance(raw,dict) else raw
        rows = body.get("posts") if isinstance(body,dict) else body
        if not isinstance(rows,list):
            raise ProviderError("Неизвестный формат XTracker. Используйте импорт CSV.")
        if rows and all(isinstance(p,dict) and not (p.get("type") or p.get("postType")) for p in rows):
            raise ProviderError("Текущий API XTracker не передаёт типы публикаций: нельзя проверить соответствие правилам рынка. Используйте официальный API X или почасовой CSV, сверенный с Post Counter.")
        new = 0
        for post in rows:
            if not isinstance(post,dict):
                raise ProviderError("Неверная запись XTracker")
            pid = str(post.get("id") or post.get("platformId") or "")
            if not pid:
                raise ProviderError("Нет ID публикации: невозможно убрать дубликаты")
            if pid not in posts:
                new += 1
                posts[pid] = post
        meta = (body.get("pagination") if isinstance(body,dict) else None) or (raw.get("pagination") if isinstance(raw,dict) else None) or {}
        if not isinstance(meta,dict):
            raise ProviderError("Неизвестная структура пагинации XTracker")
        next_cursor = meta.get("nextCursor")
        if not rows or meta.get("hasMore") is False or (meta.get("totalPages") is not None and page >= int(meta["totalPages"])):
            finished=True
            break
        if new == 0:
            raise ProviderError("Источник повторяет страницы: полнота истории не подтверждена")
        if next_cursor:
            if cursor == next_cursor:
                raise ProviderError("XTracker повторяет курсор")
            cursor = next_cursor
    if not finished:
        raise ProviderError("Достигнут предел страниц XTracker: результат не импортирован")
    counts = {start+timedelta(hours=i):0 for i in range(days*24)}
    retained = 0
    for post in posts.values():
        raw_time = post.get("createdAt",post.get("created_at"))
        if not isinstance(raw_time,str):
            raise ProviderError("Нет временной метки публикации")
        dt = parse_time(raw_time)
        kind = post_kind(post)
        if (kind=="reply" and not include_replies) or (kind=="repost" and not include_reposts):
            continue
        if start <= dt < end:
            counts[hour(dt)] += 1
            retained += 1
    if not retained:
        raise ProviderError("Источник вернул пустую историю; нулевое покрытие не сохранено")
    return {"rows":list(counts.items()),"posts":retained,"start":start.isoformat(),"end":end.isoformat(),
        "notice":"Проверьте полноту источника за весь интервал и соответствие типов публикаций правилам рынка. API XTracker не гарантирует полноту истории."}
