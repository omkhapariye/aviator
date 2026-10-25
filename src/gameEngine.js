import { EventEmitter } from 'node:events';
import { generateServerSeed, generateClientSeed, hashServerSeed, calculateCrashPoint } from './provablyFair.js';

export class GameEngine extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.state = 'WAITING'; // 'WAITING' | 'FLYING' | 'CRASHED'
    this.roundId = 0;
    this.serverSeed = '';
    this.serverSeedHash = '';
    this.clientSeed = '';
    this.crashMultiplier = 1.00;
    this.currentMultiplier = 1.00;
    this.startTime = 0;
    this.flightDuration = 0;
    this.countdown = 5.0; // 5 seconds betting phase
    this.countdownDuration = 5000; // Customizable betting countdown in ms
    this.flightSpeedFactor = 0.08; // Multiplier rise rate e^(rate * t)
    this.forcedNextMultiplier = null; // Admin forced multiplier for rigging/testing
    this.tickInterval = null;
    this.nextRoundTimeout = null;
    this.history = [];
    this.activeBets = new Map(); // key: `${userId}_${slotIndex}`, value: betObj
    this.simulatedBets = [];
    this.botNames = [
      'Vikram_R', 'CryptoAce', 'Elena_99', 'Marcus_T', 'LuckyPilot',
      'SkyHigh_X', 'AeroGamer', 'NovaBet', 'CaptainDan', 'Zara_Moon',
      'Phoenix_7', 'ApexPlayer', 'JetSet_Go', 'ThunderCat', 'AlphaBet'
    ];

    this.loadHistory();
  }

  loadHistory() {
    try {
      const rows = this.db.prepare(`
        SELECT id, server_seed, server_seed_hash, client_seed, crash_multiplier, created_at
        FROM rounds
        ORDER BY id DESC
        LIMIT 30
      `).all();
      this.history = rows.reverse();
    } catch {
      this.history = [];
    }
  }

  start() {
    this.prepareNewRound();
  }

  prepareNewRound() {
    if (this.nextRoundTimeout) {
      clearTimeout(this.nextRoundTimeout);
      this.nextRoundTimeout = null;
    }
    this.state = 'WAITING';
    this.currentMultiplier = 1.00;
    this.countdown = 5.0;
    this.activeBets.clear();
    this.simulatedBets = [];

    // Generate cryptographic seeds
    this.serverSeed = generateServerSeed();
    this.serverSeedHash = hashServerSeed(this.serverSeed);
    this.clientSeed = generateClientSeed();

    // Precalculate deterministic crash point (or use admin preset)
    if (this.forcedNextMultiplier !== null) {
      this.crashMultiplier = this.forcedNextMultiplier;
      this.forcedNextMultiplier = null;
    } else {
      const result = calculateCrashPoint(this.serverSeed, this.clientSeed);
      this.crashMultiplier = result.multiplier;
    }

    const combinedResult = calculateCrashPoint(this.serverSeed, this.clientSeed);

    // Insert pending round in DB
    const stmt = this.db.prepare(`
      INSERT INTO rounds (server_seed, server_seed_hash, client_seed, combined_hash, crash_multiplier, status)
      VALUES (?, ?, ?, ?, ?, 'waiting')
    `);
    const info = stmt.run(this.serverSeed, this.serverSeedHash, this.clientSeed, combinedResult.combinedHash, this.crashMultiplier);
    this.roundId = Number(info.lastInsertRowid);

    // Generate random simulated bets from other online players
    this.generateSimulatedBets();

    this.broadcastState();

    // Countdown loop with configurable duration
    const countdownStart = Date.now();
    const countdownDuration = this.countdownDuration;

    clearInterval(this.tickInterval);
    this.tickInterval = setInterval(() => {
      const elapsed = Date.now() - countdownStart;
      this.countdown = Math.max(0, (countdownDuration - elapsed) / 1000);

      this.emit('tick', {
        state: 'WAITING',
        roundId: this.roundId,
        countdown: parseFloat(this.countdown.toFixed(1)),
        serverSeedHash: this.serverSeedHash,
        activeBetsCount: this.activeBets.size + this.simulatedBets.length,
      });

      if (elapsed >= countdownDuration) {
        clearInterval(this.tickInterval);
        this.launchFlight();
      }
    }, 100);
  }

  generateSimulatedBets() {
    this.simulatedBets = [];
    const count = Math.floor(Math.random() * 8) + 6; // 6 to 14 bots
    const shuffled = [...this.botNames].sort(() => 0.5 - Math.random());

    for (let i = 0; i < count; i++) {
      const name = shuffled[i] || `Pilot_${i}`;
      const amount = [10, 20, 50, 100, 200, 500, 1000][Math.floor(Math.random() * 7)];
      // Target multiplier between 1.10 and slightly above crash point
      const target = parseFloat((1.10 + Math.random() * (this.crashMultiplier * 1.2)).toFixed(2));
      this.simulatedBets.push({
        id: `sim_${i}`,
        username: name,
        amount,
        target,
        cashedOut: false,
        cashoutMultiplier: null,
        payout: 0,
      });
    }
  }

  launchFlight() {
    this.state = 'FLYING';
    this.startTime = Date.now();
    this.currentMultiplier = 1.00;

    this.db.prepare('UPDATE rounds SET status = ? WHERE id = ?').run('flying', this.roundId);

    this.emit('flight_start', {
      roundId: this.roundId,
      serverSeedHash: this.serverSeedHash,
      activeBets: this.getAllActiveBetsForClient(),
    });

    const flightSpeedFactor = this.flightSpeedFactor; // customizable multiplier rate

    this.tickInterval = setInterval(() => {
      const elapsedSeconds = (Date.now() - this.startTime) / 1000;
      // Exponential curve: M(t) = e^(0.08 * t)
      const calculatedM = Math.floor(Math.exp(flightSpeedFactor * elapsedSeconds) * 100) / 100;
      this.currentMultiplier = Math.max(1.00, calculatedM);

      // Check auto-cashouts for real bets
      for (const [key, bet] of this.activeBets.entries()) {
        if (!bet.cashedOut && bet.autoCashout && bet.autoCashout <= this.currentMultiplier) {
          this.cashOutBet(bet.userId, bet.slotIndex, this.currentMultiplier);
        }
      }

      // Check simulated bets cashout
      for (const sim of this.simulatedBets) {
        if (!sim.cashedOut && sim.target <= this.currentMultiplier && this.currentMultiplier < this.crashMultiplier) {
          sim.cashedOut = true;
          sim.cashoutMultiplier = this.currentMultiplier;
          sim.payout = parseFloat((sim.amount * this.currentMultiplier).toFixed(2));
          this.emit('sim_cashout', {
            username: sim.username,
            amount: sim.amount,
            multiplier: sim.cashoutMultiplier,
            payout: sim.payout,
          });
        }
      }

      // Check if crash point reached
      if (this.currentMultiplier >= this.crashMultiplier) {
        clearInterval(this.tickInterval);
        this.currentMultiplier = this.crashMultiplier;
        this.handleCrash();
      } else {
        this.emit('tick', {
          state: 'FLYING',
          roundId: this.roundId,
          multiplier: parseFloat(this.currentMultiplier.toFixed(2)),
          elapsed: parseFloat(elapsedSeconds.toFixed(2)),
          activeBetsCount: this.activeBets.size,
        });
      }
    }, 50); // 20 FPS broadcast
  }

  handleCrash() {
    this.state = 'CRASHED';
    this.flightDuration = (Date.now() - this.startTime) / 1000;

    // Settle uncashed bets as lost
    for (const [key, bet] of this.activeBets.entries()) {
      if (!bet.cashedOut) {
        bet.status = 'lost';
        this.db.prepare(`
          UPDATE bets SET status = 'lost', cashed_out_at = NULL, payout = 0 WHERE id = ?
        `).run(bet.id);
      }
    }

    // Update round status in database
    this.db.prepare(`
      UPDATE rounds SET status = 'completed' WHERE id = ?
    `).run(this.roundId);

    const roundData = {
      id: this.roundId,
      server_seed: this.serverSeed,
      server_seed_hash: this.serverSeedHash,
      client_seed: this.clientSeed,
      crash_multiplier: this.crashMultiplier,
      created_at: new Date().toISOString(),
    };

    this.history.push(roundData);
    if (this.history.length > 50) this.history.shift();

    this.emit('crashed', {
      roundId: this.roundId,
      crashMultiplier: this.crashMultiplier,
      serverSeed: this.serverSeed,
      serverSeedHash: this.serverSeedHash,
      clientSeed: this.clientSeed,
      history: this.getRecentHistory(25),
    });

    // 3-second cooldown then start next round
    if (this.nextRoundTimeout) clearTimeout(this.nextRoundTimeout);
    this.nextRoundTimeout = setTimeout(() => {
      this.prepareNewRound();
    }, 3000);
  }

  stop() {
    clearInterval(this.tickInterval);
    if (this.nextRoundTimeout) {
      clearTimeout(this.nextRoundTimeout);
      this.nextRoundTimeout = null;
    }
  }

  placeBet(userId, username, slotIndex, amount, autoCashout = null) {
    if (this.state !== 'WAITING') {
      return { success: false, error: 'Bets can only be placed during the waiting countdown' };
    }

    const key = `${userId}_${slotIndex}`;
    if (this.activeBets.has(key)) {
      return { success: false, error: 'A bet is already placed in this panel slot' };
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return { success: false, error: 'Invalid bet amount' };
    }

    const autoCashoutVal = autoCashout ? parseFloat(autoCashout) : null;
    if (autoCashoutVal && (isNaN(autoCashoutVal) || autoCashoutVal < 1.01)) {
      return { success: false, error: 'Auto cash out multiplier must be at least 1.01x' };
    }

    // Atomic balance deduction
    const user = this.db.prepare('SELECT balance, is_active FROM users WHERE id = ?').get(userId);
    if (!user || !user.is_active) {
      return { success: false, error: 'Account inactive or invalid' };
    }

    if (user.balance < numAmount) {
      return { success: false, error: 'Insufficient balance' };
    }

    const newBalance = parseFloat((user.balance - numAmount).toFixed(2));
    this.db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, userId);

    const insertStmt = this.db.prepare(`
      INSERT INTO bets (round_id, user_id, slot_index, amount, auto_cashout, status)
      VALUES (?, ?, ?, ?, ?, 'placed')
    `);
    const info = insertStmt.run(this.roundId, userId, slotIndex, numAmount, autoCashoutVal);

    const bet = {
      id: Number(info.lastInsertRowid),
      roundId: this.roundId,
      userId,
      username,
      slotIndex,
      amount: numAmount,
      autoCashout: autoCashoutVal,
      cashedOut: false,
      cashedOutAt: null,
      payout: 0,
      status: 'placed',
    };

    this.activeBets.set(key, bet);

    this.emit('bet_placed', {
      userId,
      username,
      slotIndex,
      amount: numAmount,
      balance: newBalance,
    });

    return { success: true, bet, balance: newBalance };
  }

  cancelBet(userId, slotIndex) {
    if (this.state !== 'WAITING') {
      return { success: false, error: 'Bets can only be cancelled during the waiting phase' };
    }

    const key = `${userId}_${slotIndex}`;
    const bet = this.activeBets.get(key);
    if (!bet) {
      return { success: false, error: 'No active bet found in this slot' };
    }

    // Refund user balance
    const user = this.db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    const newBalance = parseFloat((user.balance + bet.amount).toFixed(2));
    this.db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, userId);

    // Delete bet from DB
    this.db.prepare('DELETE FROM bets WHERE id = ?').run(bet.id);
    this.activeBets.delete(key);

    this.emit('bet_cancelled', { userId, slotIndex, balance: newBalance });

    return { success: true, balance: newBalance };
  }

  cashOutBet(userId, slotIndex, customMultiplier = null) {
    if (this.state !== 'FLYING') {
      return { success: false, error: 'Game is not in flight' };
    }

    const key = `${userId}_${slotIndex}`;
    const bet = this.activeBets.get(key);
    if (!bet) {
      return { success: false, error: 'No active bet in this slot' };
    }

    if (bet.cashedOut) {
      return { success: false, error: 'Already cashed out' };
    }

    const multiplier = customMultiplier || this.currentMultiplier;
    if (multiplier > this.crashMultiplier) {
      return { success: false, error: 'Plane already crashed' };
    }

    const payout = parseFloat((bet.amount * multiplier).toFixed(2));
    bet.cashedOut = true;
    bet.cashedOutAt = multiplier;
    bet.payout = payout;
    bet.status = 'won';

    // Credit user balance
    const user = this.db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    const newBalance = parseFloat((user.balance + payout).toFixed(2));
    this.db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, userId);

    // Update bet in DB
    this.db.prepare(`
      UPDATE bets SET status = 'won', cashed_out_at = ?, payout = ? WHERE id = ?
    `).run(multiplier, payout, bet.id);

    this.emit('bet_won', {
      userId,
      username: bet.username,
      slotIndex,
      amount: bet.amount,
      multiplier,
      payout,
      balance: newBalance,
    });

    return {
      success: true,
      multiplier,
      payout,
      balance: newBalance,
    };
  }

  getAllActiveBetsForClient() {
    const list = [];
    for (const bet of this.activeBets.values()) {
      list.push({
        username: bet.username,
        amount: bet.amount,
        cashedOut: bet.cashedOut,
        cashedOutAt: bet.cashedOutAt,
        payout: bet.payout,
      });
    }
    for (const sim of this.simulatedBets) {
      list.push({
        username: sim.username,
        amount: sim.amount,
        cashedOut: sim.cashedOut,
        cashedOutAt: sim.cashoutMultiplier,
        payout: sim.payout,
      });
    }
    return list;
  }

  getRecentHistory(limit = 25) {
    return this.history.slice(-limit).map((r) => ({
      id: r.id,
      multiplier: r.crash_multiplier,
      serverSeedHash: r.server_seed_hash,
      serverSeed: r.server_seed,
      clientSeed: r.client_seed,
    }));
  }

  getCurrentStateForClient(userId = null) {
    let userBets = [];
    if (userId) {
      for (const [key, bet] of this.activeBets.entries()) {
        if (bet.userId === userId) {
          userBets.push({
            slotIndex: bet.slotIndex,
            amount: bet.amount,
            autoCashout: bet.autoCashout,
            cashedOut: bet.cashedOut,
            cashedOutAt: bet.cashedOutAt,
            payout: bet.payout,
          });
        }
      }
    }

    return {
      state: this.state,
      roundId: this.roundId,
      multiplier: parseFloat(this.currentMultiplier.toFixed(2)),
      countdown: parseFloat(this.countdown.toFixed(1)),
      serverSeedHash: this.serverSeedHash,
      history: this.getRecentHistory(25),
      liveBets: this.getAllActiveBetsForClient(),
      userBets,
    };
  }

  broadcastState() {
    this.emit('state_change', this.getCurrentStateForClient());
  }

  // ==================== ADMIN FLIGHT MANIPULATION & CONTROLS ====================

  /**
   * Immediately force the plane to fly away / crash right now
   */
  forceCrashNow() {
    if (this.state !== 'FLYING') {
      return { success: false, error: 'Cannot crash: Airplane is not currently in flight (current state: ' + this.state + ')' };
    }
    clearInterval(this.tickInterval);
    this.crashMultiplier = parseFloat(this.currentMultiplier.toFixed(2));
    this.handleCrash();
    return {
      success: true,
      crashedAt: this.crashMultiplier,
      message: `Plane successfully flew away at ${this.crashMultiplier.toFixed(2)}x`,
    };
  }

  /**
   * Set or override the target crash multiplier for the next round
   */
  setNextMultiplier(mult) {
    const val = parseFloat(mult);
    if (isNaN(val) || val < 1.00) {
      return { success: false, error: 'Multiplier must be at least 1.00x' };
    }
    this.forcedNextMultiplier = parseFloat(val.toFixed(2));

    // If currently waiting, apply it immediately to the active round!
    if (this.state === 'WAITING') {
      this.crashMultiplier = this.forcedNextMultiplier;
      this.db.prepare('UPDATE rounds SET crash_multiplier = ? WHERE id = ?').run(this.crashMultiplier, this.roundId);
    }

    return {
      success: true,
      forcedMultiplier: this.forcedNextMultiplier,
      appliedState: this.state,
    };
  }

  /**
   * Adjust betting countdown duration and flight curve progression rate
   */
  setFlyTimeConfig(countdownSec, speedFactor) {
    if (countdownSec !== undefined && countdownSec !== null) {
      const c = parseFloat(countdownSec);
      if (!isNaN(c) && c >= 2 && c <= 30) {
        this.countdownDuration = Math.round(c * 1000);
      }
    }

    if (speedFactor !== undefined && speedFactor !== null) {
      const s = parseFloat(speedFactor);
      if (!isNaN(s) && s >= 0.02 && s <= 0.3) {
        this.flightSpeedFactor = parseFloat(s.toFixed(3));
      }
    }

    return {
      success: true,
      countdownSec: this.countdownDuration / 1000,
      flightSpeedFactor: this.flightSpeedFactor,
    };
  }

  /**
   * Get current admin control status
   */
  getGameControlStatus() {
    return {
      state: this.state,
      roundId: this.roundId,
      currentMultiplier: parseFloat(this.currentMultiplier.toFixed(2)),
      crashMultiplier: parseFloat(this.crashMultiplier.toFixed(2)),
      forcedNextMultiplier: this.forcedNextMultiplier,
      countdownSec: this.countdownDuration / 1000,
      flightSpeedFactor: this.flightSpeedFactor,
    };
  }
}
