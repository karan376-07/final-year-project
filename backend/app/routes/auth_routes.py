import hashlib
from urllib.parse import urlencode
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from app.auth.auth_handler import create_access_token, create_token_for_user, get_current_user, DEMO_USER
from app.models.schemas import Token, UserProfile, GoogleLoginRequest, AuthConfigResponse, IMAPLoginRequest
from app.services.gmail_service import gmail_service
from app.services.imap_service import imap_service
from app.config import settings

router = APIRouter(prefix="/api/auth", tags=["Authentication"])

def _is_valid_live_google_config() -> bool:
    client_id = (settings.GOOGLE_CLIENT_ID or "").strip() if isinstance(settings.GOOGLE_CLIENT_ID, str) else ""
    client_secret = (settings.GOOGLE_CLIENT_SECRET or "").strip() if isinstance(settings.GOOGLE_CLIENT_SECRET, str) else ""
    if not client_id or not client_secret or client_id.startswith("your_"):
        return False
    return True

def _frontend_auth_error(error_code: str):
    allowed_errors = {
        "access_denied", "cancelled", "invalid_client", "invalid_grant",
        "invalid_request", "oauth_not_configured", "token_exchange_failed",
        "unauthorized_client", "userinfo_failed", "callback_error",
    }
    safe_code = error_code if error_code in allowed_errors else "auth_failed"
    query = urlencode({"error": safe_code})
    return RedirectResponse(url=f"{settings.FRONTEND_URL}/?{query}")

@router.get("/config", response_model=AuthConfigResponse)
def get_auth_config():
    """Returns the Google OAuth configuration status."""
    is_live = _is_valid_live_google_config()
    return AuthConfigResponse(
        google_client_id=settings.GOOGLE_CLIENT_ID or "",
        google_redirect_uri=settings.GOOGLE_REDIRECT_URI,
        is_live_configured=is_live,
        demo_mode=settings.DEMO_MODE
    )

@router.get("/login-url")
def get_login_url():
    """Get Google OAuth 2.0 authorization URL for real Google sign in."""
    is_live = _is_valid_live_google_config()
    return {
        "url": gmail_service.get_oauth_url() if is_live else None,
        "is_live_configured": is_live
    }

@router.post("/imap-login", response_model=Token)
async def imap_login(req: IMAPLoginRequest):
    """
    Authenticate and fetch real Gmail emails directly using Google App Password (IMAP SSL).
    """
    email_clean = req.email.strip().lower()
    username_part = email_clean.split("@")[0]
    name = " ".join([part.capitalize() for part in username_part.replace("_", ".").replace("-", ".").split(".")])
    seed = hashlib.md5(email_clean.encode()).hexdigest()[:8]
    avatar = f"https://api.dicebear.com/7.x/bottts/svg?seed={seed}"
    user_id = f"usr-imap-{seed}"

    try:
        # Trigger real Gmail IMAP sync
        res = await imap_service.fetch_real_emails_via_imap(
            user_email=email_clean,
            app_password=req.app_password,
            max_emails=35
        )
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    user_profile = UserProfile(
        id=user_id,
        email=email_clean,
        name=name,
        avatar=avatar,
        is_demo=False,
        connected_gmail=True
    )

    token = create_token_for_user(user_profile)
    return Token(access_token=token, token_type="bearer", user=user_profile)

@router.post("/demo-login", response_model=Token)
async def demo_login():
    """1-Click instant demo authentication token."""
    try:
        await gmail_service.sync_inbox(user_email=DEMO_USER.email, user_name=DEMO_USER.name)
    except Exception as e:
        print(f"[demo_login] Inbox sync notice: {e}")
    token = create_token_for_user(DEMO_USER)
    return Token(access_token=token, token_type="bearer", user=DEMO_USER)

@router.get("/callback")
async def oauth_callback(code: str = Query(None), error: str = Query(None)):
    """Handles Google OAuth callback redirect."""
    if error or not code:
        return _frontend_auth_error(error or "cancelled")
    
    # Live exchange with Google OAuth 2.0 servers
    if settings.GOOGLE_CLIENT_ID and settings.GOOGLE_CLIENT_SECRET:
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                token_res = await client.post(
                    "https://oauth2.googleapis.com/token",
                    data={
                        "code": code,
                        "client_id": settings.GOOGLE_CLIENT_ID,
                        "client_secret": settings.GOOGLE_CLIENT_SECRET,
                        "redirect_uri": settings.GOOGLE_REDIRECT_URI,
                        "grant_type": "authorization_code",
                    },
                    timeout=12.0
                )
                if token_res.status_code != 200:
                    try:
                        exchange_error = token_res.json().get("error", "token_exchange_failed")
                    except Exception:
                        exchange_error = "token_exchange_failed"
                    print(f"[OAuth Callback] Google token exchange failed: {exchange_error}")
                    return _frontend_auth_error(exchange_error)

                token_data = token_res.json()
                google_access_token = token_data.get("access_token")
                userinfo_res = await client.get(
                    "https://www.googleapis.com/oauth2/v2/userinfo",
                    headers={"Authorization": f"Bearer {google_access_token}"},
                    timeout=10.0
                )
                if userinfo_res.status_code != 200:
                    print(f"[OAuth Callback] Google user info failed: HTTP {userinfo_res.status_code}")
                    return _frontend_auth_error("userinfo_failed")

                g_info = userinfo_res.json()
                user_id = f"usr-g-{g_info.get('id', 'live')}"
                raw_g_email = g_info.get("email") if isinstance(g_info.get("email"), str) else "google.user@gmail.com"
                email = raw_g_email.strip().lower()
                raw_g_name = g_info.get("name")
                name = raw_g_name.strip() if (raw_g_name and isinstance(raw_g_name, str)) else email.split("@")[0]
                avatar = (g_info.get("picture") if isinstance(g_info.get("picture"), str) else None) or f"https://api.dicebear.com/7.x/bottts/svg?seed={email}"

                from app.database.db import db
                from app.services.gmail_service import gmail_service
                db.set_user_credentials(email, token_data)

                try:
                    await gmail_service.sync_inbox(user_email=email, user_name=name, credentials_dict=token_data)
                except Exception as sync_ex:
                    print(f"[OAuth Callback] Sync notice: {sync_ex}")

                user_profile = UserProfile(
                    id=user_id,
                    email=email,
                    name=name,
                    avatar=avatar,
                    is_demo=False,
                    connected_gmail=True
                )
                jwt_token = create_token_for_user(user_profile)
                return RedirectResponse(url=f"{settings.FRONTEND_URL}/?token={jwt_token}")
        except Exception as e:
            print(f"Live Google OAuth token exchange error: {e}")

    return _frontend_auth_error("oauth_not_configured" if not _is_valid_live_google_config() else "callback_error")

@router.get("/me", response_model=UserProfile)
def get_me(current_user: UserProfile = Depends(get_current_user)):
    """Get authenticated user profile."""
    return current_user
