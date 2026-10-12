import os
from pydantic_settings import BaseSettings
from typing import List, Optional

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class Settings(BaseSettings):
    APP_NAME: str = "AI-Powered Smart Email Assistant"
    PORT: int = 8000
    HOST: str = "0.0.0.0"
    
    # Environment & Demo settings
    DEMO_MODE: bool = True
    ENVIRONMENT: str = "development"

    @property
    def is_demo(self) -> bool:
        return self.DEMO_MODE

    
    # Security
    JWT_SECRET: str = "smart_email_secret_key_change_in_production_2026_jwt_token"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440  # 24 hours
    
    # Google OAuth
    GOOGLE_CLIENT_ID: Optional[str] = ""
    GOOGLE_CLIENT_SECRET: Optional[str] = ""
    GOOGLE_REDIRECT_URI: str = "http://localhost:8000/api/auth/callback"
    
    # Gemini AI
    GEMINI_API_KEY: Optional[str] = ""
    
    # Supabase Database
    SUPABASE_URL: Optional[str] = ""
    SUPABASE_KEY: Optional[str] = ""
    SUPABASE_ANON_KEY: Optional[str] = ""
    SUPABASE_SECRET_KEY: Optional[str] = ""

    @property
    def effective_supabase_key(self) -> str:
        return self.SUPABASE_KEY or self.SUPABASE_SECRET_KEY or self.SUPABASE_ANON_KEY or ""


    @property
    def supabase_base_url(self) -> str:
        if not self.SUPABASE_URL:
            return ""
        url = self.SUPABASE_URL.strip()
        if url.endswith("/rest/v1/"):
            url = url[:-9]
        elif url.endswith("/rest/v1"):
            url = url[:-8]
        return url.rstrip("/")
    
    # Frontend URL for CORS & redirects
    FRONTEND_URL: str = "http://localhost:5173"
    # Exact origins. In the environment, as a JSON list:
    #   CORS_ORIGINS=["https://my-app.vercel.app","http://localhost:5173"]
    CORS_ORIGINS: List[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
    ]

    # Starlette matches allow_origins by exact string, so a value like
    # "https://*.vercel.app" matches nothing and silently allows nobody.
    # Deployment hostnames are not known in advance, so these two platforms
    # are matched by regex instead (applied in main.py).
    CORS_ORIGIN_REGEX: Optional[str] = (
        r"^https://[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$"
        r"|^https://[a-z0-9-]+(?:\.[a-z0-9-]+)*\.onrender\.com$"
        r"|^https://[a-z0-9-]+(?:\.[a-z0-9-]+)*\.railway\.app$"
    )

    class Config:
        # Resolve from the backend package rather than the process cwd. The
        # launcher is normally invoked from the repository root.
        env_file = os.path.join(BACKEND_DIR, ".env")
        extra = "allow"

settings = Settings()
