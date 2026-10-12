# Production Deployment

The production backend is serverless: Supabase Edge Functions handle API and
Gmail OAuth requests, Supabase Postgres stores mail and OAuth credentials, and
Vercel hosts the frontend plus a same-origin API proxy. The old Render/FastAPI
instructions are no longer applicable.

Follow [docs/DEPLOY_SUPABASE.md](docs/DEPLOY_SUPABASE.md) to create the Supabase
schema, configure function secrets, deploy the Edge Function, and connect the
Vercel project. Set Vercel's root directory to `frontend` and its server-side
`SUPABASE_FUNCTION_URL` and `SUPABASE_ANON_KEY` variables; do not set a
`VITE_*` API URL for production.

## Local Gmail Development

1. Copy `backend/.env.example` to `backend/.env` and set the Google OAuth client
   ID, client secret, and a stable `JWT_SECRET`.
2. Register `http://localhost:8000/api/auth/callback` as an authorized redirect
   URI on that Google OAuth client. Enable the Gmail API in the same Google
   Cloud project.
3. Install `backend/requirements.txt`, then start the FastAPI API with
   `python backend/run.py`.
4. In another terminal, run `npm run dev --prefix frontend`. Vite forwards `/api`
   requests to the local FastAPI server.

The Vercel proxy and Supabase Edge Function keep the same `/api` contract in
production; callback and Gmail credential state there is stored in Supabase,
not in a serverless process's memory.
