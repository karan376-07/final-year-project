/**
 * Smart Email Assistant, Supabase Edge Function.
 *
 * Exposes the same 33 operations as the frozen contract in
 * contract/openapi.json, on the same paths, so the React client is unchanged.
 *
 *   POST <function-url>/api/emails
 *   GET  <function-url>/api/health
 *
 * Deno.serve rather than a framework: an edge function is a single request
 * handler, and Express would bring in routing middleware that has nothing to
 * do here. The router below is a pattern match, which is all 33 routes need.
 */
import { Store } from "./_shared/store.js";
import { config, corsHeaders, isAllowedOrigin, isLiveGoogleConfigured } from "./_shared/config.js";
import { HttpError, createTokenForUser, decodeAccessToken, requireUser } from "./_shared/auth.js";
import { encryptSecret } from "./_shared/credentials.js";
import { logger } from "./_shared/log.js";
import { fetchRecent, gmailFor, sendReply } from "./_shared/gmail.js";
import { classify, extractActionItems, generateReply, learnStyle, summarise } from "./_shared/gemini.js";
import { extractPdfText, summariseDocument } from "./_shared/ocr.js";
const store = new Store();
async function route(req) {
    const url = new URL(req.url);
    // The function is mounted at /, so the path arrives with the /api prefix the
    // client uses. Strip a trailing slash so /api/emails/ and /api/emails agree.
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();
    // Cache the parsed body: several handlers read it more than once and a
    // Request stream can only be consumed once.
    let cached;
    let parsed = false;
    const ctx = {
        req,
        url,
        json: (status, data) => new Response(JSON.stringify(data), {
            status,
            headers: { ...corsHeaders(req.headers.get("origin")), "content-type": "application/json" },
        }),
        body: async () => {
            if (!parsed) {
                try {
                    cached = await req.json();
                }
                catch {
                    cached = {};
                }
                parsed = true;
            }
            return (cached ?? {});
        },
    };
    // ---- health, unauthenticated: the deploy check and the emulator UI both
    // poll this.
    if (path === "/api/health" && method === "GET") {
        return ctx.json(200, {
            status: "healthy",
            environment: config.ENVIRONMENT,
            services: {
                api: "online",
                database: config.SUPABASE_URL ? "ready" : "unconfigured",
                ai_engine: config.GEMINI_API_KEY ? "active" : "unconfigured",
            },
            google_oauth: isLiveGoogleConfigured() ? "configured" : "unconfigured",
            demo_mode: config.DEMO_MODE,
        });
    }
    // ---- auth/config and login-url are public: the login page needs them
    // before anybody has a token.
    if (path === "/api/auth/config" && method === "GET") {
        return ctx.json(200, {
            google_client_id: config.GOOGLE_CLIENT_ID ?? "",
            google_redirect_uri: config.GOOGLE_REDIRECT_URI,
            is_live_configured: isLiveGoogleConfigured(),
            demo_mode: config.DEMO_MODE,
        });
    }
    if (path === "/api/auth/login-url" && method === "GET") {
        if (!isLiveGoogleConfigured()) {
            return ctx.json(503, { detail: "Google OAuth is not configured" });
        }
        const params = new URLSearchParams({
            client_id: config.GOOGLE_CLIENT_ID,
            redirect_uri: config.GOOGLE_REDIRECT_URI,
            response_type: "code",
            access_type: "offline",
            // Without this, Google returns no refresh token on a second consent and
            // the account silently stops syncing.
            prompt: "consent",
            scope: [
                "openid", "email", "profile",
                "https://www.googleapis.com/auth/gmail.readonly",
                "https://www.googleapis.com/auth/gmail.modify",
                "https://www.googleapis.com/auth/gmail.send",
            ].join(" "),
        });
        return ctx.json(200, { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    }
    const requiresAuth = () => requireUser(req).then((user) => {
        ctx.user = user;
    });
    try {
        // ------------------------------------------------------------- auth
        if (path === "/api/auth/callback" && (method === "GET" || method === "POST")) {
            const code = method === "GET"
                ? (url.searchParams.get("code") ?? undefined)
                : ((await ctx.body()).code ?? undefined);
            if (!code)
                return ctx.json(400, { detail: "Missing authorization code" });
            return await finishGoogleLogin(ctx, code);
        }
        if ((path === "/api/auth/google" || path === "/api/auth/google-login") && method === "POST") {
            const { id_token: idToken } = await ctx.body();
            if (!idToken)
                return ctx.json(400, { detail: "Missing id_token" });
            return await exchangeIdToken(ctx, idToken);
        }
        if (path === "/api/auth/me" && method === "GET") {
            const header = req.headers.get("authorization") ?? "";
            const payload = header.startsWith("Bearer ")
                ? await decodeAccessToken(header.slice(7).trim())
                : null;
            if (!payload?.email || !payload.sub) {
                return ctx.json(401, { detail: "Invalid or expired session" });
            }
            return ctx.json(200, {
                id: payload.sub,
                email: payload.email,
                name: payload.name ?? payload.email.split("@")[0],
                avatar: payload.avatar ?? "",
                is_demo: Boolean(payload.is_demo),
                connected_gmail: payload.connected_gmail === undefined ? true : Boolean(payload.connected_gmail),
            });
        }
        if (path === "/api/auth/logout" && method === "POST") {
            const header = req.headers.get("authorization") ?? "";
            if (header.startsWith("Bearer ")) {
                const payload = await decodeAccessToken(header.slice(7).trim());
                if (payload?.email) {
                    // Drop the stored grant too. Leaving the refresh token behind keeps
                    // mailbox access alive after the user asked to be forgotten.
                    await store.setUserCredentials(payload.email, {});
                }
            }
            return ctx.json(200, { status: "success" });
        }
        if (path === "/api/auth/imap-login" && method === "POST") {
            return ctx.json(501, {
                detail: "IMAP password sign-in has been removed. Use Google OAuth: it is revocable and does not require storing a mailbox password.",
            });
        }
        // ---------------------------------------------------------- settings
        if (path === "/api/settings" && method === "GET") {
            await requiresAuth();
            return ctx.json(200, await store.getSettings(ctx.user.email));
        }
        if (path === "/api/settings" && (method === "PUT" || method === "POST")) {
            await requiresAuth();
            const body = await ctx.body();
            // Only declared fields are accepted, so a caller cannot smuggle extra
            // keys into the row.
            const updates = {};
            for (const key of [
                "gemini_api_key", "demo_mode", "auto_reply_enabled", "default_reply_tone",
            ]) {
                if (key in body)
                    updates[key] = body[key];
            }
            const settings = await store.setSettings(ctx.user.email, updates);
            return ctx.json(200, { status: "success", settings });
        }
        // --------------------------------------------------------- analytics
        if (path === "/api/analytics/summary" && method === "GET") {
            await requiresAuth();
            const emails = await store.getEmails({ userEmail: ctx.user.email, folder: "all" });
            return ctx.json(200, emails.length ? summariseAnalytics(emails) : emptyAnalytics());
        }
        // ------------------------------------------------------------- ocr
        if (path === "/api/ocr/scan" && method === "POST") {
            return await scanAttachment(ctx);
        }
        if (path === "/api/ocr/scan-attachment" && method === "POST") {
            return await scanAttachment(ctx);
        }
        if (path === "/api/ocr/upload" && method === "POST") {
            return ctx.json(501, {
                detail: "File upload is not supported. Scan a PDF that is already attached to one of your emails.",
            });
        }
        // ---------------------------------------------------------- emails
        if (path === "/api/emails" && method === "GET") {
            await requiresAuth();
            const q = url.searchParams;
            const emails = await store.getEmails({
                userEmail: ctx.user.email,
                folder: q.get("folder") ?? "inbox",
                category: q.get("category"),
                priority: q.get("priority"),
                search: q.get("search"),
                unreadOnly: q.get("unread_only") === "true",
                starredOnly: q.get("starred_only") === "true",
                hasAttachments: q.has("has_attachments") ? q.get("has_attachments") === "true" : null,
                tone: q.get("tone"),
                fromDate: numOrNull(q.get("from_date")),
                toDate: numOrNull(q.get("to_date")),
                requiresReply: q.has("requires_reply") ? q.get("requires_reply") === "true" : null,
            });
            return ctx.json(200, emails.map(listView));
        }
        if (path === "/api/emails/counts" && method === "GET") {
            await requiresAuth();
            const owner = ctx.user.email;
            const [all, inbox, unread, starred, spam, sent, drafts, trash, important] = await Promise.all([
                store.getEmails({ userEmail: owner, folder: "all" }),
                store.getEmails({ userEmail: owner, folder: "inbox" }),
                store.getEmails({ userEmail: owner, folder: "unread" }),
                store.getEmails({ userEmail: owner, folder: "starred" }),
                store.getEmails({ userEmail: owner, folder: "spam" }),
                store.getEmails({ userEmail: owner, folder: "sent" }),
                store.getEmails({ userEmail: owner, folder: "drafts" }),
                store.getEmails({ userEmail: owner, folder: "trash" }),
                store.getEmails({ userEmail: owner, folder: "important" }),
            ]);
            return ctx.json(200, {
                all: all.length,
                inbox: inbox.length,
                unread: unread.length,
                starred: starred.length,
                spam: spam.length,
                sent: sent.length,
                drafts: drafts.length,
                trash: trash.length,
                important: important.length,
                urgent: important.length,
            });
        }
        if (path === "/api/emails/sync" && method === "POST") {
            await requiresAuth();
            const gmail = await gmailFor(store, ctx.user.email);
            if (!gmail)
                return ctx.json(400, { detail: "Gmail is not connected for this account" });
            let fetched;
            try {
                fetched = await fetchRecent(gmail);
            }
            catch (err) {
                const detail = errorDetail(err);
                if (/Gmail API has not been used|SERVICE_DISABLED|disabled/i.test(detail)) {
                    return ctx.json(503, {
                        detail: `Gmail API is disabled for the Google Cloud project used by this production OAuth client (637066246551). Enable it at https://console.cloud.google.com/apis/api/gmail.googleapis.com/overview?project=637066246551, then sign in again. Google error: ${detail}`,
                    });
                }
                throw err;
            }
            // Server folders become authoritative; locally composed mail is kept.
            const stored = await store.replaceUserEmails(ctx.user.email, fetched);
            await store.clearFakeEmailsForUser(ctx.user.email);
            return ctx.json(200, { status: "success", synced: fetched.length, stored });
        }
        if (path === "/api/emails/sync-imap" && method === "POST") {
            await requiresAuth();
            return ctx.json(501, {
                detail: "IMAP sync has been removed. Connect Gmail with Google OAuth instead.",
            });
        }
        if (path === "/api/emails/history" && method === "GET") {
            await requiresAuth();
            const emails = await store.getEmails({ userEmail: ctx.user.email, folder: "all" });
            return ctx.json(200, emails.map(listView));
        }
        if (path === "/api/emails/style-profile" && method === "GET") {
            await requiresAuth();
            const replies = await store.listSentReplies(ctx.user.email);
            return ctx.json(200, await learnStyle(replies.map((r) => ({ body: r.body }))));
        }
        if (path === "/api/emails/replies/record" && method === "POST") {
            await requiresAuth();
            const body = await ctx.body();
            if (body.body) {
                await store.addSentReply(ctx.user.email, String(body.to ?? ""), String(body.subject ?? ""), String(body.body), body.sent !== false);
            }
            return ctx.json(200, { status: "recorded" });
        }
        if (path === "/api/emails/analyze" && method === "POST") {
            return await analyze(ctx);
        }
        if (path === "/api/emails/summarize" && method === "POST") {
            const body = await ctx.body();
            if (!body.body)
                return ctx.json(400, { detail: "body is required" });
            return ctx.json(200, await summarise(body.subject ?? "", body.body));
        }
        if (path === "/api/emails/generate-reply" && method === "POST") {
            await requiresAuth();
            const body = await ctx.body();
            let subject = body.email_subject ?? "";
            let text = body.email_body ?? "";
            if (body.email_id) {
                const stored = await store.getEmailById(body.email_id, ctx.user.email);
                if (!stored)
                    return ctx.json(404, { detail: "Email not found" });
                subject = stored.subject;
                text = stored.body;
            }
            if (!text) {
                return ctx.json(400, { detail: "email_body or email_id is required" });
            }
            const style = await learnStyle((await store.listSentReplies(ctx.user.email)).map((r) => ({ body: r.body })));
            const result = await generateReply(subject, text, body.tone ?? "Professional", body.custom_instructions ?? undefined, style);
            return ctx.json(200, { ...result, tone: body.tone ?? "Professional" });
        }
        if (path === "/api/emails/compose" && method === "POST") {
            await requiresAuth();
            const body = await ctx.body();
            if (!body.recipient || !body.body) {
                return ctx.json(400, { detail: "recipient and body are required" });
            }
            const gmail = await gmailFor(store, ctx.user.email);
            if (!gmail)
                return ctx.json(400, { detail: "Gmail is not connected for this account" });
            // The thread must belong to the caller, or they could graft a reply onto
            // somebody else's thread.
            let inReplyTo = null;
            if (body.in_reply_to) {
                const parent = await store.getEmailById(body.in_reply_to, ctx.user.email);
                if (!parent)
                    return ctx.json(404, { detail: "Thread not found" });
                inReplyTo = body.in_reply_to;
            }
            const sent = await sendReply(gmail, {
                to: body.recipient,
                subject: body.subject ?? "",
                body: body.body,
                inReplyTo,
            });
            await store.addSentReply(ctx.user.email, body.recipient, body.subject ?? "", body.body, true);
            return ctx.json(200, { status: "sent", message_id: sent.id });
        }
        // --------------------------------------------------- /emails/{id}/...
        const detail = path.match(/^\/api\/emails\/([^/]+)$/);
        if (detail) {
            const id = decodeURIComponent(detail[1]);
            if (method === "GET") {
                await requiresAuth();
                const email = await store.getEmailById(id, ctx.user.email);
                if (!email)
                    return ctx.json(404, { detail: "Email not found" });
                return ctx.json(200, publicView(email));
            }
            if (method === "PATCH") {
                await requiresAuth();
                const updated = await store.updateEmail(id, ctx.user.email, await ctx.body());
                if (!updated)
                    return ctx.json(404, { detail: "Email not found" });
                return ctx.json(200, publicView(updated));
            }
            if (method === "DELETE") {
                await requiresAuth();
                const ok = await store.deleteEmail(id, ctx.user.email);
                if (!ok)
                    return ctx.json(404, { detail: "Email not found" });
                return ctx.json(200, { status: "deleted" });
            }
        }
        const action = path.match(/^\/api\/emails\/([^/]+)\/([a-z-]+)(?:\/(\d+))?$/);
        if (action) {
            const id = decodeURIComponent(action[1]);
            const verb = action[2];
            const index = action[3] ? Number(action[3]) : null;
            await requiresAuth();
            const email = await store.getEmailById(id, ctx.user.email);
            if (!email)
                return ctx.json(404, { detail: "Email not found" });
            switch (`${method} ${verb}`) {
                case "POST toggle-read": {
                    const u = await store.updateEmail(id, ctx.user.email, { is_read: !email.is_read });
                    return ctx.json(200, publicView(u));
                }
                case "POST toggle-star": {
                    const u = await store.updateEmail(id, ctx.user.email, { is_starred: !email.is_starred });
                    return ctx.json(200, publicView(u));
                }
                case "POST restore": {
                    const u = await store.updateEmail(id, ctx.user.email, { folder: "inbox", is_trash: false });
                    return ctx.json(200, publicView(u));
                }
                case "POST purge": {
                    const ok = await store.purgeEmail(id, ctx.user.email);
                    if (!ok)
                        return ctx.json(404, { detail: "Email not found" });
                    return ctx.json(200, { status: "purged" });
                }
                case "POST move": {
                    const { folder } = await ctx.body();
                    if (!folder)
                        return ctx.json(400, { detail: "folder is required" });
                    const u = await store.updateEmail(id, ctx.user.email, { folder, is_trash: folder === "trash" });
                    return ctx.json(200, publicView(u));
                }
                case "POST summarize": {
                    const [summary, actions] = await Promise.all([
                        summarise(email.subject, email.body),
                        extractActionItems(email.subject, email.body),
                    ]);
                    const u = await store.updateEmail(id, ctx.user.email, { summary, action_items: actions });
                    return ctx.json(200, publicView(u));
                }
                case "POST phishing-check":
                case "GET phishing-check":
                    return ctx.json(200, heuristicPhishing(email));
                case "GET suggest-reply":
                case "POST suggest-reply": {
                    const personalize = url.searchParams.get("personalize") === "true";
                    const tone = url.searchParams.get("tone") ?? email.summary?.tone ?? "Professional";
                    const language = url.searchParams.get("language") ?? "en";
                    const style = personalize
                        ? await learnStyle((await store.listSentReplies(ctx.user.email)).map((r) => ({ body: r.body })))
                        : null;
                    const result = await generateReply(email.subject, email.body, tone, undefined, style ?? undefined, language);
                    return ctx.json(200, { ...result, tone, style_applied: Boolean(style?.ready) });
                }
                case "POST action-items": {
                    if (index === null)
                        return ctx.json(400, { detail: "Invalid task index" });
                    const items = [...(email.action_items ?? [])];
                    if (index < 0 || index >= items.length) {
                        return ctx.json(400, { detail: "Invalid task index" });
                    }
                    items[index] = { ...items[index], completed: !items[index].completed };
                    const u = await store.updateEmail(id, ctx.user.email, { action_items: items });
                    return ctx.json(200, publicView(u));
                }
                default:
                    break;
            }
        }
        const historyEntry = path.match(/^\/api\/emails\/history\/([^/]+)$/);
        if (historyEntry && method === "DELETE") {
            await requiresAuth();
            const ok = await store.purgeEmail(decodeURIComponent(historyEntry[1]), ctx.user.email);
            if (!ok)
                return ctx.json(404, { detail: "Not found" });
            return ctx.json(200, { status: "deleted" });
        }
        return ctx.json(404, { detail: "Not Found" });
    }
    catch (err) {
        if (err instanceof HttpError)
            return ctx.json(err.status, { detail: err.message });
        const detail = errorDetail(err);
        logger.error({ msg: "unhandled", error: detail, stack: err?.stack, path });
        return ctx.json(500, { detail });
    }
}
// ------------------------------------------------------------------ handlers
function errorDetail(err) {
    if (err instanceof Error && err.message)
        return err.message;
    if (typeof err === "string" && err)
        return err;
    try {
        return JSON.stringify(err);
    }
    catch {
        return "Internal Server Error";
    }
}
function numOrNull(v) {
    if (v === null || v === "")
        return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
/** The inbox renders a list, so the body is dropped to keep responses small. */
function listView(email) {
    return {
        ...publicView(email),
        body: undefined,
        attachments: (email.attachments ?? []).map((a) => ({ ...a, extracted_text: undefined })),
    };
}
function publicView(email) {
    const { search_tokens: _omit, ...rest } = email;
    return rest;
}
async function finishGoogleLogin(ctx, code) {
    const params = new URLSearchParams({
        code,
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        redirect_uri: config.GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
    });
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params,
    });
    if (!tokenRes.ok) {
        return ctx.json(400, { detail: `Google sign-in failed: ${await tokenRes.text()}` });
    }
    const tokens = (await tokenRes.json());
    if (!tokens.id_token) {
        return ctx.json(400, { detail: "Google did not return an id_token" });
    }
    return await exchangeIdToken(ctx, tokens.id_token, tokens, true);
}
async function exchangeIdToken(ctx, idToken, extra = {}, redirectToFrontend = false) {
    // Verify against this project's client id, so a token minted for another app
    // cannot create a session here.
    const payload = await verifyGoogleIdToken(idToken);
    const email = typeof payload?.email === "string" ? payload.email : null;
    if (!email)
        return ctx.json(401, { detail: "Invalid Google token" });
    const sub = typeof payload.sub === "string" ? payload.sub : email;
    const user = {
        id: sub,
        email: email.toLowerCase(),
        name: (typeof payload.name === "string" && payload.name) || email.split("@")[0],
        avatar: typeof payload.picture === "string" ? payload.picture : "",
        is_demo: false,
        connected_gmail: true,
    };
    if (extra.refresh_token) {
        // Sealed before it is written. A refresh token outlives the session that
        // created it, so it must never sit in Postgres in the clear.
        await store.setUserCredentials(user.email, {
            refresh_token: await encryptSecret(extra.refresh_token),
            access_token: extra.access_token ? await encryptSecret(extra.access_token) : null,
            scope: extra.scope ?? null,
            expiry_date: extra.expires_in ? Date.now() + extra.expires_in * 1000 : null,
        });
    }
    const accessToken = await createTokenForUser(user);
    if (redirectToFrontend) {
        const redirect = new URL(config.FRONTEND_URL);
        redirect.searchParams.set("token", accessToken);
        return Response.redirect(redirect.toString(), 302);
    }
    return ctx.json(200, {
        access_token: accessToken,
        token_type: "bearer",
        user,
    });
}
/** Verify a Google id_token by fetching Google's public key and checking it. */
/** base64url segment -> TextDecoder, tolerating missing padding. */
function decodeSegment(seg) {
    return new TextDecoder().decode(Uint8Array.from(atob(seg.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (seg.length % 4)) % 4)), (c) => c.charCodeAt(0)));
}
/** base64url segment -> bytes, for a signature. */
function decodeBytes(seg) {
    const out = new Uint8Array(new ArrayBuffer(atob(seg.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (seg.length % 4)) % 4)).length));
    const raw = atob(seg.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (seg.length % 4)) % 4));
    for (let i = 0; i < raw.length; i += 1)
        out[i] = raw.charCodeAt(i);
    return out;
}
async function verifyGoogleIdToken(idToken) {
    if (!config.GOOGLE_CLIENT_ID)
        return null;
    const parts = idToken.split(".");
    if (parts.length !== 3)
        return null;
    const [h, p, s] = parts;
    let header;
    try {
        header = JSON.parse(decodeSegment(h));
    }
    catch {
        return null;
    }
    const kid = header.kid;
    if (!kid)
        return null;
    const certs = (await (await fetch(`https://www.googleapis.com/oauth2/v3/certs?kid=${kid}`)).json());
    const jwk = certs.keys.find((k) => k.kid === kid);
    if (!jwk)
        return null;
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, alg: jwk.alg, n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBytes(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok)
        return null;
    let claims;
    try {
        claims = JSON.parse(decodeSegment(p));
    }
    catch {
        return null;
    }
    // Check the audience ourselves; a valid signature alone is not enough.
    if (claims.aud !== config.GOOGLE_CLIENT_ID)
        return null;
    const exp = Number(claims.exp ?? 0);
    if (!exp || exp < Math.floor(Date.now() / 1000))
        return null;
    return claims;
}
async function analyze(ctx) {
    const body = await ctx.body();
    if (!body.body)
        return ctx.json(400, { detail: "body is required" });
    const [summary, actions, classification] = await Promise.all([
        summarise(body.subject ?? "", body.body),
        extractActionItems(body.subject ?? "", body.body),
        classify(body.subject ?? "", body.body),
    ]);
    let reply = null;
    let suggestedSubject = null;
    if (body.generate_reply && body.tone) {
        const style = body.personalize
            ? await learnStyle((await store.listSentReplies(ctx.user?.email ?? "")).map((r) => ({ body: r.body })))
            : null;
        const generated = await generateReply(body.subject ?? "", body.body, body.tone, undefined, style ?? undefined);
        reply = generated.reply_text;
        suggestedSubject = generated.suggested_subject;
    }
    if (body.save && ctx.user) {
        await store.addEmail({
            id: `an-${Date.now().toString(36)}`,
            user_email: ctx.user.email,
            sender_name: body.sender_name ?? "Unknown sender",
            sender_email: body.sender_email ?? "",
            recipient_email: ctx.user.email,
            subject: body.subject ?? "(no subject)",
            snippet: body.body.slice(0, 160),
            body: body.body,
            category: classification.category,
            priority: classification.priority,
            date: new Date().toISOString(),
            timestamp: Date.now() / 1000,
            is_read: true,
            is_starred: false,
            is_spam: false,
            is_trash: false,
            has_attachments: false,
            attachments: [],
            summary,
            action_items: actions,
            reply_draft: reply,
            folder: "inbox",
        });
    }
    // Flat, not nested under `summary`.
    //
    // AnalyzeView reads result.one_liner, result.bullet_points, result.sentiment,
    // result.tone, result.keywords, result.meeting, result.people, result.dates
    // and result.key_deadlines directly off the top level. Returning them under
    // a `summary` key left every one of those undefined, so the analysis panel
    // rendered blank despite a 200 response. The nested copy is kept as well,
    // because the stored email carries the same object and callers that read
    // the saved record expect it.
    return ctx.json(200, {
        ...summary,
        summary,
        // AnalyzeView reads `deadlines`; the summary object calls the same field
        // `key_deadlines`. Both are emitted so the panel finds either name.
        deadlines: summary.key_deadlines ?? [],
        action_items: actions,
        category: classification.category,
        priority: classification.priority,
        reply,
        reply_tone: body.tone ?? null,
        suggested_subject: suggestedSubject,
        is_phishing: false,
        engine: config.GEMINI_API_KEY ? config.GEMINI_MODEL : "local-rules",
        // The client only refreshes history when told a record was written.
        saved: Boolean(body.save && ctx.user),
        email: null,
    });
}
async function scanAttachment(ctx) {
    const body = await ctx.body();
    if (body.raw_text) {
        const result = await summariseDocument("pasted text", body.raw_text);
        return ctx.json(200, { filename: "pasted text", extracted_text: body.raw_text, ...result });
    }
    if (!body.email_id || !body.attachment_id) {
        return ctx.json(400, { detail: "email_id and attachment_id are required" });
    }
    // Confirms the attachment belongs to a message this caller owns.
    const user = await requireUser(ctx.req);
    const email = await store.getEmailById(body.email_id, user.email);
    if (!email)
        return ctx.json(404, { detail: "Email not found" });
    const attachment = (email.attachments ?? []).find((a) => a.id === body.attachment_id);
    if (!attachment)
        return ctx.json(404, { detail: "Attachment not found" });
    const gmail = await gmailFor(store, user.email);
    if (!gmail)
        return ctx.json(400, { detail: "Gmail is not connected for this account" });
    const fetched = await gmail.gmail.users.messages.attachments.get({
        userId: gmail.userId,
        messageId: body.email_id,
        id: body.attachment_id,
    });
    const bytes = Uint8Array.from(atob((fetched.data.data ?? "") + "=="), (c) => c.charCodeAt(0));
    if (!bytes.length)
        return ctx.json(422, { detail: "Attachment body was empty" });
    const { text, hasTextLayer } = await extractPdfText(bytes);
    if (!hasTextLayer) {
        // A scanned PDF has no text layer. Saying so is more useful than returning
        // an empty extraction that looks like a failure elsewhere.
        return ctx.json(422, {
            detail: "This PDF has no text layer, so it looks scanned. Text extraction needs an OCR service.",
        });
    }
    const result = await summariseDocument(attachment.filename, text);
    await store.updateEmail(body.email_id, user.email, {
        attachments: (email.attachments ?? []).map((a) => a.id === body.attachment_id ? { ...a, extracted_text: text } : a),
    });
    return ctx.json(200, { filename: attachment.filename, extracted_text: text, ...result });
}
/**
 * Heuristic phishing signals. Self-contained on purpose: no model call, so it
 * works on the free tier with no API key. These are indicators, not a verdict.
 */
