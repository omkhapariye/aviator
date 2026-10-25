import http from 'node:http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { initDatabase, db } from './src/db.js';
import { verifyToken } from './src/auth.js';
import { GameEngine } from './src/gameEngine.js';
import { createApiRouter } from './src/routes/api.js';
import { createAdminRouter } from './src/routes/admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize DB schema & default seeds
initDatabase();

// Initialize Game Engine
const gameEngine = new GameEngine(db);

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Mount API routes
app.use('/api', createApiRouter(db, gameEngine));
app.use('/api/admin', createAdminRouter(db, gameEngine));

// Fallback index
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Store connected clients with optional user session
const clients = new Map(); // ws -> { userId, username, role }

function broadcast(data) {
  const message = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// Forward game engine events to connected clients
gameEngine.on('tick', (data) => {
  broadcast({ type: 'tick', ...data });
});

gameEngine.on('flight_start', (data) => {
  broadcast({ type: 'flight_start', ...data });
});

gameEngine.on('crashed', (data) => {
  broadcast({ type: 'crashed', ...data });
});

gameEngine.on('sim_cashout', (data) => {
  broadcast({ type: 'sim_cashout', ...data });
});

gameEngine.on('bet_placed', (data) => {
  broadcast({ type: 'bet_placed', ...data });
});

gameEngine.on('bet_won', (data) => {
  broadcast({ type: 'bet_won', ...data });
});

gameEngine.on('bet_cancelled', (data) => {
  broadcast({ type: 'bet_cancelled', ...data });
});

wss.on('connection', (ws, req) => {
  let session = { userId: null, username: null, role: null };
  clients.set(ws, session);

  // Parse token from query if provided: ws://host/ws?token=...
  try {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (token) {
      const payload = verifyToken(token);
      if (payload) {
        session.userId = payload.id;
        session.username = payload.username;
        session.role = payload.role;
      }
    }
  } catch {}

  // Send initial state synchronization to new client
  ws.send(JSON.stringify({
    type: 'init_state',
    ...gameEngine.getCurrentStateForClient(session.userId),
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'auth') {
        const payload = verifyToken(msg.token);
        if (payload) {
          session.userId = payload.id;
          session.username = payload.username;
          session.role = payload.role;
          const user = db.prepare('SELECT id, username, role, balance FROM users WHERE id = ?').get(payload.id);
          ws.send(JSON.stringify({ type: 'auth_success', user }));
          ws.send(JSON.stringify({
            type: 'init_state',
            ...gameEngine.getCurrentStateForClient(session.userId),
          }));
        } else {
          ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
        }
        return;
      }

      if (msg.type === 'place_bet') {
        if (!session.userId) {
          return ws.send(JSON.stringify({ type: 'error', message: 'You must be logged in to place bets' }));
        }
        const result = gameEngine.placeBet(
          session.userId,
          session.username,
          msg.slotIndex ?? 0,
          msg.amount,
          msg.autoCashout
        );
        if (!result.success) {
          ws.send(JSON.stringify({ type: 'error', message: result.error }));
        } else {
          ws.send(JSON.stringify({
            type: 'bet_success',
            slotIndex: msg.slotIndex ?? 0,
            bet: result.bet,
            balance: result.balance,
          }));
        }
        return;
      }

      if (msg.type === 'cancel_bet') {
        if (!session.userId) return;
        const result = gameEngine.cancelBet(session.userId, msg.slotIndex ?? 0);
        if (!result.success) {
          ws.send(JSON.stringify({ type: 'error', message: result.error }));
        } else {
          ws.send(JSON.stringify({
            type: 'cancel_success',
            slotIndex: msg.slotIndex ?? 0,
            balance: result.balance,
          }));
        }
        return;
      }

      if (msg.type === 'cash_out') {
        if (!session.userId) {
          return ws.send(JSON.stringify({ type: 'error', message: 'Not logged in' }));
        }
        const result = gameEngine.cashOutBet(session.userId, msg.slotIndex ?? 0);
        if (!result.success) {
          ws.send(JSON.stringify({ type: 'error', message: result.error }));
        } else {
          ws.send(JSON.stringify({
            type: 'cashout_success',
            slotIndex: msg.slotIndex ?? 0,
            multiplier: result.multiplier,
            payout: result.payout,
            balance: result.balance,
          }));
        }
        return;
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message payload' }));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Aviator Crash Game Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket endpoint active at ws://localhost:${PORT}/ws`);
  console.log(`🔑 Admin account: admin (password supplied through ADMIN_PASSWORD)`);
  console.log(`=======================================================`);
  gameEngine.start();
});

export { app, server, gameEngine, db };
