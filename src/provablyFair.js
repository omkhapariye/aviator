import crypto from 'node:crypto';

/**
 * Generate a cryptographically secure 16-byte random Server Seed
 */
export function generateServerSeed() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate a Client Seed (or use player contributions)
 */
export function generateClientSeed() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Compute public SHA-256 hash of the server seed shown before the round starts
 */
export function hashServerSeed(serverSeed) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

/**
 * Calculate the crash multiplier from server seed and client seed.
 * Follows the standard 52-bit entropy SHA-512 derivation with 3% house edge (97 / (1 - r)).
 *
 * @param {string} serverSeed
 * @param {string} clientSeed
 * @returns {{ multiplier: number, combinedHash: string, hashSlice: string }}
 */
export function calculateCrashPoint(serverSeed, clientSeed) {
  const combined = `${serverSeed}:${clientSeed}`;
  const combinedHash = crypto.createHash('sha512').update(combined).digest('hex');

  // Take the first 13 hex characters (52 bits of entropy)
  const hashSlice = combinedHash.slice(0, 13);
  const n = parseInt(hashSlice, 16);

  // Normalize to [0, 1) using 2^52 = 4503599627370496
  const r = n / 4503599627370496;

  // Apply 3% House Edge: 97 / (1 - r) / 100
  // Every 33rd game on average results in an instant 1.00x crash
  let crashPoint;
  if (r >= 0.99) {
    crashPoint = 1.00;
  } else {
    const raw = (97 / (1 - r)) / 100;
    // Floor to 2 decimal places
    crashPoint = Math.floor(raw * 100) / 100;
    if (crashPoint < 1.00) crashPoint = 1.00;
  }

  // Max multiplier cap for stability (e.g. 1,000x or 10,000x)
  if (crashPoint > 1000.00) {
    crashPoint = 1000.00;
  }

  return {
    multiplier: parseFloat(crashPoint.toFixed(2)),
    combinedHash,
    hashSlice,
  };
}

/**
 * Verification helper for users to audit historical rounds
 */
export function verifyRound(serverSeed, clientSeed, expectedHash, expectedMultiplier) {
  const actualHash = hashServerSeed(serverSeed);
  const isHashValid = actualHash.toLowerCase() === expectedHash.toLowerCase();
  const calculated = calculateCrashPoint(serverSeed, clientSeed);
  const isMultiplierValid = Math.abs(calculated.multiplier - expectedMultiplier) < 0.01;

  return {
    valid: isHashValid && isMultiplierValid,
    isHashValid,
    isMultiplierValid,
    calculatedMultiplier: calculated.multiplier,
    combinedHash: calculated.combinedHash,
  };
}
