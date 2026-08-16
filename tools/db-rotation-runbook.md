# TRIPI free-tier database rotation — operator runbook

Render deletes every **free** Postgres instance 30 days after creation
(`expiresAt` on the instance). TRIPI stays on the free tier by *rotating*: just
before expiry, dump everything, let Render delete the old instance, create a
fresh free one, point the app at it, restore. This file is the full procedure.
It is written for the scheduled Claude session that performs the rotation, but
a human can follow it equally well.

Secrets (`ROTATION_TOKEN`, `DB_BACKUP_KEY`) are **not** in this file — the repo
is public. The scheduled triggers carry them; humans find them in the Render
dashboard (service env vars) or wherever they keep them.

## Fixed facts

- Workspace: `tea-d9j761cm0tmc73ahjiog` · Web service: `srv-d9qgmoijobas7382hu0g` (`tripi`)
- App URL: `https://tripi-caw3.onrender.com`
- Database: the single free Postgres named `tripi-db*` — **discover it by name via
  `list_postgres_instances`**, never hard-code its id (it changes every rotation).
- New instances: plan `free`, region `frankfurt`, version `16`, name `tripi-db-YYYYMMDD`.
- Escrow: branch `db-rotation-backups` of `ofir6868/tripi`, path
  `backups/tripi-db-<YYYYMMDD-HHmm>.json.enc` — AES-256-CBC (`openssl enc -aes-256-cbc
  -pbkdf2 -salt -pass pass:$DB_BACKUP_KEY`). **Never commit a plaintext dump — the
  repo is public.** Delete escrow files older than 60 days while you're there.

## Platform constraints (why the procedure looks like this)

- Render MCP has **no delete tool** and never reveals connection strings; its SQL
  tool is **read-only**. Direct Postgres connections (port 5432) are blocked from
  Claude containers. So: data moves only through the app's own
  `/api/rotation/*` endpoints (bearer `ROTATION_TOKEN`), deletion only happens by
  letting the instance expire, and `DATABASE_URL` can only be learned from the
  Render REST API (needs `RENDER_API_KEY` env var, if configured) or by the owner
  pasting it from the dashboard.
- Only **one** active free database is allowed — the new one cannot be created
  until Render has deleted the old one.

## Procedure

Run this starting ~35 minutes before `expiresAt`.

1. **Preflight.** `list_postgres_instances` → find `tripi-db*`, note `expiresAt`.
   `GET /api/rotation/status` (bearer token) → row counts. If the endpoint 404s,
   the rotation code isn't deployed on `main` — fall back: dump each table
   read-only via the MCP SQL tool (`SELECT coalesce(jsonb_agg(to_jsonb(x.*) ORDER
   BY id), '[]') FROM <table> x` — table list and order: `db/schema.js` `TABLES`),
   assemble the same `{format:1, dumped_at, counts, tables}` shape, and skip
   straight to step 3 — restore will have to wait for the endpoints to deploy.
2. **Dump.** `GET /api/rotation/dump` → file. Check `counts` equals status counts.
3. **Escrow before expiry.** Encrypt with `DB_BACKUP_KEY`, push to the escrow
   branch (create the branch from `main` if missing). *The old database may not
   die before this file is on GitHub.*
4. **Wait out the deletion.** After `expiresAt`, poll every ~10 minutes:
   `create_postgres` (name `tripi-db-YYYYMMDD`) — it fails with "more than one
   active free tier database" until Render has really deleted the old one, then
   succeeds. Use `send_later` self check-ins rather than long sleeps.
5. **Re-point DATABASE_URL.** With `RENDER_API_KEY` (env var) available:
   `GET https://api.render.com/v1/postgres/<newId>/connection-info` → take
   `externalConnectionString` → `update_environment_variables` on the service
   (key `DATABASE_URL`) → wait for the deploy to go live. Without the key:
   notify the owner to open the new database in the dashboard, copy **External
   Database URL**, and paste it into the `tripi` service's `DATABASE_URL` env
   var — then continue polling (send_later) until `/api/rotation/status`
   reports `empty: true`.
6. **Restore.** `POST /api/rotation/restore` with the dump JSON. It rebuilds the
   schema, inserts everything, fixes sequences, and refuses non-empty targets —
   if it 409s, stop and investigate; never force.
7. **Verify.** Response `counts` == dump `counts`; `GET /api/health` ok;
   `GET /api/trips/suggested` returns trips.
8. **Re-arm.** `get_postgres` on the new instance → `expiresAt` → create a
   run-once trigger at `expiresAt − 35min` carrying the same rotation prompt
   (secrets included). The weekly safety check re-creates it if this step is
   ever missed.
9. **Report.** Say what moved (row counts), the new instance id and expiry, and
   where the escrow file lives. If anything failed, say exactly where it
   stopped — the escrow file plus this runbook is enough for anyone to finish
   the job.

## Known losses

Writes between the dump (step 2) and the restore (step 6) are gone forever —
the window is ~35 minutes around 01:00 Israel time, once a month. If that ever
stops being acceptable, the clean exits are a paid Render plan (no expiry, no
rotation) or a free Postgres provider without expiry (Neon/Supabase) — one
`DATABASE_URL` swap and this whole file becomes history.
