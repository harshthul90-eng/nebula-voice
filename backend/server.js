require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const passport = require('passport');
const { setupSignaling } = require('./src/signaling');
const authRoutes = require('./src/auth');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());
app.use(passport.initialize());

// Routes
app.use('/api', authRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '1.0.0' });
});

// Setup WebSocket signaling (mounts on /ws path)
setupSignaling(server);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════╗
  ║   🎙️  Nebula Server v1.0.0     ║
  ║   Running on port ${PORT}            ║
  ╚═══════════════════════════════════╝
  `);
  if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === 'your-google-client-id.apps.googleusercontent.com') {
    console.warn('  ⚠️  Google OAuth not configured — copy .env.example to .env and add credentials');
  } else {
    console.log('  ✅  Google OAuth configured');
  }
});
