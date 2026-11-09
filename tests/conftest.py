"""Tests run while the server may hold the DuckDB lock, so store access is replaced with a small fake."""

from datetime import date

import pytest

from app.data.store import DEFAULT_COSTS, DEFAULT_FUT_COSTS

RATES = sorted(DEFAULT_COSTS, key=lambda r: r[0], reverse=True)
FUT_RATES = sorted(DEFAULT_FUT_COSTS, key=lambda r: r[0], reverse=True)


class FakeStore:
    def __init__(self, days=()):
        self.days = list(days)

    def settings(self):
        return {}

    def q(self, sql, params=()):
        if "fut_cost_schedule" in sql:
            return FUT_RATES
        if "cost_schedule" in sql:
            return RATES
        if "spot_1m" in sql:
            start, end = params[1], params[2]
            return [(d,) for d in self.days if start <= d <= end]
        raise AssertionError(f"unexpected query {sql}")


@pytest.fixture
def fake_store(monkeypatch):
    def install(days=()):
        store = FakeStore(days)
        import app.research.evaluate as ev
        import app.strategy.engine as eng
        monkeypatch.setattr(ev, "get_store", lambda: store)
        monkeypatch.setattr(eng, "get_store", lambda: store)
        return store
    return install


@pytest.fixture
def weekdays():
    def make(start: date, end: date):
        out, d = [], start
        while d <= end:
            if d.weekday() < 5:
                out.append(d)
            d = date.fromordinal(d.toordinal() + 1)
        return out
    return make
