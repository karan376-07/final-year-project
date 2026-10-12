# Supabase deployment

The app runs on Supabase, which is also what Lovable uses natively, so this
stack is the one Lovable-generated projects are built on. No card required.

```
frontend/dist   ->  Vercel, Netlify, or any static host
supabase/functions/api   ->  Deno edge function (plain JavaScript)
Postgres        ->  emails, sent_replies, credentials, user_settings
```

---

## 1. Create the project

At [supabase.com/dashboard](https://supabase.com/dashboard) -> New project.
Note the database password; you need it for the CLI.

Free tier: 500 MB database, 1 GB file storage, 500 MB egress/month, and
**500,000 edge function invocations/month**.

One caveat that will bite you: **the free tier pauses a project after 7 days of
inactivity**, and the app 503s until you resume it from the dashboard. For a
final-year demo that is fine as long as someone opens it weekly.

## 2. Install the CLI and link

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

`supabase login` opens a browser. Do not paste a service account key anywhere.

## 3. Apply the schema

```bash
supabase db push
```

This applies `supabase/migrations/20260930000100_init.sql`, which creates the
four tables, the indexes, and the RLS deny-all posture. Or paste the file into
the SQL editor.

## 4. Set the function secrets

There is no .env for edge functions; Supabase uses `supabase secrets set`:

```bash
supabase secrets set \
  JWT_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')" \
  CREDENTIAL_ENCRYPTION_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')" \
  GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com \
  GOOGLE_CLIENT_SECRET=xxxx \
  GOOGLE_REDIRECT_URI=https://YOUR_PROJECT_REF.supabase.co/functions/v1/api/auth/callback \
  FRONTEND_URL=https://YOUR_APP.vercel.app \
  GEMINI_API_KEY=xxxx
```

`FRONTEND_URL` must be the public Vercel origin (no `/login` path). If omitted,
the function defaults to `http://localhost:5173`; OAuth can appear to complete
but return the browser to the wrong app/API, where the session token is rejected.

The two keys are generated fresh. **They must differ from each other, and
`CREDENTIAL_ENCRYPTION_KEY` must never change once set** -- it encrypts OAuth
refresh tokens at rest, so a new value makes every stored token undecryptable
and every user has to re-link.

Optional: `GEMINI_API_KEY`. Without it the app still works -- `localRules.ts`
covers summarise, classify and extract deterministically.

## 5. Deploy the function

```bash
supabase functions deploy api --no-verify-jwt
```

`--no-verify-jwt` matches `supabase/config.toml`. This function issues its own
JWT, and the client has no Supabase session when it first calls, so the gateway
gate would reject the login request itself.

Check the URL:

```bash
supabase functions list
```

It looks like `https://<ref>.supabase.co/functions/v1/api`.

## 6. Google OAuth

Register the redirect URI in Google Cloud Console -> Credentials:

```
https://<ref>.supabase.co/functions/v1/api/auth/callback
```

Add it to the OAuth client's Authorised redirect URIs, then ensure the
`GOOGLE_REDIRECT_URI` secret matches that same string exactly.

## 7. Frontend on Vercel

```bash
cd frontend
npm run build
```

Import the repository in Vercel and set the project root to `frontend`. The
included `vercel.json` rewrites `/api/*` to a Vercel serverless proxy, which
forwards requests to the Edge Function. Set these server-side variables in the
Vercel project settings:

| Variable | Value |
|---|---|
| `SUPABASE_FUNCTION_URL` | `https://<ref>.supabase.co/functions/v1/api` |
| `SUPABASE_ANON_KEY` | The Supabase project's anon/publishable key |

Do not set `VITE_SUPABASE_FUNCTION_URL`: the browser should use the same-origin
`/api` route so production traffic goes through the Vercel function. Locally,
Vite's `/api` proxy forwards to FastAPI on `localhost:8000`.

---

## Free tier limits

| Service | Free per month |
|---|---|
| Database | 500 MB, 1 GB storage |
| Edge functions | 500,000 invocations |
| Egress | 500 MB |

Edge functions also have a **150s wall-clock limit per invocation** and a 256 MB
memory cap. The Gmail sync path batches message fetches and deliberately does
*not* summarise during sync, because summarising 50 messages would be 50
sequential model calls and cannot finish in time.

Cold starts on the free tier are mild, unlike Cloud Functions.

---

## What changed from the Cloud Functions version

| Node / Express | Supabase edge function |
|---|---|
| `index.ts` (Express app) | `api/index.ts` (`Deno.serve` + pattern router) |
| `db/store.ts` (Firestore) | `_shared/store.ts` (Postgres via PostgREST) |
| `lib/auth.ts` (`jose`) | `_shared/auth.ts` (WebCrypto HMAC) |
| `services/credentials.ts` (node:crypto) | `_shared/credentials.ts` (WebCrypto AES-GCM) |
| `services/gemini.ts` | `_shared/gemini.ts` (unchanged logic) |
| `services/localRules.ts` | `_shared/localRules.ts` (unchanged) |
| `services/gmail.ts`, `ocr.ts` | `_shared/gmail.ts`, `ocr.ts` |
| `db/tokens.ts` | `_shared/tokens.ts` |

The HTTP contract is identical: the same 33 operations on the same paths, so
`frontend/src/services/api.js` needed only a base-URL change.

Notable differences:

- **`firebase-admin` is gone.** Postgres has real indexed queries, so
  `getEmails` now orders and caps in SQL instead of sorting in memory. The
  search prefilter became `&&` array overlap against a GIN index.
- **JWT is hand-rolled on WebCrypto.** A 40 KB dependency to verify an HS256
  signature is not worth it in an edge function.
- **`jose` and `node:crypto` do not exist on Deno.** Every import was
  re-pointed, and `decryptSecret` became async.

## Known gaps

- **The store has never run against a real database.** Type-checks and the pure
  logic is tested (37 tests on Deno), but no query has executed.
- **`getEmails` caps at 500 rows.** Fine for a demo, wrong for a large mailbox.
- **Several `api.js` catch blocks fabricate successful responses** on failure.
  Two were fixed; the rest still do it.
- **No pagination** on the list endpoints.

## Tests

```bash
# Supabase edge function
cd supabase/functions && deno task test
cd supabase/functions && deno task lint

# Frontend
cd frontend && npm test
```

The Deno suite mirrors the Node one assertion for assertion, so if the two
ports drift, the shared tests fail.

Note: the edge function is plain JavaScript, so `deno check` will not type-check
it. Lint and the test suite are the guards.

## A dropped phishing signal, restored

Converting the edge function from TypeScript to JavaScript surfaced a real
regression rather than a compiler artifact: `deno lint` flagged an unused
`from` variable inside `heuristicPhishing`. It was unused because the
brand-impersonation check that read it had been lost when the function was
first ported from the Node build. The check is restored in both the `.js` and
the Node reference, so the phishing detector reports five indicators again
instead of four.
