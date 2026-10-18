"""Explicit hourly coverage: an absent hour is never silently treated as zero."""
import csv
import io
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

UTC = timezone.utc


def parse_time(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("Время должно содержать часовой пояс: Z или +03:00")
    return dt.astimezone(UTC)


def hour(dt: datetime) -> datetime:
    return dt.astimezone(UTC).replace(minute=0, second=0, microsecond=0)


class Store:
    def __init__(self, path=None):
        self.path = Path(path or os.environ.get("TWEET_DB", "data/tweets.sqlite3"))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS hours (
                  dataset TEXT, ts TEXT, count INTEGER NOT NULL CHECK(count>=0),
                  source TEXT NOT NULL, PRIMARY KEY(dataset,ts));
                CREATE TABLE IF NOT EXISTS metadata (
                  key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS snapshots (
                  slug TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL);
            """)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.execute("PRAGMA journal_mode=WAL")
        return db

    def save_hours(self, rows, dataset="live", source="csv"):
        # Validate everything before mutating the database.
        records = []
        seen = set()
        cutoff = hour(datetime.now(UTC))
        for dt, count in rows:
            dt = dt.astimezone(UTC)
            if dt != hour(dt) or dt >= cutoff:
                raise ValueError("Допустимы только завершённые часы с началом HH:00:00 UTC")
            if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= 10000:
                raise ValueError("count должен быть целым числом от 0 до 10000")
            ts = dt.isoformat()
            if ts in seen:
                raise ValueError("В файле повторяется час: " + ts)
            seen.add(ts)
            records.append((dataset, ts, count, source))
        if not records:
            raise ValueError("Нет завершённых часов для импорта")
        with self.connect() as db:
            db.executemany("INSERT INTO hours VALUES (?,?,?,?) ON CONFLICT(dataset,ts) DO UPDATE SET count=excluded.count, source=excluded.source", records)
            db.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", (dataset + ":updated", datetime.now(UTC).isoformat()))
        return len(records)

    def load(self, dataset="live"):
        with self.connect() as db:
            rows = db.execute("SELECT ts,count FROM hours WHERE dataset=? ORDER BY ts", (dataset,)).fetchall()
            sources = db.execute("SELECT DISTINCT source FROM hours WHERE dataset=?", (dataset,)).fetchall()
        return {parse_time(ts): count for ts, count in rows}, [r[0] for r in sources]

    def snapshot(self, slug, payload):
        import json
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO snapshots VALUES (?,?,?)", (slug, json.dumps(payload), datetime.now(UTC).isoformat()))


def read_csv(content: str):
    reader = csv.DictReader(io.StringIO(content.lstrip("\ufeff")))
    if not reader.fieldnames or not {"timestamp", "count"}.issubset(reader.fieldnames):
        raise ValueError("Нужны столбцы timestamp,count. Каждая строка — полный час, включая нулевые часы.")
    rows = []
    for i, row in enumerate(reader, start=2):
        try:
            rows.append((parse_time(row["timestamp"]), int(row["count"])))
        except (ValueError, TypeError, KeyError) as exc:
            raise ValueError(f"Некорректная строка CSV {i}: {exc}") from exc
    return rows
