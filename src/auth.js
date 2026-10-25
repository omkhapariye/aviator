import crypto from 'node:crypto';

function loadJwtSecret() {
  const configuredSecret = process.env.JWT_SECRET?.trim();
  if (configuredSecret) {
    if (process.env.NODE_ENV === 'production' && Buffer.byteLength(configuredSecret) < 32) {
      throw new Error('JWT_SECRET must be at least 32 bytes in production');
    }
    return configuredSecret;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }

  return crypto.randomBytes(32);
}

const JWT_SECRET = loadJwtSecret();

/**
 * Hash password using scrypt
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

/**
 * Verify password against stored hash and salt
 */
export function verifyPassword(password, storedHash, salt) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

/**
 * Generate a signed HMAC token (simulating JWT payload)
 */
export function generateToken(payload, expiresInSeconds = 86400) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const data = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${data}`)
    .digest('base64url');
  return `${header}.${data}.${signature}`;
}

/**
 * Verify signed token
 */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, data, signature] = parts;
  const expectedSig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${data}`)
    .digest('base64url');

  if (signature !== expectedSig) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return null; // Expired
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Express middleware for authentication
 */
export function authMiddleware(db) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];
    const payload = verifyToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const user = db.prepare('SELECT id, username, role, balance, is_active FROM users WHERE id = ?').get(payload.id);
    if (!user) {
      return res.status(401).json({ error: 'User no longer exists' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account has been deactivated/banned by an administrator' });
    }

    req.user = user;
    next();
  };
}

/**
 * Express middleware requiring admin role
 */
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required' });
  }
  next();
}
