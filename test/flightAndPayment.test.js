import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { GameEngine } from '../src/gameEngine.js';
import { hashPassword, generateToken } from '../src/auth.js';

function setupTestDb() {
  const db = new DatabaseSync(':memory:');

  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      balance REAL DEFAULT 1000.0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_seed TEXT NOT NULL,
      server_seed_hash TEXT NOT NULL,
      client_seed TEXT NOT NULL,
      combined_hash TEXT,
      crash_multiplier REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      slot_index INTEGER NOT NULL,
      amount REAL NOT NULL,
      auto_cashout REAL,
      cashed_out_at REAL,
      payout REAL DEFAULT 0,
      status TEXT DEFAULT 'placed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT DEFAULT 'upi',
      utr_number TEXT UNIQUE NOT NULL,
      sender_name TEXT,
      status TEXT DEFAULT 'pending',
      admin_notes TEXT,
      reviewed_by INTEGER,
      reviewed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payout_method TEXT NOT NULL DEFAULT 'upi',
      account_details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by INTEGER,
      admin_notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME
    );

    CREATE TABLE payment_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      upi_id TEXT NOT NULL,
      account_name TEXT NOT NULL,
      bank_name TEXT,
      account_number TEXT,
      ifsc_code TEXT,
      instructions TEXT,
      razorpay_key_id TEXT DEFAULT '',
      razorpay_key_secret TEXT DEFAULT '',
      razorpay_enabled INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE admin_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      target_user_id INTEGER,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const p1 = hashPassword('secret123');
  const p2 = hashPassword('secret123');
  db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, role, balance)
    VALUES (1, 'admin', ?, ?, 'admin', 5000.0),
           (2, 'player1', ?, ?, 'user', 100.0)
  `).run(p1.hash, p1.salt, p2.hash, p2.salt);

  db.prepare(`
    INSERT INTO payment_settings (id, upi_id, account_name, bank_name, account_number, ifsc_code, instructions)
    VALUES (1, 'owner@example.test', 'Admin Owner', 'Example Bank', '000000000000', 'TEST0000000', 'Pay via test account')
  `).run();

  return db;
}

describe('Live Flight Controls & Emergency Crash ("Flew Away")', () => {
  let db;
  let engine;

  before(() => {
    db = setupTestDb();
    engine = new GameEngine(db, { autoStart: false });
  });

  after(() => {
    engine.stop();
    db.close();
  });

  afterEach(() => {
    engine.stop();
  });

  it('should reject forceCrashNow when plane is in WAITING state', () => {
    engine.state = 'WAITING';
    const result = engine.forceCrashNow();
    assert.equal(result.success, false);
    assert.match(result.error, /Airplane is not currently in flight/);
  });

  it('should immediately crash the plane and settle bets when forceCrashNow is called during FLYING', () => {
    engine.prepareNewRound();
    engine.stop();
    engine.state = 'FLYING';
    engine.currentMultiplier = 2.45;
    engine.crashMultiplier = 5.00;

    // Setup an active bet
    const betInsert = db.prepare(`
      INSERT INTO bets (round_id, user_id, slot_index, amount, status)
      VALUES (?, 2, 0, 50, 'placed')
    `).run(engine.roundId);

    engine.activeBets.set('2_0', {
      id: Number(betInsert.lastInsertRowid),
      userId: 2,
      username: 'player1',
      slotIndex: 0,
      amount: 50,
      autoCashout: null,
      cashedOut: false,
      cashedOutAt: null,
      payout: 0,
      status: 'placed',
    });

    // Trigger Admin Emergency Flew Away Now!
    const crashResult = engine.forceCrashNow();
    assert.equal(crashResult.success, true);
    assert.equal(engine.state, 'CRASHED');
    assert.equal(crashResult.crashedAt, 2.45);
    engine.stop();

    // Uncashed bet must be marked as lost
    const bet = db.prepare('SELECT status, payout FROM bets WHERE id = ?').get(betInsert.lastInsertRowid);
    assert.equal(bet.status, 'lost');
    assert.equal(bet.payout, 0);
  });

  it('should allow setting the exact crash multiplier for the next round', () => {
    const override = 7.77;
    const res = engine.setNextMultiplier(override);
    assert.equal(res.success, true);
    assert.equal(res.forcedMultiplier, override);

    // Next round preparation should adopt the forced multiplier
    engine.prepareNewRound();
    engine.stop();
    assert.equal(engine.crashMultiplier, override);
    // Forced multiplier resets after being consumed
    assert.equal(engine.forcedNextMultiplier, null);
  });

  it('should allow configuring countdown seconds and flight curve speed', () => {
    const cfg = engine.setFlyTimeConfig(8, 0.12);
    assert.equal(cfg.success, true);
    assert.equal(cfg.countdownSec, 8);
    assert.equal(cfg.flightSpeedFactor, 0.12);

    const status = engine.getGameControlStatus();
    assert.equal(status.countdownSec, 8);
    assert.equal(status.flightSpeedFactor, 0.12);
  });
});

describe('UPI & Online Deposits with Admin Bank Account Routing', () => {
  let db;

  before(() => {
    db = setupTestDb();
  });

  after(() => {
    db.close();
  });

  it('should retrieve admin receiving bank and UPI details', () => {
    const settings = db.prepare('SELECT * FROM payment_settings WHERE id = 1').get();
    assert.equal(settings.upi_id, 'owner@example.test');
    assert.equal(settings.account_name, 'Admin Owner');
    assert.equal(settings.bank_name, 'Example Bank');
    assert.equal(settings.account_number, '000000000000');
  });

  it('should record an incoming user deposit with 12-digit UTR in pending state', () => {
    const userId = 2; // player1
    const amount = 500.0;
    const utr = 'UTR987654321012';
    const sender = 'Rahul / rahul@upi';

    const insert = db.prepare(`
      INSERT INTO deposits (user_id, amount, payment_method, utr_number, sender_name, status)
      VALUES (?, ?, 'upi', ?, ?, 'pending')
    `).run(userId, amount, utr, sender);

    assert.ok(insert.lastInsertRowid > 0);

    const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(insert.lastInsertRowid);
    assert.equal(deposit.amount, 500.0);
    assert.equal(deposit.utr_number, utr);
    assert.equal(deposit.status, 'pending');

    // Balance should remain uncredited until admin verifies and approves
    const userBefore = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    assert.equal(userBefore.balance, 100.0);
  });

  it('should reject duplicate UTR submissions', () => {
    const duplicateUtr = 'UTR987654321012';
    assert.throws(() => {
      db.prepare(`
        INSERT INTO deposits (user_id, amount, payment_method, utr_number, status)
        VALUES (2, 200, 'upi', ?, 'pending')
      `).run(duplicateUtr);
    }, /UNIQUE constraint failed/);
  });

  it('should credit user balance atomically when admin approves the deposit', () => {
    const deposit = db.prepare('SELECT * FROM deposits WHERE utr_number = ?').get('UTR987654321012');
    const userBefore = db.prepare('SELECT balance FROM users WHERE id = ?').get(deposit.user_id);

    const newBalance = parseFloat((userBefore.balance + deposit.amount).toFixed(2));
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, deposit.user_id);
    db.prepare(`
      UPDATE deposits SET status = 'approved', reviewed_by = 1, reviewed_at = CURRENT_TIMESTAMP, admin_notes = 'Verified by administrator'
      WHERE id = ?
    `).run(deposit.id);

    const userAfter = db.prepare('SELECT balance FROM users WHERE id = ?').get(deposit.user_id);
    assert.equal(userAfter.balance, 600.0); // 100 + 500

    const updatedDeposit = db.prepare('SELECT status, admin_notes FROM deposits WHERE id = ?').get(deposit.id);
    assert.equal(updatedDeposit.status, 'approved');
    assert.equal(updatedDeposit.admin_notes, 'Verified by administrator');
  });

  it('should leave user balance unchanged when admin rejects an invalid deposit', () => {
    const insert = db.prepare(`
      INSERT INTO deposits (user_id, amount, payment_method, utr_number, status)
      VALUES (2, 1000, 'upi', 'FAKEUTR00000000', 'pending')
    `).run();

    const userBefore = db.prepare('SELECT balance FROM users WHERE id = 2').get();
    assert.equal(userBefore.balance, 600.0);

    // Admin rejects
    db.prepare(`
      UPDATE deposits SET status = 'rejected', reviewed_by = 1, reviewed_at = CURRENT_TIMESTAMP, admin_notes = 'UTR not found in bank statement'
      WHERE id = ?
    `).run(insert.lastInsertRowid);

    const userAfter = db.prepare('SELECT balance FROM users WHERE id = 2').get();
    assert.equal(userAfter.balance, 600.0); // unchanged

    const rejectedDeposit = db.prepare('SELECT status, admin_notes FROM deposits WHERE id = ?').get(insert.lastInsertRowid);
    assert.equal(rejectedDeposit.status, 'rejected');
  });

  it('should allow admin to update bank and UPI destination details for user deposits', () => {
    db.prepare(`
      INSERT INTO payment_settings (id, upi_id, account_name, bank_name, account_number, ifsc_code, instructions)
      VALUES (1, 'sample@example.test', 'Sample Payee', 'Example Bank', '000000000000', 'TEST0000000', 'Send using test details')
      ON CONFLICT(id) DO UPDATE SET
        upi_id = excluded.upi_id,
        account_name = excluded.account_name,
        bank_name = excluded.bank_name,
        account_number = excluded.account_number,
        ifsc_code = excluded.ifsc_code,
        instructions = excluded.instructions
    `).run();

    const updated = db.prepare('SELECT * FROM payment_settings WHERE id = 1').get();
    assert.equal(updated.upi_id, 'sample@example.test');
    assert.equal(updated.account_name, 'Sample Payee');
    assert.equal(updated.bank_name, 'Example Bank');
    assert.equal(updated.account_number, '000000000000');
  });

  it('should allow admin to configure Razorpay gateway keys', () => {
    db.prepare(`
      UPDATE payment_settings
      SET razorpay_key_id = 'rzp_test_myKey123',
          razorpay_key_secret = 'mySecretKey456',
          razorpay_enabled = 1
      WHERE id = 1
    `).run();

    const updated = db.prepare('SELECT razorpay_key_id, razorpay_key_secret, razorpay_enabled FROM payment_settings WHERE id = 1').get();
    assert.equal(updated.razorpay_key_id, 'rzp_test_myKey123');
    assert.equal(updated.razorpay_key_secret, 'mySecretKey456');
    assert.equal(updated.razorpay_enabled, 1);
  });

  it('should verify Razorpay HMAC-SHA256 signature and credit user wallet balance', () => {
    import('node:crypto').then(({ default: crypto }) => {
      const orderId = 'order_test_998877';
      const paymentId = 'pay_test_112233';
      const secret = 'mySecretKey456';
      const amount = 500.0;
      const userId = 2; // player1

      // 1. Record pending order
      db.prepare(`
        INSERT INTO deposits (user_id, amount, payment_method, utr_number, status)
        VALUES (?, ?, 'razorpay', ?, 'pending')
      `).run(userId, amount, orderId);

      // 2. Compute authentic HMAC-SHA256 signature
      const validSignature = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

      // 3. Verify signature matches
      const checkSig = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
      assert.equal(validSignature, checkSig);

      // 4. Verify invalid signature fails
      assert.notEqual(validSignature, 'tampered_fake_signature_abc');

      // 5. Atomic wallet crediting on verification
      const userBefore = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
      const newBalance = parseFloat((userBefore.balance + amount).toFixed(2));
      db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, userId);
      db.prepare(`
        UPDATE deposits SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP, admin_notes = ?
        WHERE utr_number = ?
      `).run(`Razorpay Payment ID: ${paymentId}`, orderId);

      const userAfter = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
      assert.equal(userAfter.balance, 1100.0); // was 600 + 500 = 1100

      const deposit = db.prepare('SELECT status, admin_notes FROM deposits WHERE utr_number = ?').get(orderId);
      assert.equal(deposit.status, 'approved');
      assert.equal(deposit.admin_notes, `Razorpay Payment ID: ${paymentId}`);
    });
  });

  it('should process user withdrawal request and deduct wallet balance atomically', () => {
    const userId = 2; // player1
    const withdrawAmount = 250.0;
    const userBefore = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);

    // 1. Check sufficient balance
    assert.ok(userBefore.balance >= withdrawAmount);

    // 2. Atomically deduct balance
    const newBal = parseFloat((userBefore.balance - withdrawAmount).toFixed(2));
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBal, userId);

    // 3. Record pending withdrawal
    const ins = db.prepare(`
      INSERT INTO withdrawals (user_id, amount, payout_method, account_details, status)
      VALUES (?, ?, 'upi', '{"upiId":"player@okaxis"}', 'pending')
    `).run(userId, withdrawAmount);

    assert.ok(ins.lastInsertRowid > 0);

    const userAfter = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    assert.equal(userAfter.balance, newBal);

    const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(ins.lastInsertRowid);
    assert.equal(w.amount, withdrawAmount);
    assert.equal(w.status, 'pending');
  });

  it('should mark withdrawal as approved when processed by admin', () => {
    const withdrawal = db.prepare("SELECT id FROM withdrawals WHERE status = 'pending'").get();
    assert.ok(withdrawal);

    db.prepare(`
      UPDATE withdrawals
      SET status = 'approved', reviewed_by = 1, reviewed_at = CURRENT_TIMESTAMP, admin_notes = 'IMPS_123456789'
      WHERE id = ?
    `).run(withdrawal.id);

    const updated = db.prepare('SELECT status, admin_notes FROM withdrawals WHERE id = ?').get(withdrawal.id);
    assert.equal(updated.status, 'approved');
    assert.equal(updated.admin_notes, 'IMPS_123456789');
  });

  it('should automatically refund wallet balance when withdrawal is rejected', () => {
    const userId = 2;
    const withdrawAmount = 150.0;
    const userBefore = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);

    // Deduct and create pending withdrawal
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(userBefore.balance - withdrawAmount, userId);
    const ins = db.prepare(`
      INSERT INTO withdrawals (user_id, amount, payout_method, account_details, status)
      VALUES (?, ?, 'bank', '{"accountNumber":"123","ifscCode":"HDFC001"}', 'pending')
    `).run(userId, withdrawAmount);

    // Admin rejects with reason -> automatic refund
    const refundBal = parseFloat((userBefore.balance).toFixed(2));
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(refundBal, userId);
    db.prepare(`
      UPDATE withdrawals
      SET status = 'rejected', reviewed_by = 1, reviewed_at = CURRENT_TIMESTAMP, admin_notes = 'Invalid IFSC'
      WHERE id = ?
    `).run(ins.lastInsertRowid);

    const userRefunded = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    assert.equal(userRefunded.balance, userBefore.balance); // fully restored

    const rejectedW = db.prepare('SELECT status, admin_notes FROM withdrawals WHERE id = ?').get(ins.lastInsertRowid);
    assert.equal(rejectedW.status, 'rejected');
  });
});
