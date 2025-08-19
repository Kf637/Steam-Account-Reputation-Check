require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3100;

// Endpoint to get Steam API key (do NOT expose in production!)
app.get('/api/steam-key', (req, res) => {
  const key = process.env.STEAM_API_KEY || '';
  res.json({ key });
});

// Serve static files from workspace root (including trust.html and libs)
app.use(express.static(path.resolve(__dirname)));

// Fallback for all other routes to index.html (for direct navigation)
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
