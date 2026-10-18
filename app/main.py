import csv
import io
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .demo import demo_event, demo_hours
from .model import forecast
from .providers import collect_posts, fetch_event, slug_from
from .storage import Store, UTC, read_csv
from .trading import evaluate
from .x_api import collect_x, credentials_present

app = FastAPI(title="TweetScope", docs_url=None, redoc_url=None)
store = Store()
staged = {}
STATIC = Path(__file__).parent/"static"


@app.middleware("http")
async def local_security(request: Request, call_next):
    if request.method not in {"GET","HEAD","OPTIONS"}:
        origin = request.headers.get("origin")
        if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
            return Response("Cross-origin requests are not allowed", status_code=403)
        length = request.headers.get("content-length")
        if length and (not length.isdigit() or int(length)>6_000_000):
            return Response("Request too large",status_code=413)
    result = await call_next(request)
    result.headers["X-Content-Type-Options"] = "nosniff"
    result.headers["Referrer-Policy"] = "no-referrer"
    result.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    result.headers["Cache-Control"] = "no-store"
    return result


@app.exception_handler(ValueError)
async def invalid(request, exc):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=400, content={"detail":str(exc)})


@app.get("/")
def index():
    return FileResponse(STATIC/"index.html")


@app.get("/api/docs",include_in_schema=False)
def api_docs():
    return FileResponse(STATIC/"api.html")


@app.get("/api/health")
def health():
    return {"status":"ok"}


@app.get("/api/status")
def status():
    result = {}
    for dataset in ["live","demo"]:
        data, sources = store.load(dataset)
        result[dataset] = {"hours":len(data),"posts":sum(data.values()),"sources":sources,
            "start":min(data).isoformat() if data else None,
            "end":(max(data)+timedelta(hours=1)).isoformat() if data else None}
    result["x_api"] = {"credentials_present":credentials_present()}
    return result


class CSVImport(BaseModel):
    content: str = Field(max_length=5_000_000)
    coverage_confirmed: bool = False


@app.post("/api/import")
def import_csv(body: CSVImport):
    if not body.coverage_confirmed:
        raise ValueError("Подтвердите полноту часов и соответствие правилам подсчёта")
    n = store.save_hours(read_csv(body.content))
    return {"imported_hours":n}


@app.get("/api/export")
def export_csv():
    data,_ = store.load("live")
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["timestamp","count"])
    writer.writerows((t.isoformat(),c) for t,c in data.items())
    return Response(output.getvalue(),media_type="text/csv",headers={"Content-Disposition":"attachment; filename=tweets-hourly.csv"})


@app.post("/api/demo")
def demo():
    store.save_hours(demo_hours(),"demo","synthetic")
    return demo_event()


@app.get("/api/event")
async def event(url: str):
    result = await fetch_event(slug_from(url))
    store.snapshot(result["slug"],result)
    return result


class CollectRequest(BaseModel):
    source: str = Field(default="x",pattern="^(x|xtracker)$")
    mode: str = Field(default="archive",pattern="^(archive|timeline)$")
    days: int = Field(default=90,ge=15,le=120)
    include_replies: bool = False
    include_reposts: bool = True


@app.post("/api/collect")
async def collect(body: CollectRequest):
    if body.source=="x":
        result = await collect_x(body.days,body.include_replies,body.include_reposts,body.mode)
    else:
        result = await collect_posts(body.days,body.include_replies,body.include_reposts)
    expired = [k for k,v in staged.items() if time.monotonic()-v["created"]>1800]
    for key in expired:
        staged.pop(key,None)
    if len(staged)>=10:
        staged.pop(next(iter(staged)))
    key = uuid.uuid4().hex
    staged[key] = {"created":time.monotonic(),"rows":result.pop("rows"),"config":body.model_dump()}
    return {**result,"preview_id":key,"hours":len(staged[key]["rows"])}


class ConfirmCollection(BaseModel):
    preview_id: str = Field(max_length=40)
    coverage_confirmed: bool = False


