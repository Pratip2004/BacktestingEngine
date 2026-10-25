"""Saved strategies (.data/strategies/{id}.json), versioned: every save of an existing strategy adds a
version, and runs record which spec they used, so old results stay reproducible."""

import json
import threading
import uuid
from datetime import datetime

from fastapi import HTTPException

from app.config import BASE_DIR

DIR = BASE_DIR / ".data" / "strategies"
_lock = threading.Lock()


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _path(sid: str):
    return DIR / f"{sid}.json"


def _meta(doc: dict) -> dict:
    spec = doc["spec"]
    e = spec.get("schedule", {}).get("entry", {})
    p = spec.get("position", {})
    legs = len(p.get("legs") or p.get("bullish") or [])
    return {"id": doc["id"], "name": spec.get("name"), "underlying": spec.get("underlying"), "version": doc["version"],
            "created_at": doc["created_at"], "updated_at": doc["updated_at"], "template": doc.get("template"),
            "entry": e.get("type", "time"), "legs": legs}


def list_all() -> list[dict]:
    if not DIR.exists():
        return []
    docs = [json.loads(p.read_text()) for p in DIR.glob("*.json")]
    return sorted((_meta(d) for d in docs), key=lambda m: m["updated_at"], reverse=True)


def get(sid: str) -> dict:
    p = _path(sid)
    if not p.exists():
        raise HTTPException(404, "Strategy not found")
    return json.loads(p.read_text())


def create(spec: dict, template: str | None = None) -> dict:
    sid = uuid.uuid4().hex[:10]
    doc = {"id": sid, "version": 1, "created_at": _now(), "updated_at": _now(), "template": template,
           "spec": spec, "versions": [{"version": 1, "saved_at": _now(), "spec": spec}]}
    with _lock:
        DIR.mkdir(parents=True, exist_ok=True)
        _path(sid).write_text(json.dumps(doc))
    return doc


def update(sid: str, spec: dict) -> dict:
    with _lock:
        doc = get(sid)
        if spec == doc["spec"]:
            return doc
        doc["version"] += 1
        doc["spec"], doc["updated_at"] = spec, _now()
        doc["versions"].append({"version": doc["version"], "saved_at": _now(), "spec": spec})
        _path(sid).write_text(json.dumps(doc))
    return doc


def delete(sid: str) -> None:
    with _lock:
        p = _path(sid)
        if not p.exists():
            raise HTTPException(404, "Strategy not found")
        p.unlink()
