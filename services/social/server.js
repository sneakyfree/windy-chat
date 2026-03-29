/**
 * Windy Chat — Social Service
 * K9: Social Features (DNA Strand K)
 *
 * Handles social features:
 *   - User presence / online status
 *   - Status messages
 *   - Stories
 *
 * Port: 8105
 */

const express = require('express');
const cors = require('../shared/cors');
const health = require('../shared/health');
const asyncHandler = require('../shared/async-handler');

const app = express();
const PORT = process.env.PORT || 8105;

app.use(cors);
app.use(express.json());

// ── Health ──
app.get('/health', health);

// ── Placeholder routes ──
app.get('/api/v1/social/presence/:userId', asyncHandler(async (req, res) => {
  res.json({ userId: req.params.userId, status: 'online', lastSeen: new Date().toISOString() });
}));

app.listen(PORT, () => {
  console.log(`[social] listening on :${PORT}`);
});
