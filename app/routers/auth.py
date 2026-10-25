from urllib.parse import parse_qs, urlencode

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.breeze_client import breeze
from app.config import get_settings

router = APIRouter(prefix="/auth", tags=["auth"])


class SessionIn(BaseModel):
    session_token: str


@router.get("/login-url")
def login_url():
    """Open this in a browser and log in. ICICI redirects to your app's redirect URL with ?apisession=<token>."""
    return {"login_url": breeze.login_url}


@router.api_route("/callback", methods=["GET", "POST"])
async def callback(request: Request):
    """Redirect target for the ICICI app (http://127.0.0.1:8000/auth/callback).

    Accepts the token as ?apisession= or as a form POST field, then sends the browser to the dashboard.
    """
    token = request.query_params.get("apisession")
    if not token and request.method == "POST":
        form = parse_qs((await request.body()).decode())
        token = next((v[0] for k, v in form.items() if k.lower() in ("apisession", "api_session")), None)
    dashboard = f"{get_settings().frontend_url}/session"
    if not token:
        return RedirectResponse(f"{dashboard}?{urlencode({'error': 'No apisession in redirect'})}", status_code=303)
    try:
        # connect() calls Breeze; run it off the event loop so a slow Breeze can't freeze the server.
        await run_in_threadpool(breeze.connect, token)
    except HTTPException as exc:
        return RedirectResponse(f"{dashboard}?{urlencode({'error': exc.detail})}", status_code=303)
    return RedirectResponse(f"{dashboard}?connected=1", status_code=303)


@router.post("/session")
def set_session(body: SessionIn):
    """Paste the apisession value by hand if the redirect URL isn't this server."""
    return {"connected": True, "customer": breeze.connect(body.session_token)}


@router.get("/status")
def status():
    return {
        "connected": breeze.is_connected,
        "connected_at": breeze.connected_at,
        "login_url": None if breeze.is_connected else breeze.login_url,
    }