function heuristicPhishing(email) {
    const signals = [];
    const sender = email.sender_email.toLowerCase();
    const text = email.body;
    const from = `${email.sender_name} ${email.sender_email}`.toLowerCase();
    if (/^(https?:\/\/)?(www\.)?[a-z0-9-]+\.(ru|cn|tk|xyz|top|click|zip)\b/.test(sender)) {
        signals.push("Sender domain uses a frequently abused TLD");
    }
    const display = email.sender_name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const domain = sender.split("@")[1]?.split(".")[0] ?? "";
    if (display && domain && !display.includes(domain) && display.length > 3) {
        signals.push("Display name does not match the sending domain");
    }
    if (/\b(verify your account|confirm your identity|act now|suspended|unusual activity|failed verification)\b/i.test(text)) {
        signals.push("Body contains urgency or account-verification language");
    }
    if (/\b(bitcoin|crypto|wire transfer|gift card|bank details|password|ssn)\b/i.test(text)) {
        signals.push("Body requests credentials or payment");
    }
    if (/https?:\/\/[^\s]*@/.test(text)) {
        signals.push("Link disguises its real destination");
    }
    // A no-reply address that also reads like a brand name is the shape of an
    // impersonation attempt.
    if (/\bdo not reply\b/.test(from) && /\b(invoice|security|support|payments)\b/.test(from)) {
        signals.push("Sender address looks like an impersonation of a known brand");
    }
    return {
        risk: signals.length >= 2 ? "high" : signals.length === 1 ? "medium" : "low",
        signals,
    };
}
function emptyAnalytics() {
    return {
        total_emails: 0, unread_count: 0, spam_blocked: 0, urgent_count: 0,
        important_count: 0, open_action_items: 0, time_saved_hours: 0.0,
        avg_response_time_minutes: 0, category_distribution: {},
        priority_distribution: {}, daily_volume: [], top_senders: [],
    };
}
function summariseAnalytics(emails) {
    const isSummarised = (e) => Boolean(e.summary && (e.summary.one_liner || e.summary.bullet_points?.length));
    const summarised = emails.filter(isSummarised).length;
    const categoryCounts = {};
    for (const e of emails)
        categoryCounts[e.category] = (categoryCounts[e.category] ?? 0) + 1;
    const buckets = {};
    for (const e of emails) {
        if (!e.timestamp)
            continue;
        const day = new Date(e.timestamp * 1000).toISOString().slice(0, 10);
        const b = (buckets[day] ??= { received: 0, summarized: 0, urgent: 0 });
        b.received += 1;
        if (isSummarised(e))
            b.summarized += 1;
        if (e.priority === "High")
            b.urgent += 1;
    }
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dailyVolume = Object.keys(buckets).sort().slice(-14).map((d) => {
        const [, m, day] = d.split("-");
        return { day: `${day} ${months[Number(m) - 1] ?? m}`, ...buckets[d] };
    });
    const counts = new Map();
    const addresses = new Map();
    const urgentBy = new Map();
    for (const e of emails) {
        const name = e.sender_name || e.sender_email;
        counts.set(name, (counts.get(name) ?? 0) + 1);
        addresses.set(name, e.sender_email);
        if (e.priority === "High")
            urgentBy.set(name, (urgentBy.get(name) ?? 0) + 1);
    }
    return {
        total_emails: emails.length,
        unread_count: emails.filter((e) => !e.is_read && e.folder === "inbox").length,
        spam_blocked: emails.filter((e) => e.is_spam || e.category === "Spam").length,
        urgent_count: emails.filter((e) => e.priority === "High" && e.folder === "inbox").length,
        important_count: emails.filter((e) => e.priority === "High" || e.is_starred).length,
        open_action_items: emails.reduce((n, e) => n + (e.action_items ?? []).filter((a) => !a.completed).length, 0),
        time_saved_hours: Math.round(((summarised * 2) / 60) * 10) / 10,
        avg_response_time_minutes: 0,
        category_distribution: categoryCounts,
        priority_distribution: {
            High: emails.filter((e) => e.priority === "High").length,
            Medium: emails.filter((e) => e.priority === "Medium").length,
            Low: emails.filter((e) => e.priority === "Low").length,
        },
        daily_volume: dailyVolume,
        top_senders: [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([name, count]) => ({
            name,
            email: addresses.get(name) ?? "",
            count,
            urgent_ratio: `${Math.round(((urgentBy.get(name) ?? 0) / count) * 100)}%`,
        })),
    };
}
// ---------------------------------------------------------------------- main
Deno.serve(async (req) => {
    const origin = req.headers.get("origin");
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (!isAllowedOrigin(origin)) {
        // Reflecting a disallowed origin is the same as no CORS header at all, but
        // the explicit rejection makes the failure obvious in the browser console.
        return new Response(JSON.stringify({ detail: "Origin not allowed" }), {
            status: 403,
            headers: { ...corsHeaders(null), "content-type": "application/json" },
        });
    }
    const started = Date.now();
    try {
        const res = await route(req);
        logger.info({
            msg: "request",
            method: req.method,
            path: new URL(req.url).pathname,
            status: res.status,
            durationMs: Date.now() - started,
        });
        return res;
    }
    catch (err) {
        // Anything that escapes the router. Without this Deno returns a bare 500
        // with no CORS header, which the browser reports as an opaque failure.
        logger.error({ msg: "fatal", error: err.message, stack: err.stack });
        return new Response(JSON.stringify({ detail: "Internal Server Error" }), {
            status: 500,
            headers: { ...corsHeaders(origin), "content-type": "application/json" },
        });
    }
});
