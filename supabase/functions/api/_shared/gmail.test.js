import { assertEquals } from "@std/assert";
import { encryptSecret } from "./credentials.js";
import { fetchRecent, gmailFor } from "./gmail.js";

Deno.test("Gmail sync refreshes OAuth and fetches full messages with REST", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = (input, init = {}) => {
        const url = new URL(String(input));
        requests.push({ url, init });

        if (url.hostname === "oauth2.googleapis.com") {
            const form = new URLSearchParams(init.body);
            assertEquals(form.get("grant_type"), "refresh_token");
            assertEquals(form.get("refresh_token"), "refresh-token");
            return Promise.resolve(Response.json({ access_token: "access-token" }));
        }

        assertEquals(new Headers(init.headers).get("authorization"), "Bearer access-token");
        if (url.pathname.endsWith("/messages")) {
            assertEquals(url.searchParams.get("q"), "in:anywhere -in:chats");
            return Promise.resolve(Response.json({ messages: [{ id: "gmail-1" }] }));
        }
        if (url.pathname.endsWith("/messages/gmail-1")) {
            return Promise.resolve(Response.json({
                id: "gmail-1",
                threadId: "thread-1",
                internalDate: "1790770000000",
                snippet: "Hello from Gmail",
                labelIds: ["INBOX", "UNREAD"],
                payload: {
                    headers: [
                        { name: "From", value: "Alice Example <alice@example.com>" },
                        { name: "Subject", value: "Gmail REST works" },
                    ],
                    body: { data: btoa("Hello from Gmail") },
                },
            }));
        }
        throw new Error(`Unexpected Gmail request: ${url}`);
    };

    try {
        const sealedRefreshToken = await encryptSecret("refresh-token");
        const context = await gmailFor({
            getUserCredentials: () => Promise.resolve({ refresh_token: sealedRefreshToken }),
        }, "owner@example.com");
        const emails = await fetchRecent(context, 10);

        assertEquals(requests.length, 3);
        assertEquals(emails.length, 1);
        assertEquals(emails[0].id, "gmail-1");
        assertEquals(emails[0].user_email, "owner@example.com");
        assertEquals(emails[0].sender_email, "alice@example.com");
        assertEquals(emails[0].subject, "Gmail REST works");
        assertEquals(emails[0].body, "Hello from Gmail");
        assertEquals(emails[0].is_read, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
