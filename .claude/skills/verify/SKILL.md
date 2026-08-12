---
name: verify
description: Run TRIPI locally and drive it to see a change working — server startup, minting a dev JWT, and hitting the authed API routes.
---

# Verifying TRIPI changes

## Run the app

`preview_start` with the `tripi` config in `.claude/launch.json` (`node server.js`).
Port 3000 is often taken by another session — `autoPort` picks a free one and the
result reports it. `.env` is loaded by `lib/env` and already holds `DATABASE_URL`
(the live Render Postgres) and `OPENAI_API_KEY`.

**No hot reload.** `node server.js` reads the source once — after every edit,
`preview_stop` then `preview_start` again, or you'll be looking at the old code
and think your change did nothing.

## Reach the authed API

Every `/api/ai/*` and most `/api/trips/*` routes are `authRequired`: a Bearer JWT,
no cookies. Locally `JWT_SECRET` is unset, so `lib/auth` falls back to
`tripi-dev-secret-change-me` and you can mint your own without registering a user:

```bash
node -e "console.log(require('jsonwebtoken').sign({id:999999,name:'verify'},'tripi-dev-secret-change-me',{expiresIn:'1h'}))"
```

Then POST with `fetch` from a scratchpad script — Hebrew payloads survive a JSON
file far better than shell quoting. A fake user id is fine: the AI quota is an
in-memory map, and `isAdmin` just misses in the DB.

## Models

Two tiers, named by capability rather than a vendor's model family (`AI_MODEL_WEAK`
/ `AI_MODEL_STRONG`, overridable via env vars of the same name) — swapping in a
different provider later is a two-variable change. `aiJson` takes a per-call `model`
and defaults to weak (`gpt-4o-mini`).

- `aiClarify` (the clarifying round) always uses strong (`gpt-4o`) — weak invents
  place names in Hebrew (it offered Warsaw and Bat Yam as regions of Malta).
- `aiGenerateBlock` picks per-block: `blockDays = to - from + 1`, strong when that's
  `> STRONG_MODEL_FROM_DAYS` (8). A single-area trip is one block spanning the whole
  range, so a 10-day one-city trip goes strong too, not just long multi-area blocks.
- Everything else (`aiPlanBlocks`, `aiTripMeta`, the trip editor) stays weak.

When judging output quality, check which model produced it before blaming the
prompt — a temporary `console.log` of `{area, blockDays, model}` in `aiGenerateBlock`
is the fastest way to confirm which tier a given build actually used; remove it
before finishing.

## What costs what

- `POST /api/ai/itinerary` with no `answers` key can return `{questions}` from one
  cheap clarify call (~2s). Sending `answers: []` skips that round.
- A full build is one OpenAI call per area block — keep `day_from`/`day_to` to 2–3
  days when you only need to see which branch ran.
- Builds return the itinerary in the response; **nothing is written to the DB**
  until the client saves the trip. Safe to drive against the live `DATABASE_URL`.
- To drive the real wizard UI, put the dev JWT in localStorage (`tripi_token` plus a
  `tripi_user` JSON blob) and open `/plan?dest=<יעד>&cc=<xx>` — a country pick lands
  straight on step 2. `/api/me` 401s for a synthetic user, which `refreshUser`
  swallows, so the page works anyway. The final `POST /api/trips` will 500 on a
  foreign-key violation (`owner_id` not in `users`) — everything up to and including
  the AI build is still real. To capture what the client sent, wrap `window.fetch`
  before triggering the build; request bodies aren't retrievable afterwards.

## Gotchas

- The default model is `gpt-4o-mini` (`AI_MODEL_WEAK` unset). Prompt changes need 2–3 runs to
  tell a real behavior change from sampling noise, it garbles some Hebrew proper
  nouns, and it follows positive instructions far better than negative ones —
  "don't ask X" gets ignored about as often as it's obeyed.
- Prompt position matters: instructions placed last, near the schema line, win over
  earlier examples.
- Naming the allowed *shape* of an answer ("every question must be about the route
  structure: which region, order, day split, transfers") holds far better than
  "only ask if it matters" — the model fills spare question slots with budget/food
  chatter otherwise. Capping the count ("one question only") also works.
- To tell a real regression from pre-existing behavior, diff against the baseline
  prompt: `git show HEAD:routes/ai.js > routes/ai.js` (back up your version first),
  restart, re-run the same payload, then restore. Twice now a "regression" turned
  out to be what the old prompt did too.
