"""Official X API v2, application bearer auth, read-only endpoints."""
import os
from datetime import datetime, timedelta

import httpx

from .providers import ProviderError
from .storage import UTC, hour, parse_time


def credentials_present():
    return bool(os.environ.get("X_BEARER_TOKEN") or os.environ.get("TWITTER_BEARER_TOKEN"))


async def x_get(client, path, params=None):
    try:
        response = await client.get("https://api.x.com"+path,params=params)
    except httpx.HTTPError as exc:
        raise ProviderError("API X недоступен. Проверьте сетевой доступ к api.x.com.") from exc
    if response.status_code==401:
        raise ProviderError("API X отклонил авторизацию. Проверьте Bearer Token в защищённых настройках среды.")
    if response.status_code in {402,403}:
        raise ProviderError("Тариф или разрешения API X не позволяют этот запрос. Проверьте доступ к архиву; для ограниченного тарифа выберите ленту пользователя.")
    if response.status_code==429:
        raise ProviderError("Лимит API X исчерпан. Дождитесь сброса лимита тарифа и повторите сбор; неполная история не импортирована.")
    if response.status_code>=400:
        raise ProviderError(f"API X вернул HTTP {response.status_code}. Проверьте параметры и разрешения приложения.")
    try:
        payload=response.json()
    except ValueError as exc:
        raise ProviderError("API X вернул неверный JSON") from exc
    if not isinstance(payload,dict) or payload.get("errors"):
        raise ProviderError("API X сообщил об ошибке или частичном результате; история не импортирована.")
    return payload


async def collect_x(days, include_replies, include_reposts, mode="archive", client=None):
    if client is None:
        token=os.environ.get("X_BEARER_TOKEN") or os.environ.get("TWITTER_BEARER_TOKEN")
        if not token:
            raise ProviderError("Не настроен X_BEARER_TOKEN. Добавьте Bearer Token в секреты среды, затем повторите сбор. Не отправляйте ключ в чат.")
        async with httpx.AsyncClient(timeout=30,follow_redirects=False,headers={"Authorization":"Bearer "+token,"User-Agent":"TweetScope/1.0"}) as c:
            return await collect_x(days,include_replies,include_reposts,mode,c)
    end=hour(datetime.now(UTC))
    start=end-timedelta(days=days)
    if mode=="timeline":
        user=await x_get(client,"/2/users/by/username/elonmusk")
        uid=(user.get("data") or {}).get("id")
        if not uid or not str(uid).isdigit():
            raise ProviderError("API X не вернул ID пользователя elonmusk")
        path=f"/2/users/{uid}/tweets"
        # Fetch unfiltered posts past the left boundary to prove coverage despite
        # the user-timeline cap. No start_time: an older sentinel is necessary.
        params={"end_time":end.strftime("%Y-%m-%dT%H:%M:%SZ"),"max_results":100,"tweet.fields":"created_at,referenced_tweets"}
    elif mode=="archive":
        path="/2/tweets/search/all"
        params={"query":"from:elonmusk","start_time":start.strftime("%Y-%m-%dT%H:%M:%SZ"),"end_time":end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "max_results":500,"tweet.fields":"created_at,referenced_tweets"}
    else:
        raise ProviderError("Неизвестный режим API X")
    counts={start+timedelta(hours=i):0 for i in range(days*24)}
    seen=set(); cursors=set(); retained=0; reached_start=False
    for _ in range(100):
        payload=await x_get(client,path,params)
        rows=payload.get("data",[])
        meta=payload.get("meta",{})
        if not isinstance(rows,list) or not isinstance(meta,dict):
            raise ProviderError("Неподдерживаемая структура ответа API X")
        new=0
        for post in rows:
            if not isinstance(post,dict) or not post.get("id") or not post.get("created_at"):
                raise ProviderError("В ответе API X нет ID или created_at")
            pid=str(post["id"])
            if pid in seen: continue
            seen.add(pid);new+=1
            dt=parse_time(post["created_at"])
            reached_start = reached_start or dt <= start
            references=post.get("referenced_tweets",[])
            if not isinstance(references,list) or any(not isinstance(r,dict) for r in references):
                raise ProviderError("API X вернул неверные типы ссылок публикации")
            kinds={r.get("type") for r in references}
            if ("replied_to" in kinds and not include_replies) or ("retweeted" in kinds and not include_reposts):
                continue
            if start <= dt < end:
                counts[hour(dt)]+=1;retained+=1
        cursor=meta.get("next_token")
        if mode=="timeline" and reached_start:
            break
        if not cursor:
            if mode=="timeline" and not reached_start:
                raise ProviderError("Лента X закончилась до начала запрошенного периода (лимит последних публикаций). Нужен полный архив, более короткий период или подтверждённая история CSV. Нулевые часы не сохранены.")
            break
        if not isinstance(cursor,str) or cursor in cursors or new==0:
            raise ProviderError("API X повторяет страницы или вернул неверную пагинацию")
        cursors.add(cursor)
        params["pagination_token" if mode=="timeline" else "next_token"]=cursor
    else:
        raise ProviderError("Превышен предел 100 страниц API X. История не импортирована.")
    if not retained:
        raise ProviderError("API X вернул пустую историю. Проверьте доступ и период; нулевые часы не сохранены.")
    return {"rows":list(counts.items()),"posts":retained,"start":start.isoformat(),"end":end.isoformat(),
        "notice":f"Источник: официальный API X ({mode}). Проверьте соответствие типов публикаций правилам рынка. Удалённые публикации могут отсутствовать в API и учитываться источником разрешения иначе."}
