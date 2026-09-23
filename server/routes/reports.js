// routes/reports.js - weekly briefing preview + manual trigger. Automatic
// weekly sends happen on a timer in index.js (see weeklyBriefing.js).

const express = require("express");
const { requireAuth } = require("../auth");
const { buildWeeklyBriefing, sendWeeklyBriefing } = require("../weeklyBriefing");

const router = express.Router();

// Computes the briefing WITHOUT sending it or marking a week as sent - safe
// to call as often as the dashboard wants, purely a read.
router.get("/weekly/preview", requireAuth("read"), async (req, res) => {
  const briefing = await buildWeeklyBriefing(req.db);
  res.json(briefing);
});

// Sends immediately through the configured channels, bypassing the
// Monday-only/once-per-week scheduling in checkWeeklyBriefing - useful for
// testing delivery config or sending an ad-hoc summary outside the normal
// cadence. Deliberately does NOT touch weekly_briefing_state, so it can't
// suppress or duplicate the automatic Monday send.
router.post("/weekly/send-now", requireAuth("read"), async (req, res) => {
  const briefing = await sendWeeklyBriefing(req.db);
  res.json({ ok: true, briefing });
});

module.exports = router;
