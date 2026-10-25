import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hashPassword } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = process.env.DATABASE_PATH || join(__dirname, '..', 'aviator.db');

export const db = new DatabaseSync(dbPath);

export function initDatabase() {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      balance REAL NOT NULL DEFAULT 1000.00,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_seed TEXT NOT NULL,
      server_seed_hash TEXT NOT NULL,
      client_seed TEXT NOT NULL,
      combined_hash TEXT NOT NULL,
      crash_multiplier REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      slot_index INTEGER DEFAULT 0,
      amount REAL NOT NULL,
      auto_cashout REAL DEFAULT NULL,
      cashed_out_at REAL DEFAULT NULL,
      payout REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'placed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admin_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER,
      action TEXT NOT NULL,
      target_user_id INTEGER,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'upi',
      utr_number TEXT NOT NULL,
      sender_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by INTEGER,
      admin_notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewed_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payout_method TEXT NOT NULL DEFAULT 'upi',
      account_details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by INTEGER,
      admin_notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewed_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS payment_settings (
      id INTEGER PRIMARY KEY,
      upi_id TEXT NOT NULL DEFAULT '',
      account_name TEXT NOT NULL DEFAULT '',
      bank_name TEXT NOT NULL DEFAULT '',
      account_number TEXT NOT NULL DEFAULT '',
      ifsc_code TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT 'Payment details have not been configured. Contact an administrator.',
      razorpay_key_id TEXT NOT NULL DEFAULT '',
      razorpay_key_secret TEXT NOT NULL DEFAULT '',
      razorpay_enabled INTEGER NOT NULL DEFAULT 1
    );
  `);

  try {
    db.exec(`ALTER TABLE payment_settings ADD COLUMN razorpay_key_id TEXT NOT NULL DEFAULT ''`);
  } catch {}
  try {
    db.exec(`ALTER TABLE payment_settings ADD COLUMN razorpay_key_secret TEXT NOT NULL DEFAULT ''`);
  } catch {}
  try {
    db.exec(`ALTER TABLE payment_settings ADD COLUMN razorpay_enabled INTEGER NOT NULL DEFAULT 1`);
  } catch {}

  const checkSettings = db.prepare('SELECT id FROM payment_settings WHERE id = 1').get();
  if (!checkSettings) {
    db.prepare(`
      INSERT INTO payment_settings (id, upi_id, account_name, bank_name, account_number, ifsc_code, instructions, razorpay_key_id, razorpay_key_secret, razorpay_enabled)
      VALUES (1, '', '', '', '', '', 'Payment details have not been configured. Contact an administrator.', '', '', 1)
    `).run();
  }

  const checkAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!checkAdmin) {
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword || adminPassword.length < 12) {
      throw new Error('Set ADMIN_PASSWORD to at least 12 characters before initializing a new database');
    }

    const { hash, salt } = hashPassword(adminPassword);
    db.prepare(`
      INSERT INTO users (username, password_hash, salt, role, balance, is_active)
      VALUES (?, ?, ?, 'admin', 50000.00, 1)
    `).run('admin', hash, salt);
  }
}
