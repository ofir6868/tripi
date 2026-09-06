# TRIP MAKER free-tier database rotation — runbook

Render deletes every **free** Postgres 30 days after it's created (`expiresAt` on the
instance). TRIP MAKER stays on the free tier by rotating: the data is backed up
continuously to an encrypted file on GitHub, Render deletes the old instance, a fresh
free one is created, and **the app restores itself on boot**. All of this now lives in
this repo — there is no separate rotation project and no scheduled chat session in the
critical path.

## The moving parts (all in this repo)

- **`lib/rotation-backup.js`** — on a timer (default every 24h) the running app dumps
  every table, encrypts the dump with `DB_BACKUP_KEY`, and commits it to the escrow branch
  on GitHub. This is the backup half, and it needs no human and no chat session. It is a
  no-op unless both `DB_BACKUP_KEY` and `ESCROW_GITHUB_TOKEN` are set. It never escrows a
  database with zero users (nothing to protect).
- **`lib/db-restore.js`** — on boot, when the database holds no real data (no users, only
  the demo seed), the app fetches the escrow over HTTPS, decrypts it, and rebuilds every
  table in FK order, continuing each id sequence. `RESTORE_FROM_ESCROW=1` forces it once
  over demo data.
- **`lib/db.js` `ensureDatabase`** — on boot, if the database is unreachable and
  `RENDER_API_KEY` is set, the app finds the current instance through the Render API and
  reconnects, so a rotation needs no `DATABASE_URL` edit.
- **`routes/rotation.js`** — manual `GET /api/rotation/status`, `GET /api/rotation/dump`,
  `POST /api/rotation/restore`, behind `ROTATION_TOKEN`, for backup/restore by hand from
  any machine that can reach the app.
- **`db/setup.js` + `db/migrate.js`** — the schema and migrations, run idempotently on
  every boot by `lib/db-bootstrap.js`.

## Environment

| var | what it does |
|---|---|
| `DB_BACKUP_KEY` | encrypts/decrypts the escrow (`openssl enc -aes-256-cbc -pbkdf2`). **Required** for both backup and restore. |
| `ESCROW_GITHUB_TOKEN` | a token that can push to the escrow repo. Set it to turn on in-app backups. |
| `ESCROW_REPO` / `ESCROW_BRANCH` | where the escrow lives. Default `ofir6868/tripi` / `db-rotation-backups` (a public repo the unauthenticated restore can read). Point both at this repo once it's confirmed public + the token can push here. |
| `RESTORE_SOURCE_URL` | overrides the escrow read URL outright, if you don't want it derived from `ESCROW_REPO`. |
| `RENDER_API_KEY` | lets the app rediscover the live instance after a rotation. Optional but makes rotation hands-off. |
| `ROTATION_TOKEN` | bearer token for the manual `/api/rotation/*` endpoints. |
| `RESTORE_FROM_ESCROW` | `1` = force a one-time restore over demo/seed data. Remove after. |
| `BACKUP_INTERVAL_HOURS` | backup cadence, default 24. |

## Normal life

Nothing to do. The app backs itself up daily and restores itself on a fresh instance.
Worst-case data loss is one backup interval (default 24h) around an unplanned instance
loss; a planned rotation loses only writes between the last backup and the cutover.

## When a free instance is about to expire (the one manual step Render forces)

Render has no API to delete an instance and only allows one active free instance at a
time, so a new one can't be created until the old expires. About 35 minutes before
`expiresAt`:

1. Confirm a fresh backup exists (the daily timer already made one; or hit
   `GET /api/rotation/dump` / wait for the next tick). This is the only thing that must be
   true before the old instance dies.
2. After `expiresAt`, create a new free Postgres (`tripi-db-YYYYMMDD`, free, same region,
   version 16). With Render MCP: `create_postgres`; it fails with "more than one active
   free tier database" until the old slot frees, so retry every ~10 min.
3. Point the app at it: set `DATABASE_URL` to the new instance's connection string, **or**,
   with `RENDER_API_KEY` set, just `trigger_deploy` — `ensureDatabase` finds it.
4. On boot the app sees an empty instance and restores from the escrow. Verify in the logs:
   `db-restore: restored {...}`. Done.

This step can be a person, or a scheduled Routine that drives the Render MCP tools. It is
no longer in the data-safety path — the backup is already on GitHub before it runs.

## The clean exit

The 30-day expiry is the whole reason this exists. Moving to a Postgres without it — a
paid Render plan, or a free provider like Neon or Supabase — makes this file history: set
`DATABASE_URL` to the new database once and delete the rotation env vars.
