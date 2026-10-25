import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { GameEngine } from '../src/gameEngine.js';

describe('Game Engine State & Betting Lifecycle', () => {
  let db;
  let engine;

  before(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        balance REAL NOT NULL DEFAULT 1000.00,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_seed TEXT NOT NULL,
        server_seed_hash TEXT NOT NULL,
        client_seed TEXT NOT NULL,
        combined_hash TEXT NOT NULL,
        crash_multiplier REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE bets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        slot_index INTEGER DEFAULT 0,
        amount REAL NOT NULL,
        auto_cashout REAL DEFAULT NULL,
        cashed_out_at REAL DEFAULT NULL,
        payout REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'placed',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO users (username, password_hash, salt, role, balance, is_active)
      VALUES ('player_test', 'hash', 'salt', 'user', 1000.00, 1);
    `);

    engine = new GameEngine(db);
    // Manually control round state for deterministic tests
    engine.prepareNewRound();
  });

  after(() => {
    engine.stop();
    db.close();
  });

  it('should initialize round in WAITING state with valid seeds', () => {
    assert.strictEqual(engine.state, 'WAITING');
    assert.ok(engine.roundId > 0);
    assert.strictEqual(engine.serverSeed.length, 32);
    assert.strictEqual(engine.serverSeedHash.length, 64);
    assert.ok(engine.crashMultiplier >= 1.00);
  });

  it('should accept bets during WAITING state and deduct balance atomically', () => {
    const res = engine.placeBet(1, 'player_test', 0, 100.00, 2.50);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.balance, 900.00);

    const user = db.prepare('SELECT balance FROM users WHERE id = 1').get();
    assert.strictEqual(user.balance, 900.00);
    assert.strictEqual(engine.activeBets.size, 1);
  });

  it('should allow cancelling a bet and refunding balance during WAITING state', () => {
    const cancelRes = engine.cancelBet(1, 0);
    assert.strictEqual(cancelRes.success, true);
    assert.strictEqual(cancelRes.balance, 1000.00);

    const user = db.prepare('SELECT balance FROM users WHERE id = 1').get();
    assert.strictEqual(user.balance, 1000.00);
    assert.strictEqual(engine.activeBets.size, 0);
  });

  it('should support dual betting (slot 0 and slot 1)', () => {
    const bet1 = engine.placeBet(1, 'player_test', 0, 50.00);
    const bet2 = engine.placeBet(1, 'player_test', 1, 150.00, 1.80);

    assert.strictEqual(bet1.success, true);
    assert.strictEqual(bet2.success, true);
    assert.strictEqual(bet2.balance, 800.00);
    assert.strictEqual(engine.activeBets.size, 2);
  });

  it('should cash out successfully during FLYING state', () => {
    // Transition engine to FLYING state
    engine.state = 'FLYING';
    engine.currentMultiplier = 1.50;
    engine.crashMultiplier = 3.00;

    const cashout = engine.cashOutBet(1, 0, 1.50);
    assert.strictEqual(cashout.success, true);
    assert.strictEqual(cashout.multiplier, 1.50);
    assert.strictEqual(cashout.payout, 75.00); // 50 * 1.50 = 75
    assert.strictEqual(cashout.balance, 875.00); // 800 + 75 = 875

    const user = db.prepare('SELECT balance FROM users WHERE id = 1').get();
    assert.strictEqual(user.balance, 875.00);
  });

  it('should reject cashout if already cashed out', () => {
    const secondCashout = engine.cashOutBet(1, 0, 1.60);
    assert.strictEqual(secondCashout.success, false);
    assert.strictEqual(secondCashout.error, 'Already cashed out');
  });

  it('should settle uncashed bets as lost on crash', () => {
    // Slot 1 had 150 bet uncashed
    engine.handleCrash();

    assert.strictEqual(engine.state, 'CRASHED');
    const betInDb = db.prepare('SELECT status, payout FROM bets WHERE user_id = 1 AND slot_index = 1').get();
    assert.strictEqual(betInDb.status, 'lost');
    assert.strictEqual(betInDb.payout, 0);
  });
});