@app.post("/api/collect/confirm")
def confirm(body: ConfirmCollection):
    item = staged.get(body.preview_id)
    if not item or time.monotonic()-item["created"]>1800:
        raise ValueError("Предпросмотр истёк. Повторите сбор.")
    if not body.coverage_confirmed:
        raise ValueError("Подтвердите полноту источника и правила")
    config = item["config"]
    source = f"{config['source']}:{config['mode'] if config['source']=='x' else 'public'}:replies={int(config['include_replies'])}:reposts={int(config['include_reposts'])}"
    n = store.save_hours(item["rows"],source=source)
    staged.pop(body.preview_id,None)
    return {"imported_hours":n}


def local_time(value, timezone):
    try:
        zone = ZoneInfo(timezone)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("Неизвестный часовой пояс IANA") from exc
    dt = datetime.fromisoformat(value.replace("Z","+00:00"))
    if dt.tzinfo:
        return dt.astimezone(UTC)
    localized = dt.replace(tzinfo=zone)
    if localized.astimezone(UTC).astimezone(zone).replace(tzinfo=None) != dt:
        raise ValueError("Такого локального времени нет из-за перевода часов")
    if localized.utcoffset() != dt.replace(tzinfo=zone,fold=1).utcoffset():
        raise ValueError("Неоднозначное время при переводе часов: задайте ISO-время с UTC-смещением через API")
    return localized.astimezone(UTC)


class AnalyzeRequest(BaseModel):
    dataset: str = Field(default="live",pattern="^(live|demo)$")
    event_url: str = Field(default="",max_length=500)
    start: str = Field(max_length=40)
    end: str = Field(max_length=40)
    timezone: str = Field(default="America/New_York",max_length=80)
    budget: float = Field(default=100,ge=1,le=1_000_000,allow_inf_nan=False)
    expense_bps: float = Field(default=100,ge=0,le=5000,allow_inf_nan=False)
    safety_pp: float = Field(default=5,ge=0,le=50,allow_inf_nan=False)
    rules_confirmed: bool = False


@app.post("/api/analyze")
def analyze(body: AnalyzeRequest):
    # CPU work runs in FastAPI's worker pool; public I/O has its own async endpoint.
    data,sources = store.load(body.dataset)
    start,end = local_time(body.start,body.timezone),local_time(body.end,body.timezone)
    draws,result = forecast(data,start,end,body.timezone)
    result.update({"dataset":body.dataset,"sources":sources,"start":start.isoformat(),"end":end.isoformat(),
        "generated_at":datetime.now(UTC).isoformat(),"positions":[],"event":None})
    if body.dataset=="demo":
        market = demo_event()
        matches = start==local_time(market["start"],market["timezone"]) and end==local_time(market["end"],market["timezone"])
        if not matches:
            result["warnings"].append("Период отличается от демонстрационного рынка: показан только прогноз, без оценки позиций.")
            return result
    elif body.event_url:
        slug = slug_from(body.event_url)
        import json
        with store.connect() as db:
            row = db.execute("SELECT payload FROM snapshots WHERE slug=?",(slug,)).fetchone()
        if not row:
            raise ValueError("Сначала загрузите рынок кнопкой «Загрузить рынок»")
        market = json.loads(row[0])
    else:
        return result
    result["event"] = market
    if any(source.startswith("x:") for source in sources):
        result["warnings"].append("История API X может расходиться с Post Counter: удалённые публикации и ответы в основной ленте требуют отдельной сверки по правилам рынка.")
    eligible = body.rules_confirmed and result["fresh"]
    result["positions"] = evaluate(draws,market,body.budget,body.expense_bps,body.safety_pp,eligible)
    mass = sum(float(((draws>=m["lower"]) & ((draws<=m["upper"]) if m["upper"] is not None else True)).mean()) for m in market["markets"])
    if mass < .999:
        result["warnings"].append(f"Диапазоны рынка покрывают {mass:.1%} модельной вероятности. Часть исходов не загружена.")
    if not body.rules_confirmed:
        result["warnings"].append("Подтвердите период и правила рынка, чтобы включить сигналы.")
    if any(m.get("fees_enabled") for m in market["markets"]):
        result["warnings"].append("На рынке включены комиссии. Указанный резерв расходов — ваша оценка; проверьте фактическую ставку перед сделкой.")
    return result


app.mount("/static",StaticFiles(directory=STATIC),name="static")
