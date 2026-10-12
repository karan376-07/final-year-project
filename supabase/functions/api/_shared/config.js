/**
 * Shared modules for the Supabase Edge Function.
 *
 * These were written for a Node Express server on Cloud Functions. Deno is
 * close enough that most logic ports directly; the differences are the
 * imports (Deno URLs, not npm) and the absence of a process.env you control.
 */
/** Environment, read the way Deno exposes it. */
export const env = {
    get(name, fallback = "") {
        return Deno.env.get(name) ?? fallback;
    },
    num(name, fallback) {
        const v = Deno.env.get(name);
        if (!v)
            return fallback;
        const n = Number.parseInt(v, 10);
        return Number.isFinite(n) ? n : fallback;
    },
    bool(name, fallback) {
        const v = Deno.env.get(name);
        if (!v)
            return fallback;
        return ["1", "true", "yes", "on"].includes(v.toLowerCase());
    },
};
export const config = {
    ENVIRONMENT: env.get("ENVIRONMENT", "development"),
    DEMO_MODE: env.bool("DEMO_MODE", false),
    JWT_SECRET: env.get("JWT_SECRET", "smart_email_secret_key_change_in_production_2026_jwt_token"),
    JWT_ALGORITHM: "HS256",
    ACCESS_TOKEN_EXPIRE_MINUTES: env.num("ACCESS_TOKEN_EXPIRE_MINUTES", 1440),
    GOOGLE_CLIENT_ID: env.get("GOOGLE_CLIENT_ID"),
    GOOGLE_CLIENT_SECRET: env.get("GOOGLE_CLIENT_SECRET"),
    GOOGLE_REDIRECT_URI: env.get("GOOGLE_REDIRECT_URI", "http://localhost:5173/api/auth/callback"),
    FRONTEND_URL: env.get("FRONTEND_URL", "http://localhost:5173"),
    GEMINI_API_KEY: env.get("GEMINI_API_KEY"),
    GEMINI_MODEL: env.get("GEMINI_MODEL", "gemini-2.0-flash"),
    GEMINI_TIMEOUT_SECONDS: env.num("GEMINI_TIMEOUT_SECONDS", 30),
    SUPABASE_URL: env.get("SUPABASE_URL"),
    SUPABASE_ANON_KEY: env.get("SUPABASE_ANON_KEY"),
    SUPABASE_SERVICE_ROLE_KEY: env.get("SUPABASE_SERVICE_ROLE_KEY"),
    CREDENTIAL_ENCRYPTION_KEY: env.get("CREDENTIAL_ENCRYPTION_KEY"),
    MAX_SYNC_EMAILS: env.num("MAX_SYNC_EMAILS", 50),
};
export function isLiveGoogleConfigured() {
    return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
}
/**
 * CORS for the function.
 *
 * Supabase functions each need their own CORS headers; the shared gateway does
 * not add them. Origins are matched rather than wildcarded because the app
 * carries a bearer token, and a wildcard cannot be combined with credentials.
 */
const ALLOWED = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:web\.app|firebaseapp\.com|supabase\.co|vercel\.app|netlify\.app|pages\.dev)$/;
export function isAllowedOrigin(origin) {
    if (!origin)
        return true;
    if (ALLOWED.test(origin))
        return true;
    if (config.ENVIRONMENT !== "production") {
        return /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin);
    }
    return false;
}
export function corsHeaders(origin) {
    return {
        "Access-Control-Allow-Origin": origin ?? "*",
        "Vary": "Origin",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Max-Age": "86400",
    };
}
