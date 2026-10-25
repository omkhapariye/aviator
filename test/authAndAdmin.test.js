import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, verifyPassword, generateToken, verifyToken } from '../src/auth.js';

describe('Auth & Admin Panel Logic', () => {
  let db;

  before(() => {
    // In-memory isolated DB for testing
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

      CREATE TABLE admin_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER,
        action TEXT NOT NULL,
        target_user_id INTEGER,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create root admin
    const adminPass = hashPassword('SuperAdminPass123!');
    db.prepare(`
      INSERT INTO users (username, password_hash, salt, role, balance, is_active)
      VALUES ('root_admin', ?, ?, 'admin', 50000.00, 1)
    `).run(adminPass.hash, adminPass.salt);

    // Create standard player
    const userPass = hashPassword('PlayerPass123!');
    db.prepare(`
      INSERT INTO users (username, password_hash, salt, role, balance, is_active)
      VALUES ('test_player', ?, ?, 'user', 1000.00, 1)
    `).run(userPass.hash, userPass.salt);
  });

  after(() => {
    db.close();
  });

  describe('Password & Token Functions', () => {
    it('should correctly hash and verify passwords', () => {
      const { hash, salt } = hashPassword('MySecretPass#2026');
      assert.strictEqual(verifyPassword('MySecretPass#2026', hash, salt), true);
      assert.strictEqual(verifyPassword('WrongPass', hash, salt), false);
    });

    it('should generate and verify JWT-style HMAC tokens', () => {
      const token = generateToken({ id: 42, username: 'testuser', role: 'admin' });
      assert.strictEqual(typeof token, 'string');

      const verified = verifyToken(token);
      assert.strictEqual(verified.id, 42);
      assert.strictEqual(verified.username, 'testuser');
      assert.strictEqual(verified.role, 'admin');
    });

    it('should reject tampered or invalid tokens', () => {
      const token = generateToken({ id: 1, username: 'legit' });
      const tampered = token.slice(0, -4) + 'abcd';
      assert.strictEqual(verifyToken(tampered), null);
      assert.strictEqual(verifyToken('invalid.token'), null);
    });
  });

  describe('Feature 1: Admin Full Access of Users', () => {
    it('should list all registered users with their balances and statistics', () => {
      const users = db.prepare(`
        SELECT u.id, u.username, u.role, u.balance, u.is_active
        FROM users u
      `).all();

      assert.strictEqual(users.length, 2);
      const player = users.find((u) => u.username === 'test_player');
      assert.ok(player);
      assert.strictEqual(player.role, 'user');
      assert.strictEqual(player.balance, 1000.00);
      assert.strictEqual(player.is_active, 1);
    });

    it('should allow admin to adjust user balance (+ and -)', () => {
      const player = db.prepare('SELECT id, balance FROM users WHERE username = ?').get('test_player');

      // Credit +$500
      const newBal1 = player.balance + 500;
      db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBal1, player.id);
      let updated = db.prepare('SELECT balance FROM users WHERE id = ?').get(player.id);
      assert.strictEqual(updated.balance, 1500.00);

      // Debit -$200
      const newBal2 = updated.balance - 200;
      db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBal2, player.id);
      updated = db.prepare('SELECT balance FROM users WHERE id = ?').get(player.id);
      assert.strictEqual(updated.balance, 1300.00);
    });

    it('should allow admin to ban and unban a user', () => {
      const player = db.prepare('SELECT id, is_active FROM users WHERE username = ?').get('test_player');
      assert.strictEqual(player.is_active, 1);

      // Ban user
      db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(player.id);
      let updated = db.prepare('SELECT is_active FROM users WHERE id = ?').get(player.id);
      assert.strictEqual(updated.is_active, 0);

      // Unban user
      db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(player.id);
      updated = db.prepare('SELECT is_active FROM users WHERE id = ?').get(player.id);
      assert.strictEqual(updated.is_active, 1);
    });
  });

  describe('Feature 2: Add Admins in Admin Panel', () => {
    it('should allow creating a new administrator account directly', () => {
      const { hash, salt } = hashPassword('NewAdminPass123!');
      const stmt = db.prepare(`
        INSERT INTO users (username, password_hash, salt, role, balance, is_active)
        VALUES ('ops_admin', ?, ?, 'admin', 25000.00, 1)
      `);
      const res = stmt.run(hash, salt);
      const newAdminId = Number(res.lastInsertRowid);

      const created = db.prepare('SELECT id, username, role, balance FROM users WHERE id = ?').get(newAdminId);
      assert.strictEqual(created.username, 'ops_admin');
      assert.strictEqual(created.role, 'admin');
      assert.strictEqual(created.balance, 25000.00);
    });

    it('should allow promoting an existing user to admin', () => {
      const player = db.prepare('SELECT id, role FROM users WHERE username = ?').get('test_player');
      assert.strictEqual(player.role, 'user');

      // Promote to admin
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(player.id);
      const promoted = db.prepare('SELECT id, role FROM users WHERE id = ?').get(player.id);
      assert.strictEqual(promoted.role, 'admin');

      // Demote back to user
      db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(player.id);
      const demoted = db.prepare('SELECT id, role FROM users WHERE id = ?').get(player.id);
      assert.strictEqual(demoted.role, 'user');
    });
  });
});
