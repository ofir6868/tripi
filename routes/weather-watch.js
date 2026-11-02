// The switch on the stop sheet: "warn me if the weather here turns extreme".
// Per traveller and per stop — the push goes to whoever turned it on (lib/weather-watch.js).
// Only people on the trip can watch a stop: a gallery visitor is not travelling there.
const express = require('express');
const { pool } = require('../lib/db');
const { authRequired } = require('../lib/auth');
const { tripWithEditAuth } = require('../lib/trips');
const watch = require('../lib/weather-watch');

const router = express.Router();

router.put('/api/trips/code/:code/items/:itemId/weather-watch', authRequired, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const itemId = +req.params.itemId;
    const { rows } = await pool.query('SELECT 1 FROM trip_items WHERE id = $1 AND trip_id = $2', [itemId, trip.id]);
    if (!rows.length) return res.status(404).json({ error: 'התחנה לא נמצאה' });
    const on = !!(req.body && req.body.on);
    await watch.setWatch(req.user.id, itemId, on);
    res.json({ ok: true, on, watched: await watch.watchedItems(req.user.id, trip.id) });
  } catch (err) {
    console.error('weather watch toggle failed', err.message);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

module.exports = router;
