/**
 * Supabase-backed store, replacing db/store.ts.
 *
 * Same method names and the same ownership rules, so routes port unchanged.
 * What differs is the query layer: Firestore's chained .where() becomes
 * PostgREST filters, and its single array-membership filter becomes Postgres
 * array overlap (`&&`) against a GIN index.
 */
// deno-lint-ignore no-import-prefix
import { createClient } from "npm:@supabase/supabase-js@2";
import { config } from "./config.js";
import { buildSearchTokens, matchesSearch, queryTokens } from "./tokens.js";
import { DEFAULT_SETTINGS } from "./types.js";
/** Cap on documents read per query, so one page cannot exhaust memory. */
const MAX_SCAN = 500;
let client = null;
export function supabase() {
    if (client)
        return client;
    const url = config.SUPABASE_URL;
    const key = config.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    }
    // Service role bypasses RLS. That is deliberate: the schema enables RLS with
    // zero policies so no client can read this data, and the function is the
    // only thing that legitimately can.
    client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    return client;
}
/** Map a row to the API shape. `ts` becomes `timestamp`, jsonb stays jsonb. */
function toEmail(row) {
    return {
        id: row.id,
        user_email: row.user_email,
        sender_name: row.sender_name ?? "",
        sender_email: row.sender_email ?? "",
        recipient_email: row.recipient_email ?? "",
        subject: row.subject ?? "",
        snippet: row.snippet ?? "",
        body: row.body ?? "",
        category: row.category ?? "Work",
        priority: row.priority ?? "Medium",
        date: row.date ?? new Date(0).toISOString(),
        timestamp: row.ts ?? 0,
        is_read: Boolean(row.is_read),
        is_starred: Boolean(row.is_starred),
        is_spam: Boolean(row.is_spam),
        is_trash: Boolean(row.is_trash),
        has_attachments: Boolean(row.has_attachments),
        attachments: row.attachments ?? [],
        summary: row.summary ?? null,
        action_items: row.action_items ?? [],
        reply_draft: row.reply_draft ?? null,
        folder: row.folder ?? "inbox",
    };
}
function ts(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
export class Store {
    // ------------------------------------------------------------------ emails
    async getEmailById(emailId, userEmail) {
        const { data, error } = await supabase()
            .from("emails")
            .select("*")
            .eq("id", emailId)
            .maybeSingle();
        if (error)
            throw new Error(error.message);
        if (!data)
            return null;
        const email = toEmail(data);
        // Every read path is scoped by owner, so one user can never reach another's
        // mail by guessing an id. A mismatch is reported as "not found" rather than
        // "forbidden": the caller should not learn the id exists.
        if (email.user_email.toLowerCase() !== (userEmail || "").toLowerCase())
            return null;
        return email;
    }
    async getEmails(params) {
        const owner = (params.userEmail || "").trim().toLowerCase();
        if (!owner) {
            // No owner means no authorised caller. Return nothing rather than the
            // whole mailbox.
            return [];
        }
        const folder = (params.folder || "inbox").toLowerCase();
        let query = supabase().from("emails").select("*").eq("user_email", owner);
        if (["inbox", "sent", "drafts", "spam", "trash", "archive"].includes(folder)) {
            query = query.eq("folder", folder);
        }
        if (params.category)
            query = query.eq("category", params.category);
        if (params.priority)
            query = query.eq("priority", params.priority);
        if (params.starredOnly)
            query = query.eq("is_starred", true);
        if (params.hasAttachments !== undefined && params.hasAttachments !== null) {
            query = query.eq("has_attachments", params.hasAttachments);
        }
        // Coarse prefilter. `overlaps` maps to `&&`, which the GIN index serves.
        // The exact substring test still runs below, so this never decides the
        // result. An empty token list must skip the filter entirely.
        const tokens = params.search ? queryTokens(params.search) : [];
        if (tokens.length)
            query = query.overlaps("search_tokens", tokens.slice(0, 10));
        // Ordering and the cap happen in SQL now, which the Firestore version had
        // to do in memory because it lacked a composite index.
        const { data, error } = await query
            .order("ts", { ascending: false })
            .limit(MAX_SCAN);
        if (error)
            throw new Error(error.message);
        let results = (data ?? []).map((r) => toEmail(r));
        // ---- filters that need expression work rather than equality ----
        if (folder === "important") {
            results = results.filter((e) => e.priority?.toLowerCase() === "high" ||
                e.category?.toLowerCase() === "important" ||
                e.is_starred);
        }
        else if (folder === "starred") {
            results = results.filter((e) => e.is_starred);
        }
        else if (folder === "unread") {
            results = results.filter((e) => !e.is_read);
        }
        if (params.unreadOnly)
            results = results.filter((e) => !e.is_read);
        if (params.search)
            results = results.filter((e) => matchesSearch(e, params.search));
        if (params.tone) {
            const wanted = params.tone.trim().replace(/\b\w/g, (c) => c.toUpperCase());
            results = results.filter((e) => (e.summary ? e.summary.tone : "Neutral") === wanted);
        }
        if (params.requiresReply !== undefined && params.requiresReply !== null) {
            results = results.filter((e) => Boolean(e.summary?.requires_reply) === params.requiresReply);
        }
        // A timestamp of 0 means "no date", so it is excluded from a bounded range
        // rather than appearing in every one.
        if (params.fromDate != null) {
            results = results.filter((e) => ts(e.timestamp) !== 0 && ts(e.timestamp) >= params.fromDate);
        }
        if (params.toDate != null) {
            results = results.filter((e) => ts(e.timestamp) !== 0 && ts(e.timestamp) <= params.toDate);
        }
        return results;
    }
    async addEmail(email) {
        const { error } = await supabase().from("emails").upsert(this._row(email));
        if (error)
            throw new Error(error.message);
        return email;
    }
    _row(email) {
        const legacyData = { ...email };
        return {
            id: email.id,
            user_email: email.user_email,
            sender_name: email.sender_name,
            sender_email: email.sender_email,
            recipient_email: email.recipient_email,
            subject: email.subject,
            snippet: email.snippet,
            body: email.body,
            category: email.category,
            priority: email.priority,
            date: email.date,
            ts: ts(email.timestamp),
            is_read: email.is_read,
            is_starred: email.is_starred,
            is_spam: email.is_spam,
            is_trash: email.is_trash,
            has_attachments: email.has_attachments,
            attachments: email.attachments ?? [],
            summary: email.summary ?? null,
            action_items: email.action_items ?? [],
            reply_draft: email.reply_draft ?? null,
            folder: email.folder,
            // The deployed project started with a legacy TEXT `data` column
            // that remains NOT NULL. Preserve the complete API-shaped message
            // there while the normalized columns serve current queries.
            data: JSON.stringify(legacyData),
            // Derived, so it is never taken from the caller's payload.
            search_tokens: buildSearchTokens(email),
            updated_at: new Date().toISOString(),
        };
    }
    async addEmails(emails) {
        // An unowned message has no authorisation context, so storing it would
        // create something nobody can ever read.
        const rows = emails
            .filter((e) => (e.user_email || "").trim())
            .map((e) => this._row(e));
        if (!rows.length)
            return 0;
        const { error } = await supabase().from("emails").upsert(rows);
        if (error)
            throw new Error(error.message);
        return rows.length;
    }
    async updateEmail(emailId, userEmail, updates) {
        const existing = await this.getEmailById(emailId, userEmail);
        if (!existing)
            return null;
        // Ownership is not reassignable: otherwise an update could hand a message
        // to another account, or take one away from its owner.
        const safe = { ...updates };
        delete safe.user_email;
        delete safe.id;
        delete safe.search_tokens;
        delete safe.ts;
        delete safe.timestamp;
        const merged = {
            ...existing,
            ...safe,
            timestamp: typeof safe.timestamp === "number" ? safe.timestamp : existing.timestamp,
        };
        if (safe.timestamp !== undefined) {
            // `ts` is the column; the caller speaks `timestamp`.
            safe.ts = safe.timestamp;
            delete safe.timestamp;
        }
        const { error } = await supabase()
            .from("emails")
            .update({ ...safe, search_tokens: buildSearchTokens(merged), updated_at: new Date().toISOString() })
            .eq("id", emailId);
        if (error)
            throw new Error(error.message);
        return merged;
    }
    async purgeEmail(emailId, userEmail) {
        const existing = await this.getEmailById(emailId, userEmail);
        if (!existing)
            return false;
        const { error } = await supabase().from("emails").delete().eq("id", emailId);
        if (error)
            throw new Error(error.message);
        return true;
    }
    /** The reversible transition to trash; a second call really removes it. */
    async deleteEmail(emailId, userEmail) {
        const existing = await this.getEmailById(emailId, userEmail);
        if (!existing)
            return false;
        if (existing.folder === "trash")
            return this.purgeEmail(emailId, userEmail);
        await this.updateEmail(emailId, userEmail, { folder: "trash", is_trash: true });
        return true;
    }
    /** Drop the synthetic demo set once real mail arrives. Scoped by owner. */
    async clearFakeEmailsForUser(userEmail) {
        const owner = (userEmail || "").trim().toLowerCase();
        if (!owner)
            return 0;
        const { data, error } = await supabase()
            .from("emails")
            .delete()
            .eq("user_email", owner)
            .gte("id", "em-usr-")
            .lt("id", "em-usr0")
            .select("id");
        if (error)
            throw new Error(error.message);
        return data?.length ?? 0;
    }
    /**
     * Make a fresh sync authoritative for server folders. Locally composed mail
     * is kept: sent, drafts and trash were produced here, not fetched.
     */
    async replaceUserEmails(userEmail, emails) {
        const owner = (userEmail || "").trim().toLowerCase();
        if (!owner)
            return 0;
        const keep = ["sent", "drafts", "trash"];
        const { data: existing, error } = await supabase()
            .from("emails")
            .select("id, folder")
            .eq("user_email", owner)
            .not("folder", "in", `(${keep.join(",")})`);
        if (error)
            throw new Error(error.message);
        const doomed = (existing ?? []).map((r) => r.id);
        if (doomed.length) {
            const { error: delError } = await supabase().from("emails").delete().in("id", doomed);
            if (delError)
                throw new Error(delError.message);
        }
        return this.addEmails(emails.filter((e) => e.user_email.toLowerCase() === owner));
    }
    /** Remove every message belonging to one account. Never callable unowned. */
    async clearUser(userEmail) {
        const owner = (userEmail || "").trim().toLowerCase();
        if (!owner)
            return 0;
        const { data: emails } = await supabase()
            .from("emails")
            .delete()
            .eq("user_email", owner)
            .select("id");
        // Credentials too. This is the "forget me" primitive, and an OAuth refresh
        // token left behind outlives the session that created it.
        await Promise.all([
            supabase().from("sent_replies").delete().eq("user_email", owner),
            supabase().from("credentials").delete().eq("user_email", owner),
            supabase().from("user_settings").delete().eq("user_email", owner),
        ]);
        return emails?.length ?? 0;
    }
    // ------------------------------------------------- sent replies / style corpus
    async addSentReply(userEmail, recipient, subject, body, sent = true) {
        const owner = (userEmail || "").trim().toLowerCase();
        const text = (body || "").trim();
        if (!owner || !text)
            return null;
        const id = `rep-${crypto.randomUUID().slice(0, 12)}`;
        const { error } = await supabase().from("sent_replies").insert({
            id,
            user_email: owner,
            to_addr: (recipient || "").trim(),
            subject: (subject || "").trim(),
            body: text,
            sent,
        });
        if (error)
            throw new Error(error.message);
        return {
            id,
            user_email: owner,
            to: (recipient || "").trim(),
            subject: (subject || "").trim(),
            body: text,
            sent,
            created_at: Date.now() / 1000,
        };
    }
    async listSentReplies(userEmail, limit = 100) {
        const owner = (userEmail || "").trim().toLowerCase();
        if (!owner)
            return [];
        const { data, error } = await supabase()
            .from("sent_replies")
            .select("*")
            .eq("user_email", owner)
            .order("created_at", { ascending: false })
            .limit(Math.min(limit, 200));
        if (error)
            throw new Error(error.message);
        return (data ?? []).map((r) => ({
            id: r.id,
            user_email: r.user_email,
            to: r.to_addr ?? "",
            subject: r.subject ?? "",
            body: r.body ?? "",
            sent: Boolean(r.sent),
            created_at: new Date(r.created_at).getTime() / 1000,
        }));
    }
    async sentReplyCount(userEmail) {
        const owner = (userEmail || "").trim().toLowerCase();
        if (!owner)
            return 0;
        const { count, error } = await supabase()
            .from("sent_replies")
            .select("id", { count: "exact", head: true })
            .eq("user_email", owner);
        if (error)
            throw new Error(error.message);
        return count ?? 0;
    }
    // -------------------------------------------------------------- credentials
    async setUserCredentials(userEmail, creds) {
        const owner = (userEmail || "").trim().toLowerCase();
        if (!owner)
            return;
        const { error } = await supabase()
            .from("credentials")
            .upsert({ ...creds, user_email: owner, updated_at: new Date().toISOString() });
        if (error)
            throw new Error(error.message);
    }
    async getUserCredentials(userEmail) {
        const owner = (userEmail || "").trim().toLowerCase();
        if (!owner)
            return null;
        const { data, error } = await supabase()
            .from("credentials")
            .select("*")
            .eq("user_email", owner)
            .maybeSingle();
        if (error)
            throw new Error(error.message);
        return data;
    }
    // ----------------------------------------------------------------- settings
    async getSettings(userEmail) {
        const owner = (userEmail || "").trim().toLowerCase();
        if (!owner)
            return { ...DEFAULT_SETTINGS };
        const { data, error } = await supabase()
            .from("user_settings")
            .select("*")
            .eq("user_email", owner)
            .maybeSingle();
        if (error)
            throw new Error(error.message);
        if (!data)
            return { ...DEFAULT_SETTINGS };
        return {
            demo_mode: Boolean(data.demo_mode),
            gemini_api_key: data.gemini_api_key ?? "",
            auto_reply_enabled: Boolean(data.auto_reply_enabled),
            default_reply_tone: data.default_reply_tone ?? "Professional",
            connected_gmail: Boolean(data.connected_gmail),
            sync_interval_mins: Number(data.sync_interval_mins ?? 15),
        };
    }
    async setSettings(userEmail, updates) {
        const merged = { ...(await this.getSettings(userEmail)), ...updates };
        const { error } = await supabase().from("user_settings").upsert({
            user_email: (userEmail || "").trim().toLowerCase(),
            ...merged,
            updated_at: new Date().toISOString(),
        });
        if (error)
            throw new Error(error.message);
        return merged;
    }
}
