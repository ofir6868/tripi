# TRIPI free-tier database rotation — operator runbook

Render deletes every **free** Postgres instance 30 days after creation
(`expiresAt` on the instance). TRIPI stays on the free tier by *rotating*: just
before expiry the data is dumped and escrowed, Render deletes the old instance,
a fresh free one is created, and the app **restores itself on boot**. This file
is the full procedure, written for the scheduled Claude session that performs
the rotation; a human can follow it equally well.

Secrets (`ROTATION_TOKEN`, `DB_BACKUP_KEY`) are **not** in this file — the repo
is public. The scheduled triggers carry them; humans find them in the Render
dashboard (service env vars).

> **Repo migration (2026-08-16):** production now deploys from
> `tripmaker/tripmaker` (service renamed `tripmaker`). The rotation *code*
> must live there. This repo (`ofir6868/tripi`) stays alive as the **escrow
> home**: the `db-rotation-backups` branch here is what the app's boot-restore
> fetches, and it is the branch the rotation automation can push to. Do not
> delete this repository or make it private without moving the escrow.

## Fixed facts

- Workspace: `tea-d9j761cm0tmc73ahjiog` · Web service: `srv-d9qgmoijobas7382hu0g` (`tripi`)
- App URL: `https://tripi-caw3.onrender.com`
- Database: the workspace's **single free Postgres** — discover it via
  `list_postgres_instances`, never hard-code the id (it changes every rotation)
  and don't trust the name alone (the owner renames it: it started as
  `tripi-db`, became `tripmaker-db`). One instance in the workspace = that's
  the one. A missing database means *zero* Postgres instances, nothing else.
- New instances: plan `free`, region `frankfurt`, version `16`, name `tripi-db-YYYYMMDD`.
- Escrow: branch `db-rotation-backups` of `ofir6868/tripi`,
  `backups/latest.json.enc` (+ a dated copy `backups/tripi-db-YYYYMMDD-HHmm.json.enc`),
  encrypted `openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:$DB_BACKUP_KEY`.
  **Never commit a plaintext dump — the repo is public.** Prune dated copies
  older than 60 days while you're there.

## Platform constraints (why the procedure looks like this)

Verified from a Claude session in this environment:

- Render MCP has **no delete tool**, never reveals connection strings, and its
  SQL tool is **read-only**. Deletion happens only by letting the instance expire.
- The session's egress policy **blocks** `tripi-caw3.onrender.com` and
  `api.render.com`; direct Postgres (5432) is blocked too. Sessions therefore
  cannot call the app or the Render REST API — only Render MCP + GitHub work.
- The **app itself** has open egress: on boot it re-discovers the live
  database via the Render REST API when `RENDER_API_KEY` is set as a service
  env var (`lib/db.js ensureDatabase`), and when its database is empty it
  fetches the escrow from GitHub raw, decrypts with `DB_BACKUP_KEY`, and
  restores (`lib/restore.js bootRestore`).
- Only **one** active free database may exist — creation succeeds only after
  Render has really deleted the expired one.

## Procedure

Start ~35 minutes before `expiresAt`.

1. **Preflight.** `list_postgres_instances` → find `tripi-db*`, note its id and
   `expiresAt`. Get row counts (read-only MCP SQL): every table in
   `db/schema.js` `TABLES`.
2. **Dump via MCP SQL** (read-only, chunked to keep results manageable).
   Build a **format-2** dump — schema-agnostic, so migrations added since this
   code shipped survive: replicate the catalog queries in `lib/restore.js
   buildDump()` (they are all plain SELECTs): FK-topo-sorted `tableOrder`
   (pg_tables + pg_constraint), `ddl` statements (pg_attribute/format_type
   column lists, pg_get_constraintdef, pg_indexes.indexdef, sequence
   ownership), `sequences` last_values (pg_sequences), and per table
   `SELECT coalesce(jsonb_agg(to_jsonb(x.*) ORDER BY <pk>), '[]') FROM <table> x`
   — chunk large tables (`trip_items`) by id range. Assemble
   `{format: 2, dumped_at, tableOrder, ddl, sequences, counts, tables}`
   exactly as `/api/rotation/dump` produces. Verify counts equal live counts.
   **Never dump from the fixed registry in `db/schema.js`** — it is a snapshot
   that drifts (on 2026-08-25 it was already missing `push_log`,
   `users.google_sub`, `trip_items.google_place_id`).
3. **Escrow before expiry.** Encrypt with `DB_BACKUP_KEY`, push to the escrow
   branch as `backups/latest.json.enc` plus the dated copy (git or GitHub MCP —
   the branch exists). *The old database must not die before this is on GitHub.*
4. **Wait out the deletion.** After `expiresAt`, try `create_postgres`
   (`tripi-db-YYYYMMDD`, free, frankfurt, 16) every ~10 minutes (`send_later`
   check-ins, not sleeps) — it fails with "more than one active free tier
   database" until the slot frees, then succeeds.
5. **Reboot the app** with `trigger_deploy`. On boot the app resolves the new
   instance via `RENDER_API_KEY` (if that env var is set on the service),
   finds it empty, and restores from the escrow automatically.
6. **Verify** (all via MCP): `list_logs` for the service should show
   `database resolved via Render API` (or no resolution needed) and
   `boot-restore: restored {...}`; read-only SQL against the **new** instance id
   should show counts equal to the dump; the deploy should be `live`.
   - If logs instead show `boot: database unavailable` — `RENDER_API_KEY` is
     not set on the service. Notify the owner: open the new database in the
     Render dashboard → copy **External Database URL** → paste into the `tripi`
     service env var `DATABASE_URL`. The deploy that env change triggers will
     boot-restore automatically. Keep checking in with `send_later` until
     verified.
7. **Re-arm.** `get_postgres` on the new instance → `expiresAt` → create a
   run-once trigger at `expiresAt − 35min`, firing into the rotation session,
   with the same rotation prompt (secrets included, expiry timestamp updated).
   A weekly safety trigger re-creates this if it's ever missing.
8. **Report.** Row counts moved, new instance id + expiry, escrow file path.
   If blocked: escrow first, then say exactly where it stopped — the escrow
   file plus this runbook lets anyone finish the job.

## Manual operation (owner, from any normal machine)

The app-side endpoints work from machines that can reach the app (the egress
restrictions above apply only to Claude's containers): `GET /api/rotation/dump`
with `Authorization: Bearer $ROTATION_TOKEN` is an instant full backup;
`POST /api/rotation/restore` fills an empty database with a dump. On-demand
backups before risky changes are one curl away.

## Known losses

Writes between the dump and the restore are gone — a ~35-minute window around
01:00 Israel time, monthly. If that ever stops being acceptable, the clean
exits are a paid Render plan or a free Postgres provider without expiry
(Neon/Supabase) — one `DATABASE_URL` swap and this file becomes history.
