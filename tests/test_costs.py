from datetime import date

import pytest

from app.strategy.engine import DatedCosts


def by_hand(price, qty, is_buy, stt_pct, exch_pct=0.03503):
    turnover = price * qty
    brokerage, exchange, sebi = 20.0, exch_pct / 100 * turnover, 0.0001 / 100 * turnover
    stt = 0 if is_buy else stt_pct / 100 * turnover
    stamp = 0.003 / 100 * turnover if is_buy else 0
    return brokerage + stt + exchange + sebi + stamp + 0.18 * (brokerage + exchange + sebi)


@pytest.mark.parametrize("day,stt,exch", [(date(2023, 3, 31), 0.05, 0.0495), (date(2024, 9, 30), 0.0625, 0.0495),
                                          (date(2025, 6, 2), 0.1, 0.03503), (date(2026, 3, 31), 0.1, 0.03503),
                                          (date(2026, 4, 1), 0.15, 0.03503)])
def test_sell_order_uses_dated_stt(fake_store, day, stt, exch):
    fake_store()
    c = DatedCosts(20, 0.5, True)
    assert c.order(100, 65, False, day) == pytest.approx(by_hand(100, 65, False, stt, exch))


def test_buy_order_pays_stamp_not_stt(fake_store):
    fake_store()
    c = DatedCosts(20, 0.5, True)
    assert c.order(100, 65, True, date(2026, 5, 4)) == pytest.approx(by_hand(100, 65, True, 0.15))


def test_taxes_off_is_brokerage_only(fake_store):
    fake_store()
    assert DatedCosts(20, 0.5, False).order(100, 65, False, date(2026, 5, 4)) == 20


def test_futures_use_futures_rates_and_slippage(fake_store):
    fake_store()
    c = DatedCosts(20, 0.5, True, fut_slippage=1.0)
    turnover = 25000 * 65
    exch, sebi = 0.00173 / 100 * turnover, 0.0001 / 100 * turnover
    expected = 20 + 0.05 / 100 * turnover + exch + sebi + 0.18 * (20 + exch + sebi)  # sell, after 1 Apr 2026
    assert c.order(25000, 65, False, date(2026, 5, 4), fut=True) == pytest.approx(expected)
    from app.strategy.spec import Leg
    assert c.slip(Leg(id="f", action="buy", instrument="FUT")) == 1.0
    assert c.slip(Leg(id="o", action="buy", instrument="CE")) == 0.5
