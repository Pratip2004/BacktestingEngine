from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BASE_DIR / ".env", extra="ignore")

    app_name: str = Field("BacktestingEngine", alias="APP_NAME")
    api_key: str = Field(..., alias="API_KEY")
    # The .env spells it "SECRECT"; keep that name so existing files work.
    api_secret: str = Field(..., alias="API_SECRECT_KEY")
    # Optional: a session token from today's login. It can also be set at runtime via /auth/session.
    session_token: str | None = Field(None, alias="BREEZE_SESSION_TOKEN")
    # Where /auth/callback sends the browser after login.
    frontend_url: str = Field("http://localhost:5173", alias="FRONTEND_URL")
    # Where the active session token is cached so a restart on the same day doesn't need a new login.
    session_file: Path = BASE_DIR / ".breeze_session"


@lru_cache
def get_settings() -> Settings:
    return Settings()
