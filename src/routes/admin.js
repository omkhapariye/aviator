import { Router } from 'express';
import { authMiddleware, requireAdmin, hashPassword } from '../auth.js';

export function createAdminRouter(db, gameEngine) {
  const router = Router();

  // Protect all admin routes with authentication and admin role check
  router.use(authMiddleware(db));
  router.use(requireAdmin);

  // 1. Overall System KPI & Statistics
  router.get('/stats', (req, res) => {
    const userStats = db.prepare(`
      SELECT
        COUNT(*) as totalUsers,
        SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as totalAdmins,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as activeUsers,
        SUM(balance) as totalUserBalances
      FROM users
    `).get();

    const betStats = db.prepare(`
      SELECT
        COUNT(*) as totalBets,
        COALESCE(SUM(amount), 0) as totalWagered,
        COALESCE(SUM(payout), 0) as totalPaidOut
      FROM bets
    `).get();

    const roundCount = db.prepare('SELECT COUNT(*) as totalRounds FROM rounds').get();

    const houseProfit = parseFloat((betStats.totalWagered - betStats.totalPaidOut).toFixed(2));

    res.json({
      stats: {
        totalUsers: userStats.totalUsers || 0,
        totalAdmins: userStats.totalAdmins || 0,
        activeUsers: userStats.activeUsers || 0,
        totalUserBalances: parseFloat((userStats.totalUserBalances || 0).toFixed(2)),
        totalBets: betStats.totalBets || 0,
        totalWagered: parseFloat((betStats.totalWagered || 0).toFixed(2)),
        totalPaidOut: parseFloat((betStats.totalPaidOut || 0).toFixed(2)),
        houseProfit,
        totalRounds: roundCount.totalRounds || 0,
        currentGameRound: gameEngine.roundId,
        currentGameState: gameEngine.state,
      },
    });
  });

  // 2. Feature 1: Full Access of Users
  router.get('/users', (req, res) => {
    const search = req.query.search ? `%${req.query.search.trim()}%` : '%';
    const limit = Math.min(100, parseInt(req.query.limit || 50, 10));
    const offset = parseInt(req.query.offset || 0, 10);

    const users = db.prepare(`
      SELECT
        u.id,
        u.username,
        u.role,
        u.balance,
        u.is_active,
        u.created_at,
        COUNT(b.id) as total_bets,
        COALESCE(SUM(b.amount), 0) as total_wagered,
        COALESCE(SUM(b.payout), 0) as total_won
      FROM users u
      LEFT JOIN bets b ON u.id = b.user_id
      WHERE u.username LIKE ?
      GROUP BY u.id
      ORDER BY u.id DESC
      LIMIT ? OFFSET ?
    `).all(search, limit, offset);

    const totalCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE username LIKE ?').get(search).count;

    res.json({
      users: users.map((u) => ({
        ...u,
        balance: parseFloat(u.balance.toFixed(2)),
        total_wagered: parseFloat(u.total_wagered.toFixed(2)),
        total_won: parseFloat(u.total_won.toFixed(2)),
        net_profit: parseFloat((u.total_won - u.total_wagered).toFixed(2)),
      })),
      total: totalCount,
      limit,
      offset,
    });
  });

  // Get specific user detail and recent bets
  router.get('/users/:id', (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const user = db.prepare('SELECT id, username, role, balance, is_active, created_at FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const bets = db.prepare(`
      SELECT id, round_id, amount, auto_cashout, cashed_out_at, payout, status, created_at
      FROM bets
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 50
    `).all(userId);

    res.json({ user, bets });
  });

  // Adjust User Balance (Credit or Debit)
  router.post('/users/:id/balance', (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const { amount, reason } = req.body;
    const delta = parseFloat(amount);

    if (isNaN(delta) || delta === 0) {
      return res.status(400).json({ error: 'Valid nonzero adjustment amount is required' });
    }

    const user = db.prepare('SELECT id, username, balance FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const newBalance = parseFloat((user.balance + delta).toFixed(2));
    if (newBalance < 0) {
      return res.status(400).json({ error: 'Resulting balance cannot be negative' });
    }

    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, userId);

    // Audit log
    db.prepare(`
      INSERT INTO admin_logs (admin_id, action, target_user_id, details)
      VALUES (?, 'adjust_balance', ?, ?)
    `).run(
      req.user.id,
      userId,
      JSON.stringify({ previousBalance: user.balance, delta, newBalance, reason: reason || 'Admin adjustment' })
    );

    res.json({
      success: true,
      user: { id: user.id, username: user.username, previousBalance: user.balance, newBalance },
    });
  });

  // Toggle User Active / Banned Status
  router.post('/users/:id/status', (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const { isActive } = req.body;

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot change your own active status' });
    }

    const user = db.prepare('SELECT id, username, is_active FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const newStatus = isActive ? 1 : 0;
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(newStatus, userId);

    db.prepare(`
      INSERT INTO admin_logs (admin_id, action, target_user_id, details)
      VALUES (?, ?, ?, ?)
    `).run(
      req.user.id,
      newStatus ? 'activate_user' : 'ban_user',
      userId,
      JSON.stringify({ previousStatus: user.is_active, newStatus })
    );

    res.json({
      success: true,
      user: { id: user.id, username: user.username, is_active: newStatus },
    });
  });

  // 3. Feature 2: In Admin Panel, Add Admins
  router.post('/create-admin', (req, res) => {
    const { username, password, initialBalance } = req.body;

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
      return res.status(409).json({ error: 'Username already exists' });
    }

    const { hash, salt } = hashPassword(password);
    const balance = parseFloat(initialBalance || 10000.00);

    const stmt = db.prepare(`
      INSERT INTO users (username, password_hash, salt, role, balance, is_active)
      VALUES (?, ?, ?, 'admin', ?, 1)
    `);
    const result = stmt.run(trimmed, hash, salt, balance);
    const newAdminId = Number(result.lastInsertRowid);

    // Audit log
    db.prepare(`
      INSERT INTO admin_logs (admin_id, action, target_user_id, details)
      VALUES (?, 'create_admin', ?, ?)
    `).run(
      req.user.id,
      newAdminId,
      JSON.stringify({ createdAdminUsername: trimmed, balance })
    );

    res.json({
      success: true,
      admin: {
        id: newAdminId,
        username: trimmed,
        role: 'admin',
        balance,
        is_active: 1,
      },
    });
  });

  // Feature 2: Promote existing user to Admin or Demote
  router.post('/users/:id/role', (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const { role } = req.body;

    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ error: "Role must be 'user' or 'admin'" });
    }

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot alter your own admin role' });
    }

    const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);

    db.prepare(`
      INSERT INTO admin_logs (admin_id, action, target_user_id, details)
      VALUES (?, 'change_role', ?, ?)
    `).run(
      req.user.id,
      userId,
      JSON.stringify({ previousRole: user.role, newRole: role })
    );

    res.json({
      success: true,
      user: { id: user.id, username: user.username, role },
    });
  });

  // ==================== LIVE FLIGHT MANIPULATION & CONTROLS ====================

  // Emergency Crash ("Flew Away Now")
  router.post('/game/force-crash', (req, res) => {
    const result = gameEngine.forceCrashNow();
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    db.prepare(`
      INSERT INTO admin_logs (admin_id, action, details)
      VALUES (?, 'force_crash', ?)
    `).run(
      req.user.id,
      JSON.stringify({ crashedAt: result.crashedAt, roundId: gameEngine.roundId })
    );

    res.json(result);
  });

  // Set / Preset Next Round Crash Multiplier
  router.post('/game/set-next-multiplier', (req, res) => {
    const { multiplier } = req.body;
    const result = gameEngine.setNextMultiplier(multiplier);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    db.prepare(`
      INSERT INTO admin_logs (admin_id, action, details)
      VALUES (?, 'set_next_multiplier', ?)
    `).run(
      req.user.id,
      JSON.stringify({ forcedMultiplier: result.forcedMultiplier, appliedState: result.appliedState })
    );

    res.json(result);
  });

  // Set Countdown Duration & Flight Curve Speed
  router.post('/game/config', (req, res) => {
    const { countdownSec, flightSpeedFactor, speedFactor } = req.body;
    const factor = flightSpeedFactor !== undefined ? flightSpeedFactor : speedFactor;
    const result = gameEngine.setFlyTimeConfig(countdownSec, factor);

    db.prepare(`
      INSERT INTO admin_logs (admin_id, action, details)
      VALUES (?, 'update_game_config', ?)
    `).run(
      req.user.id,
      JSON.stringify(result)
    );

    res.json(result);
  });

  // Get current game control & flight status
  router.get('/game/status', (req, res) => {
    res.json(gameEngine.getGameControlStatus());
  });

  // ==================== DEPOSITS & BANKING OPERATIONS ====================

  // List all deposit requests
  router.get('/deposits', (req, res) => {
    const status = req.query.status;
    let query = `
      SELECT
        d.id, d.user_id, d.amount, d.payment_method, d.utr_number, d.sender_name,
        d.status, d.created_at, d.reviewed_at, d.admin_notes,
        u.username, u.balance as current_user_balance
      FROM deposits d
      JOIN users u ON d.user_id = u.id
    `;
    const params = [];

    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      query += ` WHERE d.status = ?`;
      params.push(status);
    }

    query += ` ORDER BY d.id DESC LIMIT 100`;

    const deposits = db.prepare(query).all(...params);
    res.json({ deposits });
  });

  // Approve a deposit request -> credits user balance!
  router.post('/deposits/:id/approve', (req, res) => {
    const depositId = parseInt(req.params.id, 10);
    const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(depositId);
    if (!deposit) {
      return res.status(404).json({ error: 'Deposit request not found' });
    }

    if (deposit.status !== 'pending') {
      return res.status(400).json({ error: `Deposit is already ${deposit.status}` });
    }

    const user = db.prepare('SELECT id, username, balance FROM users WHERE id = ?').get(deposit.user_id);
    if (!user) {
      return res.status(404).json({ error: 'User for this deposit no longer exists' });
    }

    const newBalance = parseFloat((user.balance + deposit.amount).toFixed(2));

    // Update user balance and deposit status atomically
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, user.id);
    db.prepare(`
      UPDATE deposits
      SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, admin_notes = ?
      WHERE id = ?
    `).run(req.user.id, req.body.notes || 'Approved by admin', depositId);

    // Audit log
    db.prepare(`
      INSERT INTO admin_logs (admin_id, action, target_user_id, details)
      VALUES (?, 'approve_deposit', ?, ?)
    `).run(
      req.user.id,
      user.id,
      JSON.stringify({ depositId, amount: deposit.amount, utr: deposit.utr_number, newBalance })
    );

    res.json({
      success: true,
      message: `Deposit of $${deposit.amount.toFixed(2)} approved! New balance for ${user.username}: $${newBalance.toFixed(2)}`,
      newBalance,
    });
  });

  // Reject a deposit request
  router.post('/deposits/:id/reject', (req, res) => {
    const depositId = parseInt(req.params.id, 10);
    const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(depositId);
    if (!deposit) {
      return res.status(404).json({ error: 'Deposit request not found' });
    }

    if (deposit.status !== 'pending') {
      return res.status(400).json({ error: `Deposit is already ${deposit.status}` });
    }

    const reason = req.body.reason || 'Invalid UTR or payment not received in bank';

    db.prepare(`
      UPDATE deposits
      SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, admin_notes = ?
      WHERE id = ?
    `).run(req.user.id, reason, depositId);

    // Audit log
    db.prepare(`
      INSERT INTO admin_logs (admin_id, action, target_user_id, details)
      VALUES (?, 'reject_deposit', ?, ?)
    `).run(
      req.user.id,
      deposit.user_id,
      JSON.stringify({ depositId, amount: deposit.amount, utr: deposit.utr_number, reason })
    );

    res.json({
      success: true,
      message: 'Deposit request rejected',
    });
  });

  // ==================== WITHDRAWAL OPERATIONS ====================

  // List all withdrawal requests
  router.get('/withdrawals', (req, res) => {
    const status = req.query.status;
    let query = `
      SELECT 
        w.id, w.user_id, w.amount, w.payout_method, w.account_details, 
        w.status, w.created_at, w.reviewed_at, w.admin_notes,
        u.username, u.balance as current_user_balance
      FROM withdrawals w
      JOIN users u ON w.user_id = u.id
    `;
    const params = [];

    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      query += ` WHERE w.status = ?`;
      params.push(status);
    }

    query += ` ORDER BY w.id DESC LIMIT 100`;

    const rows = db.prepare(query).all(...params);
    const withdrawals = rows.map(w => {
      let parsed = {};
      try { parsed = JSON.parse(w.account_details); } catch {}
      return {
        ...w,
        accountDetailsParsed: parsed,
      };
    });

    res.json({ withdrawals });
  });

  // Approve a withdrawal request (payout confirmed)
  router.post('/withdrawals/:id/approve', (req, res) => {
    const withdrawalId = parseInt(req.params.id, 10);
    const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal request not found' });
    }

    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: `Withdrawal is already ${withdrawal.status}` });
    }

    const note = req.body.notes || 'Payout approved and transferred by admin';

    db.prepare(`
      UPDATE withdrawals
      SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, admin_notes = ?
      WHERE id = ?
    `).run(req.user.id, note, withdrawalId);

    // Audit log
    db.prepare(`
      INSERT INTO admin_logs (admin_id, action, target_user_id, details)
      VALUES (?, 'approve_withdrawal', ?, ?)
    `).run(
      req.user.id,
      withdrawal.user_id,
      JSON.stringify({ withdrawalId, amount: withdrawal.amount, note })
    );

    res.json({
      success: true,
      message: `Withdrawal #${withdrawalId} of $${withdrawal.amount.toFixed(2)} marked as approved!`,
    });
  });

  // Reject a withdrawal request -> REFUNDS balance back to user's wallet!
  router.post('/withdrawals/:id/reject', (req, res) => {
    const withdrawalId = parseInt(req.params.id, 10);
    const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal request not found' });
    }

    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: `Withdrawal is already ${withdrawal.status}` });
    }

    const user = db.prepare('SELECT id, username, balance FROM users WHERE id = ?').get(withdrawal.user_id);
    if (!user) {
      return res.status(404).json({ error: 'User for this withdrawal no longer exists' });
    }

    const reason = req.body.reason || 'Invalid account details or payout rejected';

    // Refund user balance atomically
    const refundedBalance = parseFloat((user.balance + withdrawal.amount).toFixed(2));
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(refundedBalance, user.id);

    db.prepare(`
      UPDATE withdrawals
      SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, admin_notes = ?
      WHERE id = ?
    `).run(req.user.id, reason, withdrawalId);

    // Audit log
    db.prepare(`
      INSERT INTO admin_logs (admin_id, action, target_user_id, details)
      VALUES (?, 'reject_withdrawal_refunded', ?, ?)
    `).run(
      req.user.id,
      withdrawal.user_id,
      JSON.stringify({ withdrawalId, amount: withdrawal.amount, reason, refundedBalance })
    );

    res.json({
      success: true,
      message: `Withdrawal rejected and $${withdrawal.amount.toFixed(2)} refunded to ${user.username}'s wallet.`,
      refundedBalance,
    });
  });

  // Get Admin Bank & UPI Payment Settings
  router.get('/payment-settings', (req, res) => {
    let settings = db.prepare('SELECT * FROM payment_settings WHERE id = 1').get();
    if (!settings) {
      settings = {
        upi_id: '',
        account_name: '',
        bank_name: '',
        account_number: '',
        ifsc_code: '',
        instructions: 'Payment details have not been configured. Contact an administrator.',
        razorpay_key_id: '',
        razorpay_key_secret: '',
        razorpay_enabled: 1,
      };
    }
    // Fall back to environment variable if DB setting is not specified
    if (!settings.razorpay_key_id && process.env.RAZORPAY_KEY_ID) {
      settings.razorpay_key_id = process.env.RAZORPAY_KEY_ID;
    }
    res.json({ settings });
  });

  // Update Admin Bank & UPI Payment Settings (Your bank details where funds are received)
  router.post('/payment-settings', (req, res) => {
    const upi_id = req.body.upi_id || req.body.upiId || '';
    const account_name = req.body.account_name || req.body.accountName || req.body.accountHolderName || '';
    const bank_name = req.body.bank_name || req.body.bankName || '';
    const account_number = req.body.account_number || req.body.accountNumber || '';
    const ifsc_code = req.body.ifsc_code || req.body.ifscCode || '';
    const instructions = req.body.instructions || '';
    const razorpay_key_id = (req.body.razorpay_key_id !== undefined ? req.body.razorpay_key_id : req.body.razorpayKeyId) || '';
    const razorpay_key_secret = (req.body.razorpay_key_secret !== undefined ? req.body.razorpay_key_secret : req.body.razorpayKeySecret) || '';
    const razorpay_enabled = req.body.razorpay_enabled !== undefined ? (req.body.razorpay_enabled ? 1 : 0) : 1;

    db.prepare(`
      INSERT INTO payment_settings (id, upi_id, account_name, bank_name, account_number, ifsc_code, instructions, razorpay_key_id, razorpay_key_secret, razorpay_enabled)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        upi_id = excluded.upi_id,
        account_name = excluded.account_name,
        bank_name = excluded.bank_name,
        account_number = excluded.account_number,
        ifsc_code = excluded.ifsc_code,
        instructions = excluded.instructions,
        razorpay_key_id = excluded.razorpay_key_id,
        razorpay_key_secret = excluded.razorpay_key_secret,
        razorpay_enabled = excluded.razorpay_enabled
    `).run(
      upi_id.trim(),
      account_name.trim(),
      (bank_name || '').trim(),
      (account_number || '').trim(),
      (ifsc_code || '').trim(),
      (instructions || '').trim(),
      (razorpay_key_id || '').trim(),
      (razorpay_key_secret || '').trim(),
      razorpay_enabled
    );

    // Audit log
    db.prepare(`
      INSERT INTO admin_logs (admin_id, action, details)
      VALUES (?, 'update_payment_settings', ?)
    `).run(
      req.user.id,
      JSON.stringify({ upi_id, account_name, bank_name, razorpay_key_id })
    );

    res.json({
      success: true,
      message: 'Bank, UPI, and Razorpay settings updated successfully!',
    });
  });

  // Audit list of rounds
  router.get('/rounds', (req, res) => {
    const limit = Math.min(100, parseInt(req.query.limit || 50, 10));
    const rounds = db.prepare(`
      SELECT id, server_seed, server_seed_hash, client_seed, combined_hash, crash_multiplier, status, created_at
      FROM rounds
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);

    res.json({ rounds });
  });

  // Audit Logs
  router.get('/logs', (req, res) => {
    const logs = db.prepare(`
      SELECT
        l.id, l.action, l.details, l.created_at,
        admin.username as admin_username,
        target.username as target_username
      FROM admin_logs l
      LEFT JOIN users admin ON l.admin_id = admin.id
      LEFT JOIN users target ON l.target_user_id = target.id
      ORDER BY l.id DESC
      LIMIT 100
    `).all();

    res.json({ logs });
  });

  return router;
}
