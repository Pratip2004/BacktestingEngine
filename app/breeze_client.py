"""Owns the single BreezeConnect instance and its daily session."""

import logging
import time
from datetime import datetime, timedelta
from threading import Lock
from typing import Any, Callable
from urllib.parse import quote_plus

import pandas as pd
import requests
import breeze_connect.breeze_connect as breeze_sdk
from breeze_connect import BreezeConnect
from fastapi import HTTPException

from app.config import get_settings

log = logging.getLogger(__name__)

LOGIN_URL = "https://api.icicidirect.com/apiuser/login?api_key={}"
BREEZE_TIMEOUT = (10, 30)  # seconds to connect, seconds to wait for a response


class _RequestsWithTimeout:
    """Stands in for the `requests` module inside breeze-connect, which never passes a timeout:
    a Breeze server that doesn't answer would otherwise block the calling thread forever."""

    def __init__(self, timeout):
        self._timeout = timeout

    def __getattr__(self, name):
        return getattr(requests, name)

    def _with_timeout(self, fn, *args, **kwargs):
        kwargs.setdefault("timeout", self._timeout)
        return fn(*args, **kwargs)

    def get(self, *args, **kwargs):
        return self._with_timeout(requests.get, *args, **kwargs)

    def post(self, *args, **kwargs):
        return self._with_timeout(requests.post, *args, **kwargs)

    def put(self, *args, **kwargs):
        return self._with_timeout(requests.put, *args, **kwargs)

    def delete(self, *args, **kwargs):
        return self._with_timeout(requests.delete, *args, **kwargs)


breeze_sdk.requests = _RequestsWithTimeout(BREEZE_TIMEOUT)
MIN_CALL_INTERVAL = 0.65  # seconds, ≈92 calls/minute

# get_historical_data_v2 returns at most 1000 candles per call, so long ranges are fetched in chunks.
MAX_CANDLES = 1000
INTERVAL_SPAN = {
    "1second": timedelta(seconds=1),
    "1minute": timedelta(minutes=1),
    "5minute": timedelta(minutes=5),
    "30minute": timedelta(minutes=30),
    "1day": timedelta(days=1),
}
INTRADAY_BARS_PER_DAY = {"1minute": 376, "5minute": 76, "30minute": 13}
NUMERIC_COLUMNS =["open", "high", "low", "close", "volume", "open_interest"]


def to_breeze_date(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


class BreezeManager:
    def __init__(self) -> None:
        self.settings = get_settings()
        self._client: BreezeConnect | None = None
        self._lock = Lock()
        self._rate_lock = Lock()
        self._last_call = 0.0
        # Called once per Breeze request; the data store uses it to count calls against the daily budget.
        self.on_call: Callable[[], None] | None = None
        self.connected_at: datetime | None = None

    @property
    def login_url(self) -> str:
        return LOGIN_URL.format(quote_plus(self.settings.api_key))

    @property
    def is_connected(self) -> bool:
        return self._client is not None

    def connect(self, session_token: str) -> dict:
        """Exchange the daily session token (apisession) for an authenticated client."""
        client = BreezeConnect(api_key=self.settings.api_key)
        try:
            client.generate_session(api_secret=self.settings.api_secret, session_token=session_token)
        except Exception as exc:
            raise HTTPException(401, f"Breeze session generation failed: {exc}") from exc
        with self._lock:
            self._client = client
            self.connected_at = datetime.now()
        self.settings.session_file.write_text(session_token)
        return self.customer_details(session_token)

    def try_restore(self) -> None:
        """On startup, reuse a token from .env or the cache file. Tokens expire daily, so failure is expected."""
        for token in (self.settings.session_token, self._cached_token()):
            if not token:
                continue
            try:
                self.connect(token)
                log.info("Restored Breeze session")
                return
            except HTTPException as exc:
                log.warning("Could not restore Breeze session: %s", exc.detail)
        log.info("No Breeze session. Open %s to log in.", self.login_url)

    def _cached_token(self) -> str | None:
        f = self.settings.session_file
        return f.read_text().strip() if f.exists() else None

    @property
    def client(self) -> BreezeConnect:
        if self._client is None:
            raise HTTPException(401, f"Not logged in to Breeze. Log in at {self.login_url} and POST the apisession to /auth/session")
        return self._client

    # Breeze returns {"Success": ..., "Status": 200, "Error": ...}; unwrap it or raise.
    @staticmethod
    def unwrap(resp: Any) -> Any:
        if not isinstance(resp, dict):
            raise HTTPException(502, f"Unexpected Breeze response: {resp!r}")
        if resp.get("Status") != 200 or resp.get("Error"):
            raise HTTPException(502, f"Breeze error: {resp.get('Error') or resp}")
        return resp.get("Success")

    def call(self, method: str, **kwargs: Any) -> Any:
        client = self.client
        # Breeze allows ~100 calls/minute; space calls out so batch jobs don't hit the limit.
        with self._rate_lock:
            wait = self._last_call + MIN_CALL_INTERVAL - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last_call = time.monotonic()
        if self.on_call:
            try:
                self.on_call()
            except Exception:  # counting must never break a request
                log.exception("on_call hook failed")
        return self.unwrap(getattr(client, method)(**kwargs))

    def customer_details(self, session_token: str) -> dict:
        return self.call("get_customer_details", api_session=session_token)

    def historical_df(
        self,
        stock_code: str,
        exchange_code: str,
        interval: str,
        from_date: datetime,
        to_date: datetime,
        product_type: str = "cash",
        expiry_date: datetime | None = None,
        right: str = "",
        strike_price: str = "",
    ) -> pd.DataFrame:
        """Fetch OHLCV candles via get_historical_data_v2, chunking past the 1000-candle limit."""
        if interval not in INTERVAL_SPAN:
            raise HTTPException(422, f"interval must be one of {list(INTERVAL_SPAN)}")
        chunk = INTERVAL_SPAN[interval] * MAX_CANDLES
        if interval in INTRADAY_BARS_PER_DAY:
            # Markets trade ~375 min/day on weekdays, so 1000 candles span far more calendar time
            # than 1000 × interval. Size chunks in trading days, with slack for weekends.
            trading_days = MAX_CANDLES // INTRADAY_BARS_PER_DAY[interval]
            chunk = max(timedelta(days=1), timedelta(days=trading_days * 7 // 5 - 2))
        frames, start = [], from_date
        while start < to_date:
            end = min(start + chunk, to_date)
            rows = self.call(
                "get_historical_data_v2",
                interval=interval,
                from_date=to_breeze_date(start),
                to_date=to_breeze_date(end),
                stock_code=stock_code,
                exchange_code=exchange_code,
                product_type=product_type,
                expiry_date=to_breeze_date(expiry_date) if expiry_date else "",
                right=right,
                strike_price=strike_price,
            )
            if rows:
                frames.append(pd.DataFrame(rows))
            start = end

        if not frames:
            return pd.DataFrame(columns=["datetime", *NUMERIC_COLUMNS[:5]])
        df = pd.concat(frames, ignore_index=True)
        df["datetime"] = pd.to_datetime(df["datetime"])
        for col in NUMERIC_COLUMNS:
            if col in df:
                df[col] = pd.to_numeric(df[col], errors="coerce")
        return df.drop_duplicates("datetime").sort_values("datetime").reset_index(drop=True)


breeze = BreezeManager()
