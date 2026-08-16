# TRIPI database escrow

Encrypted database dumps for the monthly free-tier rotation
(see `tools/db-rotation-runbook.md` on `main`).

- `latest.json.enc` — the newest dump; the app's boot-time self-restore reads
  exactly this path.
- `tripi-db-YYYYMMDD-HHmm.json.enc` — dated copies, pruned after 60 days.

Files are AES-256-CBC encrypted (`openssl enc -aes-256-cbc -pbkdf2 -salt`).
The key (`DB_BACKUP_KEY`) is **not** in this repository. Plaintext dumps must
never be committed here — the repository is public.
