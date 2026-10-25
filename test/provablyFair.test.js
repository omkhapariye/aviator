import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  generateServerSeed,
  generateClientSeed,
  hashServerSeed,
  calculateCrashPoint,
  verifyRound,
} from '../src/provablyFair.js';

describe('Provably Fair Cryptographic Algorithm', () => {
  it('should generate valid 32-character hex server seeds', () => {
    const seed = generateServerSeed();
    assert.strictEqual(typeof seed, 'string');
    assert.strictEqual(seed.length, 32);
    assert.match(seed, /^[0-9a-f]{32}$/);
  });

  it('should compute valid SHA-256 public hash', () => {
    const serverSeed = '0123456789abcdef0123456789abcdef';
    const hash = hashServerSeed(serverSeed);
    assert.strictEqual(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('should calculate deterministic crash multipliers', () => {
    const serverSeed = 'test_server_seed_1234567890abcd';
    const clientSeed = 'test_client_seed_123';

    const r1 = calculateCrashPoint(serverSeed, clientSeed);
    const r2 = calculateCrashPoint(serverSeed, clientSeed);

    assert.strictEqual(r1.multiplier, r2.multiplier);
    assert.strictEqual(r1.combinedHash, r2.combinedHash);
    assert.ok(r1.multiplier >= 1.00);
  });

  it('should verify rounds accurately with verifyRound', () => {
    const serverSeed = generateServerSeed();
    const serverSeedHash = hashServerSeed(serverSeed);
    const clientSeed = generateClientSeed();

    const crashData = calculateCrashPoint(serverSeed, clientSeed);

    const verification = verifyRound(
      serverSeed,
      clientSeed,
      serverSeedHash,
      crashData.multiplier
    );

    assert.strictEqual(verification.valid, true);
    assert.strictEqual(verification.isHashValid, true);
    assert.strictEqual(verification.isMultiplierValid, true);
    assert.strictEqual(verification.calculatedMultiplier, crashData.multiplier);
  });

  it('should reject tampered seeds or mismatched multipliers', () => {
    const serverSeed = generateServerSeed();
    const fakeServerSeed = generateServerSeed();
    const serverSeedHash = hashServerSeed(serverSeed);
    const clientSeed = generateClientSeed();

    const verification = verifyRound(
      fakeServerSeed,
      clientSeed,
      serverSeedHash,
      2.50
    );

    assert.strictEqual(verification.valid, false);
    assert.strictEqual(verification.isHashValid, false);
  });
});
