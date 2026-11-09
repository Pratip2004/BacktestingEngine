import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.breeze_client import breeze
from app.config import get_settings
from app.data.ingest import start_background
from app.research import runner as research_runner
from app.routers import account, auth, backtest, data, market, options, portfolios, research, runs, strategies

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Restoring the session calls Breeze; in a thread, so a slow or silent Breeze can't block startup
    # (the server answers immediately and shows "logged out" until the restore finishes).
    threading.Thread(target=breeze.try_restore, name="breeze-restore", daemon=True).start()
    start_background()  # local data store: import old caches, downloader, nightly job
    research_runner.start()  # research ledger: re-queue interrupted experiments, run the queue
    yield


app = FastAPI(title=get_settings().app_name, lifespan=lifespan)
app.include_router(auth.router)
app.include_router(market.router)
app.include_router(account.router)
app.include_router(backtest.router)
app.include_router(options.router)
app.include_router(runs.router)
app.include_router(data.router)
app.include_router(strategies.router)
app.include_router(research.router)
app.include_router(portfolios.router)


@app.get("/")
def root():
    return {"message": "server is on", "breeze_connected": breeze.is_connected}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
