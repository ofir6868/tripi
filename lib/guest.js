// A guest: a traveller who started planning before opening an account.
//
// The sign-up wall used to stand at the moment a trip would be created — after the whole
// wizard, before anything had been built. In the thirty days before this file, thirteen
// people pressed "create", eight were shown the wall, one got past it. A wall in front
// of something nobody has seen yet is where the product loses most of the people who
// wanted it. So the wall moved: it now stands where the trip becomes real to other
// people (saving it and revealing its share code, joining someone else's trip), and
// everything before that — the wizard, the planning chat, the AI build, editing —
// works for a guest.
//
// A guest is an ordinary users row with no email and no password (is_guest = true), and
// an ordinary JWT with `guest: true` on it. That choice is what keeps the rest of the
// code unchanged: owner_id, participants, the AI quotas (lib/quota.js) and the planning
// memory all key on a user id, and a guest has one. What changes is only the two
// moments at which the guest stops being one:
//
//   sign up   → the guest row itself becomes the account: name, email and password are
//               written onto it (claimGuest). Nothing moves, nothing can be lost.
//   log in    → the guest's trips, memberships and votes move to the existing account
//               (mergeGuestInto), and the empty guest row is deleted.
//
// The same two moments exist for Google sign-in (routes/auth.js).
//
// What a guest cannot do is exactly what needs a person behind it: reveal a share code
// (routes/trips.js /publish) and redeem an invite to someone else's trip — a co-planner
// called "אורח" is nobody the others can recognise.
const GUEST_NAME = 'אורח';

async function createGuest(pool) {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, is_guest) VALUES ($1, NULL, NULL, true)
     RETURNING id, name, email, is_admin, is_guest`,
    [GUEST_NAME]
  );
  return rows[0];
}

// The guest row becomes the account. Only a row that is still a guest can be claimed —
// a token that outlived its claim (two tabs, two sign-ups) finds nothing and the caller
// falls back to an ordinary registration. A taken email surfaces as 23505, the same way
// it does on a plain register.
async function claimGuest(pool, guestId, { name, email, passwordHash = null, googleSub = null }) {
  const { rows } = await pool.query(
    `UPDATE users SET name = $1, email = lower($2), password_hash = $3, google_sub = $4, is_guest = false
      WHERE id = $5 AND is_guest
      RETURNING id, name, email, is_admin`,
    [name, email, passwordHash, googleSub, guestId]
  );
  return rows[0] || null;
}

// Everything the guest did becomes the account's, and the guest row goes. Row by row,
// because each table has its own idea of a duplicate: a trip has one owner and simply
// moves; a membership or a vote the account already holds is kept as the account's and
// the guest's copy is dropped with the row; a day's AI usage is added to the account's,
// so logging in is not a way to a second daily quota.
async function mergeGuestInto(pool, guestId, userId) {
  if (!guestId || !userId || guestId === userId) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT 1 FROM users WHERE id = $1 AND is_guest FOR UPDATE', [guestId]);
    if (!rows[0]) { await client.query('ROLLBACK'); return false; }
    await client.query('UPDATE trips SET owner_id = $2 WHERE owner_id = $1', [guestId, userId]);
    await client.query(
      `INSERT INTO trip_participants (trip_id, user_id, joined_at)
       SELECT trip_id, $2, joined_at FROM trip_participants WHERE user_id = $1
       ON CONFLICT DO NOTHING`, [guestId, userId]);
    // a membership in a trip the account now owns is redundant — the owner is a
    // participant implicitly, and /api/my-trips would list the trip twice otherwise
    await client.query(
      'DELETE FROM trip_participants WHERE user_id = $1 AND trip_id IN (SELECT id FROM trips WHERE owner_id = $1)', [userId]);
    await client.query(
      `INSERT INTO trip_stop_votes (item_id, user_id, vote)
       SELECT item_id, $2, vote FROM trip_stop_votes WHERE user_id = $1
       ON CONFLICT DO NOTHING`, [guestId, userId]);
    await client.query('UPDATE trip_plan_messages SET user_id = $2 WHERE user_id = $1', [guestId, userId]);
    await client.query('UPDATE trip_expense_settlements SET settled_by = $2 WHERE settled_by = $1', [guestId, userId]);
    await client.query(
      `INSERT INTO ai_usage (user_id, meter, day, count)
       SELECT $2, meter, day, count FROM ai_usage WHERE user_id = $1
       ON CONFLICT (user_id, meter, day) DO UPDATE SET count = ai_usage.count + EXCLUDED.count`, [guestId, userId]);
    // push_subscriptions: an endpoint is one browser, and the browser that held the guest
    // is the one logging in — the subscription follows it
    await client.query('UPDATE push_subscriptions SET user_id = $2 WHERE user_id = $1', [guestId, userId])
      .catch((err) => { if (err.code !== '42P01') throw err; }); // table exists only after migration 10
    await client.query('DELETE FROM users WHERE id = $1 AND is_guest', [guestId]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { GUEST_NAME, createGuest, claimGuest, mergeGuestInto };
