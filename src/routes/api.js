import { Router } from 'express';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword, generateToken, authMiddleware } from '../auth.js';
import { verifyRound } from '../provablyFair.js';

export function createApiRouter(db, gameEngine) {
  const router = Router();

  // Register new user
  router.post('/auth/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const trimmed = username.trim();
    if (trimmed.length < 3 || trimmed.length > 20) {
      return res.status(400).json({ error: 'Username must be between 3 and 20 characters' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(trimmed);
    if (existing) {
      return res.status(409).json({ error: 'Username is already taken' });
    }

    const { hash, salt } = hashPassword(password);
    const initialBalance = 1000.00; // Free demo balance on sign up

    const stmt = db.prepare(`
      INSERT INTO users (username, password_hash, salt, role, balance, is_active)
      VALUES (?, ?, ?, 'user', ?, 1)
    `);
    const result = stmt.run(trimmed, hash, salt, initialBalance);
    const userId = Number(result.lastInsertRowid);

    const token = generateToken({ id: userId, username: trimmed, role: 'user' });

    res.json({
      success: true,
      token,
      user: {
        id: userId,
        username: trimmed,
        role: 'user',
        balance: initialBalance,
      },
    });
  });

  // Login
  router.post('/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account has been deactivated/banned' });
    }

    const isMatch = verifyPassword(password, user.password_hash, user.salt);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = generateToken({ id: user.id, username: user.username, role: user.role });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        balance: user.balance,
      },
    });
  });

  // Get current user profile
  router.get('/auth/me', authMiddleware(db), (req, res) => {
    res.json({
      user: {
        id: req.user.id,
        username: req.user.username,
        role: req.user.role,
        balance: req.user.balance,
      },
    });
  });

  // Demo Faucet / Deposit
  router.post('/wallet/deposit', authMiddleware(db), (req, res) => {
    const amount = parseFloat(req.body.amount || 500);
    if (isNaN(amount) || amount <= 0 || amount > 10000) {
      return res.status(400).json({ error: 'Invalid deposit amount (max 10,000 per request)' });
    }

    const newBalance = parseFloat((req.user.balance + amount).toFixed(2));
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, req.user.id);

    res.json({
      success: true,
      depositAmount: amount,
      balance: newBalance,
    });
  });

  // Request Wallet Withdrawal
  router.post('/wallet/withdraw', authMiddleware(db), (req, res) => {
    const amount = parseFloat(req.body.amount);
    const payoutMethod = req.body.payoutMethod === 'bank' ? 'bank' : 'upi';
    const upiId = (req.body.upiId || '').trim();
    const accountHolderName = (req.body.accountHolderName || req.body.accountName || '').trim();
    const bankName = (req.body.bankName || '').trim();
    const accountNumber = (req.body.accountNumber || '').trim();
    const ifscCode = (req.body.ifscCode || '').trim();

    if (isNaN(amount) || amount < 10) {
      return res.status(400).json({ error: 'Minimum withdrawal amount is $10.00' });
    }

    if (payoutMethod === 'upi' && (!upiId || upiId.length < 3)) {
      return res.status(400).json({ error: 'Please provide a valid UPI ID (e.g. name@okhdfcbank)' });
    }

    if (payoutMethod === 'bank' && (!accountNumber || !ifscCode || !accountHolderName)) {
      return res.status(400).json({ error: 'Please provide Account Holder Name, Account Number, and IFSC Code' });
    }

    // Refresh current user balance from DB
    const user = db.prepare('SELECT id, username, balance FROM users WHERE id = ?').get(req.user.id);
    if (!user || user.balance < amount) {
      return res.status(400).json({
        error: `Insufficient balance. Available: $${user ? user.balance.toFixed(2) : '0.00'}, Requested: $${amount.toFixed(2)}`
      });
    }

    const accountDetails = payoutMethod === 'upi'
      ? JSON.stringify({ upiId, accountHolderName: accountHolderName || user.username })
      : JSON.stringify({ accountHolderName, bankName, accountNumber, ifscCode });

    // Deduct balance atomically
    const newBalance = parseFloat((user.balance - amount).toFixed(2));
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, user.id);

    // Record pending withdrawal request
    const stmt = db.prepare(`
      INSERT INTO withdrawals (user_id, amount, payout_method, account_details, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);
    const info = stmt.run(user.id, amount, payoutMethod, accountDetails);

    res.json({
      success: true,
      withdrawalId: Number(info.lastInsertRowid),
      amount,
      newBalance,
      message: 'Withdrawal request submitted! Your funds will be transferred once approved by administrator.',
    });
  });

  // Get User's Withdrawal History
  router.get('/wallet/my-withdrawals', authMiddleware(db), (req, res) => {
    const rows = db.prepare(`
      SELECT id, amount, payout_method, account_details, status, admin_notes, created_at, reviewed_at
      FROM withdrawals
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 25
    `).all(req.user.id);

    const withdrawals = rows.map(r => {
      let parsed = {};
      try { parsed = JSON.parse(r.account_details); } catch {}
      return {
        id: r.id,
        amount: r.amount,
        payoutMethod: r.payout_method,
        destination: parsed.upiId ? `UPI: ${parsed.upiId}` : `A/C: ${parsed.accountNumber || ''} (${parsed.ifscCode || ''})`,
        status: r.status,
        adminNotes: r.admin_notes,
        createdAt: r.created_at,
        reviewedAt: r.reviewed_at,
      };
    });

    res.json({ withdrawals });
  });

  // ==================== ONLINE & UPI DEPOSIT SYSTEM ====================

  // Get active Admin UPI & Bank Account Details for payment
  router.get('/payment/info', (req, res) => {
    let settings = db.prepare('SELECT upi_id, account_name, bank_name, account_number, ifsc_code, instructions FROM payment_settings WHERE id = 1').get();
    if (!settings) {
      settings = {
        upi_id: '',
        account_name: '',
        bank_name: '',
        account_number: '',
        ifsc_code: '',
        instructions: 'Payment details have not been configured. Contact an administrator.',
      };
    }
    res.json({ settings });
  });

  // Submit UPI / Online Deposit Request with UTR Number
  router.post('/payment/deposit-request', authMiddleware(db), (req, res) => {
    const amount = req.body.amount;
    const paymentMethod = req.body.paymentMethod || req.body.payment_method || 'upi';
    const utrNumber = req.body.utrNumber || req.body.utr_number || req.body.utr;
    const senderName = req.body.senderName || req.body.sender_name || '';
    const numAmount = parseFloat(amount);

    if (isNaN(numAmount) || numAmount < 10 || numAmount > 100000) {
      return res.status(400).json({ error: 'Deposit amount must be between 10 and 100,000' });
    }

    if (!utrNumber || typeof utrNumber !== 'string' || utrNumber.trim().length < 6) {
      return res.status(400).json({ error: 'Please enter a valid 12-digit UPI / Bank Transaction UTR reference number' });
    }

    const trimmedUtr = utrNumber.trim();

    // Check if this UTR has already been submitted
    const existing = db.prepare('SELECT id FROM deposits WHERE utr_number = ?').get(trimmedUtr);
    if (existing) {
      return res.status(409).json({ error: 'This Transaction/UTR number has already been submitted for verification' });
    }

    const stmt = db.prepare(`
      INSERT INTO deposits (user_id, amount, payment_method, utr_number, sender_name, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `);
    const info = stmt.run(
      req.user.id,
      numAmount,
      paymentMethod || 'upi',
      trimmedUtr,
      senderName ? String(senderName).trim() : null
    );

    res.json({
      success: true,
      depositId: Number(info.lastInsertRowid),
      message: 'Deposit request submitted successfully! Your balance will be credited as soon as verified by the administrator.',
    });
  });

  // Get current user's deposit history
  router.get('/payment/my-deposits', authMiddleware(db), (req, res) => {
    const deposits = db.prepare(`
      SELECT id, amount, payment_method, utr_number, status, created_at, reviewed_at, admin_notes
      FROM deposits
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 20
    `).all(req.user.id);

    res.json({ deposits });
  });

  // Get round history with seeds
  router.get('/history', (req, res) => {
    const limit = Math.min(50, parseInt(req.query.limit || 25, 10));
    const history = gameEngine.getRecentHistory(limit);
    res.json({ history });
  });

  // Independent Provably Fair verification tool
  router.post('/verify', (req, res) => {
    const { serverSeed, clientSeed, expectedHash, expectedMultiplier } = req.body;
    if (!serverSeed || !clientSeed) {
      return res.status(400).json({ error: 'serverSeed and clientSeed are required' });
    }

    const verification = verifyRound(
      serverSeed,
      clientSeed,
      expectedHash || '',
      parseFloat(expectedMultiplier || 1.0)
    );

    res.json(verification);
  });

  // ==================== RAZORPAY PAYMENT GATEWAY ====================

  function getRazorpayConfig() {
    let row = db.prepare('SELECT razorpay_key_id, razorpay_key_secret, razorpay_enabled FROM payment_settings WHERE id = 1').get();
    const keyId = (row?.razorpay_key_id || process.env.RAZORPAY_KEY_ID || '').trim();
    const keySecret = (row?.razorpay_key_secret || process.env.RAZORPAY_KEY_SECRET || '').trim();
    const enabled = row ? Boolean(row.razorpay_enabled) : true;
    const isMock = !keySecret || keySecret.startsWith('mock_');
    return { keyId: keyId || 'rzp_test_sandbox_demo', keySecret, enabled, isMock };
  }

  // Get public Razorpay config
  router.get('/payment/razorpay/config', (req, res) => {
    const config = getRazorpayConfig();
    res.json({
      enabled: config.enabled,
      keyId: config.keyId,
      isMock: config.isMock,
    });
  });

  // Create Razorpay Order
  router.post('/payment/razorpay/create-order', authMiddleware(db), async (req, res) => {
    const amount = parseFloat(req.body.amount);
    if (isNaN(amount) || amount < 10 || amount > 100000) {
      return res.status(400).json({ error: 'Deposit amount must be between 10 and 100,000' });
    }

    const config = getRazorpayConfig();
    if (!config.enabled) {
      return res.status(400).json({ error: 'Razorpay payment gateway is currently disabled' });
    }

    const amountInPaise = Math.round(amount * 100);
    const receipt = `rcpt_${Date.now()}_${req.user.id}`;

    let orderId;
    let isMock = config.isMock;

    if (!isMock) {
      // Real Razorpay API Order Creation
      try {
        const rzpResponse = await fetch('https://api.razorpay.com/v1/orders', {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64'),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: amountInPaise,
            currency: 'INR',
            receipt,
            notes: {
              userId: req.user.id,
              username: req.user.username,
            },
          }),
        });

        if (!rzpResponse.ok) {
          const errData = await rzpResponse.json();
          return res.status(502).json({ error: errData.error?.description || 'Razorpay order creation failed' });
        }

        const rzpOrder = await rzpResponse.json();
        orderId = rzpOrder.id;
      } catch (err) {
        return res.status(500).json({ error: 'Network error communicating with Razorpay' });
      }
    } else {
      // Sandbox Mock Order Generator for developer testing
      orderId = `order_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    // Record pending deposit in DB
    const stmt = db.prepare(`
      INSERT INTO deposits (user_id, amount, payment_method, utr_number, sender_name, status)
      VALUES (?, ?, 'razorpay', ?, ?, 'pending')
    `);
    stmt.run(req.user.id, amount, orderId, req.user.username);

    res.json({
      orderId,
      amount: amountInPaise,
      currency: 'INR',
      keyId: config.keyId,
      isMock,
    });
  });

  // Verify Razorpay Payment Signature and Credit Wallet
  router.post('/payment/razorpay/verify', authMiddleware(db), (req, res) => {
    const { orderId, paymentId, signature } = req.body;
    if (!orderId || !paymentId) {
      return res.status(400).json({ error: 'orderId and paymentId are required' });
    }

    const config = getRazorpayConfig();

    // Verify signature if in live/test mode with secret key
    if (!config.isMock) {
      if (!signature) {
        return res.status(400).json({ error: 'Signature is required for verification' });
      }
      const generatedSignature = crypto
        .createHmac('sha256', config.keySecret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      if (generatedSignature !== signature) {
        return res.status(400).json({ error: 'Invalid payment signature. Verification failed.' });
      }
    }

    // Find pending deposit
    const deposit = db.prepare('SELECT * FROM deposits WHERE utr_number = ? AND user_id = ?').get(orderId, req.user.id);
    if (!deposit) {
      return res.status(404).json({ error: 'Pending deposit record not found for this order' });
    }

    if (deposit.status === 'approved') {
      const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
      return res.json({ success: true, message: 'Deposit already credited', balance: user.balance });
    }

    // Atomically credit user balance & update deposit status
    const user = db.prepare('SELECT id, username, balance FROM users WHERE id = ?').get(req.user.id);
    const newBalance = parseFloat((user.balance + deposit.amount).toFixed(2));

    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, req.user.id);
    db.prepare(`
      UPDATE deposits
      SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP, admin_notes = ?
      WHERE id = ?
    `).run(`Razorpay Payment ID: ${paymentId}`, deposit.id);

    // Audit log
    db.prepare(`
      INSERT INTO admin_logs (admin_id, action, target_user_id, details)
      VALUES (?, 'razorpay_deposit_credited', ?, ?)
    `).run(
      req.user.id,
      req.user.id,
      JSON.stringify({ orderId, paymentId, amount: deposit.amount, newBalance, isMock: config.isMock })
    );

    res.json({
      success: true,
      message: `Deposit of $${deposit.amount.toFixed(2)} credited successfully!`,
      balance: newBalance,
      amount: deposit.amount,
    });
  });

  return router;
}
