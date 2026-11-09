import pytest
from fastapi import HTTPException

from app.research import ledger

SPEC = {"name": "x", "position": {"legs": [{"id": "ce", "action": "buy", "instrument": "CE"}]}}
P = [{"key": "is", "label": "In-sample", "role": "in_sample", "from": "2026-01-01", "to": "2026-06-30"}]


@pytest.fixture(autouse=True)
def tmp_ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "RESEARCH_DIR", tmp_path)
    monkeypatch.setattr(ledger, "EXP_DIR", tmp_path / "experiments")
    monkeypatch.setattr(ledger, "EVENTS", tmp_path / "events.jsonl")
    monkeypatch.setattr(ledger, "STATE", tmp_path / "state.json")


def test_exact_duplicate_is_refused_and_name_is_ignored():
    a = ledger.create({"name": "A", "spec": SPEC, "periods": [dict(p) for p in P]})
    with pytest.raises(HTTPException) as exc:
        ledger.create({"name": "B", "spec": {**SPEC, "name": "renamed"}, "periods": [dict(p) for p in P]})
    assert exc.value.status_code == 409 and a["id"] in exc.value.detail


def test_exit_variant_is_same_family_but_not_duplicate():
    a = ledger.create({"name": "A", "spec": SPEC, "periods": [dict(p) for p in P]})
    variant = {**SPEC, "exits": {"combined": {"target": {"unit": "pct", "value": 30}}}}
    b = ledger.create({"name": "B", "spec": variant, "periods": [dict(p) for p in P]})
    assert a["economic_key"] == b["economic_key"]
    assert a["periods"][0]["fingerprint"] != b["periods"][0]["fingerprint"]
    assert b["similar"][0]["id"] == a["id"]


def test_cost_override_changes_fingerprint():
    stressed = [{**P[0], "key": "stress", "cost_overrides": {"slippage_points": 1.0}}]
    assert ledger.fingerprint(SPEC, P[0]) != ledger.fingerprint(SPEC, stressed[0])


def test_result_reuse_and_restart_recovery():
    a = ledger.create({"name": "A", "spec": SPEC, "periods": [dict(p) for p in P]})
    a["results"]["is"] = {"fingerprint": a["periods"][0]["fingerprint"], "run_id": "r1"}
    a["status"] = "running"
    ledger.save(a)
    assert ledger.find_result(a["periods"][0]["fingerprint"])[0] == a["id"]
    assert ledger.recover_interrupted() == 1
    assert ledger.get(a["id"])["status"] == "queued"
