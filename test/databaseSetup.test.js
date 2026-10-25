import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-bytes';
process.env.DATABASE_PATH = ':memory:';
delete process.env.ADMIN_PASSWORD;

const { db, initDatabase } = await import('../src/db.js');
const { verifyPassword } = await import('../src/auth.js');

describe('database initialization', () => {
  after(() => db.close());

  it('requires a configured admin password and starts without demo payment details', () => {
    assert.throws(initDatabase, /ADMIN_PASSWORD to at least 12 characters/);

    process.env.ADMIN_PASSWORD = 'test-admin-password-123';
    initDatabase();

    const admin = db.prepare('SELECT username, password_hash, salt FROM users').get();
    assert.equal(admin.username, 'admin');
    assert.equal(verifyPassword(process.env.ADMIN_PASSWORD, admin.password_hash, admin.salt), true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
    const settings = db.prepare('SELECT upi_id, account_name, bank_name, account_number, ifsc_code FROM payment_settings').get();
    assert.equal(settings.upi_id, '');
    assert.equal(settings.account_name, '');
    assert.equal(settings.bank_name, '');
    assert.equal(settings.account_number, '');
    assert.equal(settings.ifsc_code, '');
  });
});
