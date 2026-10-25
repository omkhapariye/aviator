/**
 * Aviator Crash Game - Client-Side Engine
 * High-performance Canvas renderer, WebSocket state synchronization,
 * sound effects generator, dual betting docks, and full administrative console.
 */

// Sound Synthesizer via Web Audio API (No external sound files required)
class SoundFx {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
  }

  playTakeoff() {
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(120, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(340, this.ctx.currentTime + 1.2);
      gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 1.2);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 1.2);
    } catch {}
  }

  playCashout() {
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523.25, this.ctx.currentTime); // C5
      osc.frequency.setValueAtTime(659.25, this.ctx.currentTime + 0.1); // E5
      osc.frequency.setValueAtTime(783.99, this.ctx.currentTime + 0.2); // G5
      osc.frequency.setValueAtTime(1046.50, this.ctx.currentTime + 0.3); // C6
      gain.gain.setValueAtTime(0.12, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.6);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.6);
    } catch {}
  }

  playCrash() {
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(180, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(40, this.ctx.currentTime + 0.5);
      gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.5);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.5);
    } catch {}
  }
}

// Particle System for airplane exhaust trails and crash blast
class ParticleSystem {
  constructor() {
    this.particles = [];
  }

  addTrail(x, y) {
    this.particles.push({
      x,
      y,
      vx: -(Math.random() * 2 + 1.5),
      vy: (Math.random() - 0.5) * 1.5,
      size: Math.random() * 4 + 3,
      alpha: 0.7,
      color: Math.random() > 0.4 ? 'rgba(229, 27, 36,' : 'rgba(242, 139, 12,',
      life: 1.0,
      decay: 0.03,
    });
  }

  addExplosion(x, y) {
    for (let i = 0; i < 35; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 6 + 2;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: Math.random() * 6 + 4,
        alpha: 1.0,
        color: Math.random() > 0.5 ? 'rgba(229, 27, 36,' : 'rgba(255, 200, 50,',
        life: 1.0,
        decay: Math.random() * 0.04 + 0.02,
      });
    }
  }

  updateAndDraw(ctx) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;
      p.alpha = Math.max(0, p.life);

      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fillStyle = `${p.color} ${p.alpha})`;
      ctx.fill();
      ctx.restore();
    }
  }

  clear() {
    this.particles = [];
  }
}

// Main Client Application
class AviatorApp {
  constructor() {
    this.ws = null;
    this.token = localStorage.getItem('aviator_token') || null;
    this.currentUser = null;
    this.sound = new SoundFx();
    this.particles = new ParticleSystem();

    // Game state
    this.gameState = 'WAITING'; // 'WAITING' | 'FLYING' | 'CRASHED'
    this.currentMultiplier = 1.00;
    this.crashMultiplier = 1.00;
    this.countdown = 5.0;
    this.roundId = 0;
    this.serverSeedHash = '';
    this.history = [];
    this.liveBets = [];
    this.userBets = [null, null]; // slot 0 and slot 1

    // Canvas elements
    this.canvas = document.getElementById('flightCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.animFrameId = null;
    this.propellerAngle = 0;
    this.flightProgress = 0; // 0 to 1 along flight duration

    this.init();
  }

  async init() {
    this.setupCanvas();
    window.addEventListener('resize', () => this.setupCanvas());
    this.bindEvents();

    if (this.token) {
      await this.fetchCurrentUser();
    } else {
      this.renderUserSection();
    }

    this.connectWebSocket();
    this.startRenderLoop();
  }

  setupCanvas() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.canvasDisplayWidth = rect.width;
    this.canvasDisplayHeight = rect.height;
  }

  // ==================== WEBSOCKET STATE SYNC ====================
  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      document.getElementById('connectionStatus').classList.remove('disconnected');
      document.querySelector('.status-label').textContent = 'CONNECTED';
    };

    this.ws.onclose = () => {
      document.getElementById('connectionStatus').classList.add('disconnected');
      document.querySelector('.status-label').textContent = 'RECONNECTING...';
      setTimeout(() => this.connectWebSocket(), 2000);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleServerMessage(msg);
      } catch (err) {
        console.error('WS parse error:', err);
      }
    };
  }

  handleServerMessage(msg) {
    switch (msg.type) {
      case 'init_state':
        this.gameState = msg.state;
        this.roundId = msg.roundId;
        this.currentMultiplier = msg.multiplier || 1.00;
        this.countdown = msg.countdown || 5.0;
        this.serverSeedHash = msg.serverSeedHash || '';
        this.history = msg.history || [];
        this.liveBets = msg.liveBets || [];
        this.updateHistoryPills();
        this.updateLiveBetsTable();
        this.updateSeedBadge();

        if (msg.userBets && msg.userBets.length > 0) {
          msg.userBets.forEach((b) => {
            this.userBets[b.slotIndex] = b;
            this.updateBetButtonUI(b.slotIndex);
          });
        }
        break;

      case 'tick':
        this.gameState = msg.state;
        if (msg.state === 'WAITING') {
          this.countdown = msg.countdown;
          this.updateWaitingUI();
        } else if (msg.state === 'FLYING') {
          this.currentMultiplier = msg.multiplier;
          this.updateFlyingUI();
        }
        break;

      case 'flight_start':
        this.gameState = 'FLYING';
        this.currentMultiplier = 1.00;
        this.roundId = msg.roundId;
        this.liveBets = msg.activeBets || [];
        this.particles.clear();
        this.sound.playTakeoff();
        this.updateLiveBetsTable();
        this.onFlightStarted();
        break;

      case 'crashed':
        this.gameState = 'CRASHED';
        this.crashMultiplier = msg.crashMultiplier;
        this.currentMultiplier = msg.crashMultiplier;
        this.history = msg.history || [];
        this.sound.playCrash();
        this.onCrashed();
        break;

      case 'bet_placed':
        if (this.currentUser && msg.userId === this.currentUser.id) {
          this.currentUser.balance = msg.balance;
          this.renderUserSection();
        }
        this.liveBets.unshift({
          username: msg.username,
          amount: msg.amount,
          cashedOut: false,
          payout: 0,
        });
        this.updateLiveBetsTable();
        break;

      case 'bet_won':
        if (this.currentUser && msg.userId === this.currentUser.id) {
          this.currentUser.balance = msg.balance;
          this.renderUserSection();
          this.sound.playCashout();
        }
        const found = this.liveBets.find((b) => b.username === msg.username);
        if (found) {
          found.cashedOut = true;
          found.cashedOutAt = msg.multiplier;
          found.payout = msg.payout;
        }
        this.updateLiveBetsTable();
        break;

      case 'sim_cashout':
        const sim = this.liveBets.find((b) => b.username === msg.username);
        if (sim) {
          sim.cashedOut = true;
          sim.cashedOutAt = msg.multiplier;
          sim.payout = msg.payout;
        }
        this.updateLiveBetsTable();
        break;

      case 'bet_success':
        this.userBets[msg.slotIndex] = msg.bet;
        if (this.currentUser) {
          this.currentUser.balance = msg.balance;
          this.renderUserSection();
        }
        this.updateBetButtonUI(msg.slotIndex);
        break;

      case 'cancel_success':
        this.userBets[msg.slotIndex] = null;
        if (this.currentUser) {
          this.currentUser.balance = msg.balance;
          this.renderUserSection();
        }
        this.updateBetButtonUI(msg.slotIndex);
        break;

      case 'cashout_success':
        if (this.userBets[msg.slotIndex]) {
          this.userBets[msg.slotIndex].cashedOut = true;
          this.userBets[msg.slotIndex].cashedOutAt = msg.multiplier;
          this.userBets[msg.slotIndex].payout = msg.payout;
        }
        if (this.currentUser) {
          this.currentUser.balance = msg.balance;
          this.renderUserSection();
        }
        this.sound.playCashout();
        this.updateBetButtonUI(msg.slotIndex);
        break;

      case 'error':
        alert(msg.message);
        break;
    }
  }

  // ==================== UI STATE UPDATES ====================
  updateWaitingUI() {
    const overlay = document.getElementById('stageOverlay');
    const display = document.getElementById('multiplierDisplay');
    const sub = document.getElementById('stageStatusSub');
    const pBar = document.getElementById('waitingProgressBar');
    const pFill = document.getElementById('waitingProgressFill');

    display.classList.remove('crashed');
    display.textContent = 'WAITING';
    display.style.fontSize = '3.5rem';
    sub.textContent = `NEXT ROUND IN ${this.countdown.toFixed(1)}s`;
    pBar.style.display = 'block';
    const percent = Math.min(100, Math.max(0, (this.countdown / 5.0) * 100));
    pFill.style.width = `${percent}%`;

    // Reset buttons if round just recycled
    for (let slot = 0; slot <= 1; slot++) {
      if (this.userBets[slot] && (this.userBets[slot].cashedOut || this.userBets[slot].status === 'lost')) {
        this.userBets[slot] = null;
        this.updateBetButtonUI(slot);
      }
    }
    this.updateAdminStatusPill();
  }

  updateFlyingUI() {
    const display = document.getElementById('multiplierDisplay');
    const sub = document.getElementById('stageStatusSub');
    const pBar = document.getElementById('waitingProgressBar');

    display.classList.remove('crashed');
    display.style.fontSize = '5.2rem';
    display.textContent = `${this.currentMultiplier.toFixed(2)}x`;
    sub.textContent = '';
    pBar.style.display = 'none';

    // Update Cash Out buttons live win amount
    for (let slot = 0; slot <= 1; slot++) {
      const bet = this.userBets[slot];
      if (bet && !bet.cashedOut) {
        const btn = document.querySelector(`.game-action-btn[data-slot="${slot}"]`);
        const winAmount = (bet.amount * this.currentMultiplier).toFixed(2);
        btn.querySelector('.btn-main-text').textContent = 'CASH OUT';
        btn.querySelector('.btn-sub-text').textContent = `${winAmount} USD`;
      }
    }
    this.updateAdminStatusPill();
  }

  onFlightStarted() {
    for (let slot = 0; slot <= 1; slot++) {
      this.updateBetButtonUI(slot);
    }
    this.updateAdminStatusPill();
  }

  onCrashed() {
    const display = document.getElementById('multiplierDisplay');
    const sub = document.getElementById('stageStatusSub');
    const pBar = document.getElementById('waitingProgressBar');

    display.classList.add('crashed');
    display.textContent = `${this.crashMultiplier.toFixed(2)}x`;
    sub.textContent = 'FLEW AWAY!';
    pBar.style.display = 'none';

    // Trigger canvas explosion at plane location
    const coords = this.getPlaneCoordinates();
    this.particles.addExplosion(coords.x, coords.y);

    this.updateHistoryPills();

    for (let slot = 0; slot <= 1; slot++) {
      this.updateBetButtonUI(slot);
    }
    this.updateAdminStatusPill();
  }

  updateSeedBadge() {
    const badge = document.getElementById('currentRoundHash');
    if (this.serverSeedHash) {
      badge.textContent = `${this.serverSeedHash.slice(0, 16)}...`;
    }
  }

  updateHistoryPills() {
    const container = document.getElementById('historyPills');
    container.innerHTML = '';

    const recent = this.history.slice(-25).reverse();
    recent.forEach((item) => {
      const pill = document.createElement('div');
      pill.className = 'history-pill';
      const m = item.multiplier;
      pill.textContent = `${m.toFixed(2)}x`;

      if (m < 2.0) {
        pill.classList.add('pill-blue');
      } else if (m < 10.0) {
        pill.classList.add('pill-purple');
      } else {
        pill.classList.add('pill-gold');
      }

      pill.addEventListener('click', () => {
        this.openVerifierWithData(item);
      });

      container.appendChild(pill);
    });
  }

  updateLiveBetsTable() {
    const body = document.getElementById('betsTableBody');
    document.getElementById('totalBetsCount').textContent = this.liveBets.length;
    body.innerHTML = '';

    this.liveBets.slice(0, 40).forEach((b) => {
      const row = document.createElement('div');
      row.className = `bet-row ${b.cashedOut ? 'cashed-out' : ''}`;
      row.innerHTML = `
        <span class="user-col">👤 ${b.username}</span>
        <span>$${b.amount.toFixed(2)}</span>
        <span>${b.cashedOut ? `${b.cashedOutAt.toFixed(2)}x` : '-'}</span>
        <span class="payout-col">${b.cashedOut ? `+$${b.payout.toFixed(2)}` : '-'}</span>
      `;
      body.appendChild(row);
    });
  }

  updateBetButtonUI(slot) {
    const panel = document.getElementById(`panel-${slot}`);
    const btn = panel.querySelector('.game-action-btn');
    const bet = this.userBets[slot];

    btn.className = 'game-action-btn';

    if (!bet) {
      // No bet placed
      btn.classList.add('btn-place-bet');
      const amt = parseFloat(panel.querySelector('.bet-amount-input').value) || 10.00;
      btn.querySelector('.btn-main-text').textContent = 'BET';
      btn.querySelector('.btn-sub-text').textContent = `${amt.toFixed(2)} USD`;
    } else if (this.gameState === 'WAITING') {
      // Bet placed, waiting phase -> Allow Cancel
      btn.classList.add('btn-cancel-bet');
      btn.querySelector('.btn-main-text').textContent = 'CANCEL';
      btn.querySelector('.btn-sub-text').textContent = `Waiting (${bet.amount.toFixed(2)} USD)`;
    } else if (this.gameState === 'FLYING') {
      if (bet.cashedOut) {
        btn.classList.add('btn-cashed-out-state');
        btn.querySelector('.btn-main-text').textContent = 'CASHED OUT';
        btn.querySelector('.btn-sub-text').textContent = `+${bet.payout.toFixed(2)} USD`;
      } else {
        btn.classList.add('btn-cash-out');
        const win = (bet.amount * this.currentMultiplier).toFixed(2);
        btn.querySelector('.btn-main-text').textContent = 'CASH OUT';
        btn.querySelector('.btn-sub-text').textContent = `${win} USD`;
      }
    } else if (this.gameState === 'CRASHED') {
      if (bet.cashedOut) {
        btn.classList.add('btn-cashed-out-state');
        btn.querySelector('.btn-main-text').textContent = 'WON';
        btn.querySelector('.btn-sub-text').textContent = `+${bet.payout.toFixed(2)} USD`;
      } else {
        btn.classList.add('btn-cashed-out-state');
        btn.style.borderColor = '#e51b24';
        btn.style.color = '#e51b24';
        btn.querySelector('.btn-main-text').textContent = 'FLEW AWAY';
        btn.querySelector('.btn-sub-text').textContent = `-${bet.amount.toFixed(2)} USD`;
      }
    }
  }

  // ==================== CANVAS RENDERING ENGINE ====================
  getPlaneCoordinates() {
    const w = this.canvasDisplayWidth;
    const h = this.canvasDisplayHeight;
    const originX = 50;
    const originY = h - 40;

    if (this.gameState === 'WAITING') {
      return { x: originX, y: originY, angle: 0 };
    }

    // Map multiplier onto canvas
    // Progress scales smoothly with multiplier: 1.00x -> 10.00x
    const progress = Math.min(1.0, Math.log(this.currentMultiplier) / Math.log(8.0));
    const targetX = originX + (w - 140) * Math.min(1.0, progress * 1.1);
    const targetY = originY - (h - 100) * Math.pow(progress, 0.75);

    // Calculate tangent slope angle
    const angle = -Math.atan2(originY - targetY, targetX - originX) * 0.7;

    return { x: targetX, y: targetY, angle };
  }

  startRenderLoop() {
    const render = () => {
      this.drawCanvas();
      this.animFrameId = requestAnimationFrame(render);
    };
    this.animFrameId = requestAnimationFrame(render);
  }

  drawCanvas() {
    const ctx = this.ctx;
    const w = this.canvasDisplayWidth;
    const h = this.canvasDisplayHeight;

    ctx.clearRect(0, 0, w, h);

    // Draw background grid lines and scale
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;

    for (let x = 50; x < w; x += 60) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h - 30);
      ctx.stroke();
    }

    for (let y = h - 40; y > 20; y -= 50) {
      ctx.beginPath();
      ctx.moveTo(50, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // X/Y Axis baseline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(50, 20);
    ctx.lineTo(50, h - 40);
    ctx.lineTo(w - 20, h - 40);
    ctx.stroke();

    const originX = 50;
    const originY = h - 40;
    const plane = this.getPlaneCoordinates();

    if (this.gameState === 'FLYING') {
      // Draw Red Exponential Bezier Flight Curve
      ctx.save();
      const controlX = originX + (plane.x - originX) * 0.45;
      const controlY = originY;

      // Area gradient fill
      const grad = ctx.createLinearGradient(0, plane.y, 0, originY);
      grad.addColorStop(0, 'rgba(229, 27, 36, 0.45)');
      grad.addColorStop(1, 'rgba(229, 27, 36, 0.01)');

      ctx.beginPath();
      ctx.moveTo(originX, originY);
      ctx.quadraticCurveTo(controlX, controlY, plane.x, plane.y);
      ctx.lineTo(plane.x, originY);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Glowing Curve Stroke
      ctx.shadowColor = '#e51b24';
      ctx.shadowBlur = 12;
      ctx.strokeStyle = '#e51b24';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(originX, originY);
      ctx.quadraticCurveTo(controlX, controlY, plane.x, plane.y);
      ctx.stroke();
      ctx.restore();

      // Emit exhaust trail particles
      this.particles.addTrail(plane.x - 10, plane.y + 4);
    }

    // Update and draw particle systems
    this.particles.updateAndDraw(ctx);

    // Draw Airplane if active or waiting
    if (this.gameState === 'FLYING' || this.gameState === 'WAITING') {
      this.drawAirplane(ctx, plane.x, plane.y, plane.angle);
    }
  }

  drawAirplane(ctx, x, y, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Airplane Body (Fuselage)
    ctx.fillStyle = '#e51b24';
    ctx.shadowColor = 'rgba(229, 27, 36, 0.8)';
    ctx.shadowBlur = 10;

    ctx.beginPath();
    ctx.moveTo(25, 0); // Nose tip
    ctx.quadraticCurveTo(15, -8, -15, -6); // Top fuselage
    ctx.lineTo(-24, -18); // Tail wing top
    ctx.lineTo(-28, -16);
    ctx.lineTo(-24, 0); // Tail base
    ctx.lineTo(-28, 4);
    ctx.lineTo(-15, 6); // Bottom fuselage
    ctx.quadraticCurveTo(15, 8, 25, 0);
    ctx.closePath();
    ctx.fill();

    // Main Wings
    ctx.fillStyle = '#b7151d';
    ctx.beginPath();
    ctx.moveTo(4, -4);
    ctx.lineTo(-6, -26);
    ctx.lineTo(-14, -24);
    ctx.lineTo(-4, 0);
    ctx.closePath();
    ctx.fill();

    // Cockpit Glass
    ctx.fillStyle = '#ffffff';
    ctx.shadowBlur = 4;
    ctx.shadowColor = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(8, -2, 6, 3, Math.PI / 12, 0, Math.PI * 2);
    ctx.fill();

    // Spinning Propeller
    this.propellerAngle += 0.45;
    ctx.save();
    ctx.translate(26, 0);
    ctx.rotate(this.propellerAngle);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 2, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  // ==================== EVENT HANDLERS & ACTIONS ====================
  bindEvents() {
    this.sound.init();
    window.addEventListener('click', () => this.sound.init(), { once: true });

    // Dual Bet panel controls
    for (let slot = 0; slot <= 1; slot++) {
      const panel = document.getElementById(`panel-${slot}`);
      const input = panel.querySelector('.bet-amount-input');
      const actionBtn = panel.querySelector('.game-action-btn');
      const autoCheckbox = panel.querySelector('.auto-cashout-checkbox');
      const autoValInput = panel.querySelector('.auto-cashout-val');

      // Steppers
      panel.querySelectorAll('.step-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          let val = parseFloat(input.value) || 10;
          if (btn.dataset.action === 'plus') val += 1;
          if (btn.dataset.action === 'minus') val = Math.max(1, val - 1);
          input.value = val.toFixed(2);
          this.updateBetButtonUI(slot);
        });
      });

      // Quick chips
      panel.querySelectorAll('.chip-btn').forEach((chip) => {
        chip.addEventListener('click', () => {
          input.value = parseFloat(chip.dataset.val).toFixed(2);
          this.updateBetButtonUI(slot);
        });
      });

      input.addEventListener('input', () => this.updateBetButtonUI(slot));

      // Auto cash out toggle
      autoCheckbox.addEventListener('change', (e) => {
        autoValInput.disabled = !e.target.checked;
      });

      // Main action button (Bet, Cancel, Cashout)
      actionBtn.addEventListener('click', () => {
        this.handleBetAction(slot);
      });
    }

    // Header buttons & Modals
    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById(btn.dataset.close).classList.remove('open');
      });
    });

    document.getElementById('openVerifyModalBtn').addEventListener('click', () => {
      document.getElementById('verifyModal').classList.add('open');
    });

    document.getElementById('openHistoryModalBtn').addEventListener('click', () => {
      document.getElementById('verifyModal').classList.add('open');
    });

    document.getElementById('provablyFairBadge').addEventListener('click', () => {
      document.getElementById('verifyModal').classList.add('open');
    });

    // Auth Form
    document.getElementById('authForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleAuthSubmit();
    });

    document.getElementById('tabLogin').addEventListener('click', () => {
      document.getElementById('tabLogin').classList.add('active');
      document.getElementById('tabRegister').classList.remove('active');
      document.getElementById('authModalTitle').textContent = 'Sign In';
      document.getElementById('authSubmitBtn').textContent = 'Sign In';
    });

    document.getElementById('tabRegister').addEventListener('click', () => {
      document.getElementById('tabRegister').classList.add('active');
      document.getElementById('tabLogin').classList.remove('active');
      document.getElementById('authModalTitle').textContent = 'Create Account';
      document.getElementById('authSubmitBtn').textContent = 'Register & Get $1,000';
    });

    // Deposit Modal Tabs & Chips
    document.querySelectorAll('.deposit-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.deposit-tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.deposit-tab-content').forEach((c) => c.classList.remove('active'));
        btn.classList.add('active');
        const target = document.getElementById(btn.dataset.dtab);
        if (target) target.classList.add('active');
        if (btn.dataset.dtab === 'depositHistoryTab') {
          this.loadMyDeposits();
        }
      });
    });

    // Razorpay Chips & Launch Button
    document.querySelectorAll('.chip-deposit-rzp').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.chip-deposit-rzp').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        const amtInput = document.getElementById('rzpDepositAmountInput');
        if (amtInput) {
          amtInput.value = chip.dataset.amount;
        }
      });
    });

    const btnLaunchRzp = document.getElementById('btnLaunchRazorpay');
    if (btnLaunchRzp) {
      btnLaunchRzp.addEventListener('click', () => {
        this.handleRazorpayPayment();
      });
    }

    document.querySelectorAll('.chip-deposit').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.chip-deposit').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        const amtInput = document.getElementById('depositAmountInput');
        if (amtInput) {
          amtInput.value = chip.dataset.amount;
          this.updateUpiQr();
        }
      });
    });

    const amtInput = document.getElementById('depositAmountInput');
    if (amtInput) {
      amtInput.addEventListener('input', () => {
        this.updateUpiQr();
      });
    }

    const copyUpiBtn = document.getElementById('copyUpiBtn');
    if (copyUpiBtn) {
      copyUpiBtn.addEventListener('click', () => {
        const upiVal = document.getElementById('displayUpiId')?.textContent;
        if (upiVal && upiVal !== 'loading...') {
          navigator.clipboard.writeText(upiVal).then(() => {
            const original = copyUpiBtn.textContent;
            copyUpiBtn.textContent = '✓ Copied!';
            setTimeout(() => { copyUpiBtn.textContent = original; }, 1500);
          }).catch(() => {
            alert(`UPI ID: ${upiVal}`);
          });
        }
      });
    }

    const depositPaymentForm = document.getElementById('depositPaymentForm');
    if (depositPaymentForm) {
      depositPaymentForm.addEventListener('submit', (e) => {
        this.handleSubmitDeposit(e);
      });
    }

    // Withdrawal Modal Tabs
    document.querySelectorAll('.deposit-tab-btn[data-wtab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.deposit-tab-btn[data-wtab]').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.withdraw-tab-content').forEach((c) => {
          c.classList.remove('active');
          c.style.display = 'none';
        });
        btn.classList.add('active');
        const target = document.getElementById(btn.dataset.wtab);
        if (target) {
          target.classList.add('active');
          target.style.display = 'block';
        }
        if (btn.dataset.wtab === 'withdrawHistoryTab') {
          this.loadMyWithdrawals();
        }
      });
    });

    // Payout Method Radios (UPI vs Bank)
    const radioUpi = document.getElementById('radioPayoutUpi');
    const radioBank = document.getElementById('radioPayoutBank');
    if (radioUpi && radioBank) {
      radioUpi.addEventListener('change', () => {
        document.getElementById('withdrawUpiFields').style.display = 'block';
        document.getElementById('withdrawBankFields').style.display = 'none';
      });
      radioBank.addEventListener('change', () => {
        document.getElementById('withdrawUpiFields').style.display = 'none';
        document.getElementById('withdrawBankFields').style.display = 'block';
      });
    }

    // Submit Withdrawal Form
    const withdrawForm = document.getElementById('withdrawForm');
    if (withdrawForm) {
      withdrawForm.addEventListener('submit', (e) => {
        this.handleSubmitWithdraw(e);
      });
    }

    // Admin Refresh Withdrawals Button
    const btnRefWith = document.getElementById('refreshWithdrawalsBtn');
    if (btnRefWith) {
      btnRefWith.addEventListener('click', () => {
        this.loadAdminWithdrawals();
      });
    }

    // Verifier Form
    document.getElementById('runVerificationBtn').addEventListener('click', () => {
      this.handleVerification();
    });

    // Admin Panel Navigation
    document.querySelectorAll('.admin-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.admin-tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.admin-tab-content').forEach((c) => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'depositsTab') {
          this.loadAdminDeposits();
          this.loadAdminWithdrawals();
          this.loadAdminPaymentSettings();
        }
      });
    });

    document.getElementById('refreshUsersBtn').addEventListener('click', () => {
      this.loadAdminUsers();
    });

    document.getElementById('adminUserSearchInput').addEventListener('input', () => {
      this.loadAdminUsers();
    });

    document.getElementById('createAdminForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleCreateAdmin();
    });

    document.getElementById('submitAdjustBalanceBtn').addEventListener('click', () => {
      this.handleSubmitAdjustBalance();
    });

    // Admin Live Flight Controls
    const btnForceCrash = document.getElementById('btnForceCrashNow');
    if (btnForceCrash) {
      btnForceCrash.addEventListener('click', () => this.handleForceCrash());
    }

    const btnSetNext = document.getElementById('btnSetNextMultiplier');
    if (btnSetNext) {
      btnSetNext.addEventListener('click', () => this.handleSetNextMultiplier());
    }

    const btnSaveFlight = document.getElementById('btnSaveFlightConfig');
    if (btnSaveFlight) {
      btnSaveFlight.addEventListener('click', () => this.handleSaveFlightConfig());
    }

    // Admin Deposits and Payment Settings
    const btnRefreshDeposits = document.getElementById('refreshDepositsBtn');
    if (btnRefreshDeposits) {
      btnRefreshDeposits.addEventListener('click', () => this.loadAdminDeposits());
    }

    const paymentSettingsForm = document.getElementById('adminPaymentSettingsForm');
    if (paymentSettingsForm) {
      paymentSettingsForm.addEventListener('submit', (e) => this.handleSavePaymentSettings(e));
    }
  }

  handleBetAction(slot) {
    if (!this.currentUser) {
      document.getElementById('authModal').classList.add('open');
      return;
    }

    const panel = document.getElementById(`panel-${slot}`);
    const amount = parseFloat(panel.querySelector('.bet-amount-input').value) || 10;
    const autoCashoutChecked = panel.querySelector('.auto-cashout-checkbox').checked;
    const autoCashoutVal = autoCashoutChecked ? parseFloat(panel.querySelector('.auto-cashout-val').value) : null;
    const bet = this.userBets[slot];

    if (!bet) {
      // Place Bet
      if (this.gameState !== 'WAITING') {
        alert('Bets can only be placed during the countdown phase');
        return;
      }
      this.ws.send(JSON.stringify({
        type: 'place_bet',
        slotIndex: slot,
        amount,
        autoCashout: autoCashoutVal,
      }));
    } else if (this.gameState === 'WAITING') {
      // Cancel Bet
      this.ws.send(JSON.stringify({
        type: 'cancel_bet',
        slotIndex: slot,
      }));
    } else if (this.gameState === 'FLYING' && !bet.cashedOut) {
      // Manual Cashout
      this.ws.send(JSON.stringify({
        type: 'cash_out',
        slotIndex: slot,
      }));
    }
  }

  // ==================== AUTH & USER MANAGEMENT ====================
  async fetchCurrentUser() {
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (res.ok) {
        const data = await res.json();
        this.currentUser = data.user;
        this.renderUserSection();
      } else {
        this.token = null;
        localStorage.removeItem('aviator_token');
        this.renderUserSection();
      }
    } catch {
      this.renderUserSection();
    }
  }

  async handleAuthSubmit() {
    const isLogin = document.getElementById('tabLogin').classList.contains('active');
    const username = document.getElementById('authUsername').value.trim();
    const password = document.getElementById('authPassword').value;
    const errBox = document.getElementById('authError');
    errBox.style.display = 'none';

    try {
      const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        errBox.textContent = data.error || 'Authentication failed';
        errBox.style.display = 'block';
        return;
      }

      this.token = data.token;
      this.currentUser = data.user;
      localStorage.setItem('aviator_token', this.token);
      document.getElementById('authModal').classList.remove('open');
      this.renderUserSection();

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'auth', token: this.token }));
      }
    } catch (err) {
      errBox.textContent = 'Server error occurred';
      errBox.style.display = 'block';
    }
  }

  renderUserSection() {
    const section = document.getElementById('userSection');
    section.innerHTML = '';

    if (!this.currentUser) {
      const loginBtn = document.createElement('button');
      loginBtn.className = 'btn-auth';
      loginBtn.textContent = 'Sign In';
      loginBtn.addEventListener('click', () => {
        document.getElementById('authModal').classList.add('open');
      });
      section.appendChild(loginBtn);
      return;
    }

    // Balance Display
    const bal = document.createElement('div');
    bal.className = 'balance-badge';
    bal.innerHTML = `<span>$</span><span>${this.currentUser.balance.toFixed(2)}</span>`;
    section.appendChild(bal);

    // Deposit Button
    const depBtn = document.createElement('button');
    depBtn.className = 'btn-deposit';
    depBtn.textContent = '+ Deposit';
    depBtn.addEventListener('click', () => {
      this.openDepositModal();
    });
    section.appendChild(depBtn);

    // Withdraw Button
    const withBtn = document.createElement('button');
    withBtn.className = 'btn-deposit';
    withBtn.style.background = 'linear-gradient(135deg, #f39c12, #e67e22)';
    withBtn.style.borderColor = 'rgba(243, 156, 18, 0.5)';
    withBtn.textContent = '💸 Withdraw';
    withBtn.addEventListener('click', () => {
      this.openWithdrawModal();
    });
    section.appendChild(withBtn);

    // Admin Button if role is admin
    if (this.currentUser.role === 'admin') {
      const adminBtn = document.createElement('button');
      adminBtn.className = 'btn-admin';
      adminBtn.innerHTML = `⚙️ Admin Console`;
      adminBtn.addEventListener('click', () => {
        this.openAdminPanel();
      });
      section.appendChild(adminBtn);
    }

    // Profile & Logout
    const tag = document.createElement('span');
    tag.className = 'user-profile-tag';
    tag.textContent = `👤 ${this.currentUser.username}`;
    section.appendChild(tag);

    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'btn-logout';
    logoutBtn.textContent = 'Logout';
    logoutBtn.addEventListener('click', () => {
      this.token = null;
      this.currentUser = null;
      localStorage.removeItem('aviator_token');
      window.location.reload();
    });
    section.appendChild(logoutBtn);
  }

  // ==================== ONLINE & UPI DEPOSITS (USER-FACING) ====================
  async openDepositModal() {
    if (!this.currentUser) {
      document.getElementById('authModal').classList.add('open');
      return;
    }
    const err = document.getElementById('depositError');
    const succ = document.getElementById('depositSuccess');
    if (err) err.style.display = 'none';
    if (succ) succ.style.display = 'none';
    const rzpErr = document.getElementById('rzpDepositError');
    const rzpSucc = document.getElementById('rzpDepositSuccess');
    if (rzpErr) rzpErr.style.display = 'none';
    if (rzpSucc) rzpSucc.style.display = 'none';
    const utrInput = document.getElementById('depositUtrInput');
    if (utrInput) utrInput.value = '';

    document.getElementById('depositModal').classList.add('open');
    await Promise.all([
      this.loadPaymentInfo(),
      this.loadRazorpayConfig(),
    ]);
    this.loadMyDeposits();
  }

  async loadRazorpayConfig() {
    try {
      const res = await fetch('/api/payment/razorpay/config');
      const data = await res.json();
      const indicator = document.getElementById('rzpModeIndicator');
      if (indicator) {
        if (data.isMock) {
          indicator.textContent = '🛡️ Razorpay Test Sandbox';
          indicator.style.color = '#3498db';
        } else {
          indicator.textContent = `⚡ Razorpay Active (${data.keyId.substring(0, 10)}...)`;
          indicator.style.color = '#2ecc71';
        }
      }
    } catch {}
  }

  async handleRazorpayPayment() {
    if (!this.currentUser) {
      document.getElementById('authModal').classList.add('open');
      return;
    }
    const errBox = document.getElementById('rzpDepositError');
    const succBox = document.getElementById('rzpDepositSuccess');
    if (errBox) errBox.style.display = 'none';
    if (succBox) succBox.style.display = 'none';

    const amount = parseFloat(document.getElementById('rzpDepositAmountInput').value);
    if (isNaN(amount) || amount < 10) {
      if (errBox) {
        errBox.textContent = 'Please enter a valid amount (minimum 10)';
        errBox.style.display = 'block';
      }
      return;
    }

    const btn = document.getElementById('btnLaunchRazorpay');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Opening Payment Gateway...';
    }

    try {
      const res = await fetch('/api/payment/razorpay/create-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ amount }),
      });
      const orderData = await res.json();

      if (!res.ok) {
        if (errBox) {
          errBox.textContent = orderData.error || 'Failed to initiate Razorpay order';
          errBox.style.display = 'block';
        }
        return;
      }

      // Check if real Razorpay Checkout SDK is loaded and we have live/test keys (not mock)
      if (window.Razorpay && !orderData.isMock) {
        const options = {
          key: orderData.keyId,
          amount: orderData.amount,
          currency: orderData.currency || 'INR',
          name: 'Aviator Platform Demo',
          description: `Wallet Deposit (₹${amount})`,
          order_id: orderData.orderId,
          prefill: {
            name: this.currentUser.username,
          },
          theme: { color: '#e51b24' },
          handler: async (response) => {
            await this.verifyRazorpayPayment(
              response.razorpay_order_id,
              response.razorpay_payment_id,
              response.razorpay_signature
            );
          },
          modal: {
            ondismiss: () => {
              if (btn) {
                btn.disabled = false;
                btn.textContent = '⚡ Proceed to Pay with Razorpay';
              }
            },
          },
        };
        const rzp = new window.Razorpay(options);
        rzp.on('payment.failed', (resp) => {
          if (errBox) {
            errBox.textContent = `Payment Failed: ${resp.error?.description || 'Transaction cancelled'}`;
            errBox.style.display = 'block';
          }
        });
        rzp.open();
      } else {
        // Sandbox Simulation Mode for developers
        const proceedMock = confirm(
          `[Razorpay Developer Sandbox]\n\nSimulate payment for Order:\n${orderData.orderId}\nAmount: ₹${amount}\n\nClick OK to simulate instant successful payment.`
        );
        if (proceedMock) {
          const mockPaymentId = `pay_sim_${Date.now()}`;
          await this.verifyRazorpayPayment(orderData.orderId, mockPaymentId, 'sandbox_mock_signature');
        }
      }
    } catch (err) {
      if (errBox) {
        errBox.textContent = 'Failed to connect to Razorpay server';
        errBox.style.display = 'block';
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⚡ Proceed to Pay with Razorpay';
      }
    }
  }

  async verifyRazorpayPayment(orderId, paymentId, signature) {
    const errBox = document.getElementById('rzpDepositError');
    const succBox = document.getElementById('rzpDepositSuccess');
    if (errBox) errBox.style.display = 'none';

    try {
      const res = await fetch('/api/payment/razorpay/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ orderId, paymentId, signature }),
      });
      const data = await res.json();

      if (res.ok && data.success) {
        this.currentUser.balance = data.balance;
        this.renderUserSection();
        if (succBox) {
          succBox.textContent = `✅ Payment Confirmed! $${data.amount.toFixed(2)} credited to your wallet (Ref: ${paymentId})`;
          succBox.style.display = 'block';
        }
        this.loadMyDeposits();
      } else {
        if (errBox) {
          errBox.textContent = data.error || 'Payment signature verification failed';
          errBox.style.display = 'block';
        }
      }
    } catch {
      if (errBox) {
        errBox.textContent = 'Failed to verify payment with server';
        errBox.style.display = 'block';
      }
    }
  }

  async loadPaymentInfo() {
    try {
      const res = await fetch('/api/payment/info');
      const data = await res.json();
      if (data && data.settings) {
        this.paymentInfo = data.settings;
        const upiEl = document.getElementById('displayUpiId');
        const nameEl = document.getElementById('displayAccountName');
        const bankEl = document.getElementById('displayBankDetails');
        const accEl = document.getElementById('displayAccountNumber');

        if (upiEl) upiEl.textContent = this.paymentInfo.upi_id || 'Not configured';
        if (nameEl) nameEl.textContent = this.paymentInfo.account_name || 'Aviator Admin';
        if (bankEl) bankEl.textContent = `${this.paymentInfo.bank_name || 'Bank'} (IFSC: ${this.paymentInfo.ifsc_code || 'N/A'})`;
        if (accEl) accEl.textContent = this.paymentInfo.account_number || '-';
        this.updateUpiQr();
      }
    } catch (err) {
      console.error('Failed to load payment info:', err);
    }
  }

  updateUpiQr() {
    if (!this.paymentInfo || !this.paymentInfo.upi_id) return;
    const amount = parseFloat(document.getElementById('depositAmountInput')?.value) || 500;
    const upiId = this.paymentInfo.upi_id;
    const payeeName = this.paymentInfo.account_name || 'Aviator Game';

    // Standard Indian UPI Intent URI scheme
    const upiUri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent('Aviator Wallet Deposit')}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=8&data=${encodeURIComponent(upiUri)}`;

    const qrImg = document.getElementById('upiQrCodeImg');
    if (qrImg) {
      qrImg.src = qrUrl;
    }
  }

  async handleSubmitDeposit(e) {
    if (e) e.preventDefault();
    const errBox = document.getElementById('depositError');
    const succBox = document.getElementById('depositSuccess');
    if (errBox) errBox.style.display = 'none';
    if (succBox) succBox.style.display = 'none';

    const amount = parseFloat(document.getElementById('depositAmountInput').value);
    const utrNumber = document.getElementById('depositUtrInput').value.trim();
    const senderName = document.getElementById('depositSenderName').value.trim();

    if (isNaN(amount) || amount < 10) {
      if (errBox) {
        errBox.textContent = 'Please enter a valid amount (minimum 10)';
        errBox.style.display = 'block';
      }
      return;
    }

    if (!utrNumber || utrNumber.length < 6) {
      if (errBox) {
        errBox.textContent = 'Please enter a valid 12-digit UPI / UTR Transaction ID from your payment app';
        errBox.style.display = 'block';
      }
      return;
    }

    const submitBtn = document.getElementById('submitDepositBtn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verifying Transaction...';
    }

    try {
      const res = await fetch('/api/payment/deposit-request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          amount,
          utrNumber,
          senderName,
          paymentMethod: 'upi',
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        if (errBox) {
          errBox.textContent = data.error || 'Failed to submit deposit request';
          errBox.style.display = 'block';
        }
        return;
      }

      if (succBox) {
        succBox.textContent = `✅ Payment reference ${data.deposit.utr_number} submitted! Admin will verify and credit $${data.deposit.amount.toFixed(2)} to your wallet shortly.`;
        succBox.style.display = 'block';
      }
      document.getElementById('depositUtrInput').value = '';
      this.loadMyDeposits();
    } catch {
      if (errBox) {
        errBox.textContent = 'Failed to submit payment request. Please check your network connection.';
        errBox.style.display = 'block';
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Payment for Verification';
      }
    }
  }

  async loadMyDeposits() {
    if (!this.token) return;
    try {
      const res = await fetch('/api/payment/my-deposits', {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const data = await res.json();
      const tbody = document.getElementById('myDepositsTableBody');
      if (!tbody) return;
      tbody.innerHTML = '';

      if (data.deposits && data.deposits.length > 0) {
        data.deposits.forEach((d) => {
          const tr = document.createElement('tr');
          const statusClass = d.status === 'approved' ? 'status-active' : (d.status === 'rejected' ? 'status-banned' : 'status-pending');
          tr.innerHTML = `
            <td style="font-size:0.75rem; color:#888;">${new Date(d.created_at).toLocaleString()}</td>
            <td><strong>$${d.amount.toFixed(2)}</strong></td>
            <td><code style="color:#3498db; font-size:0.8rem;">${d.utr_number}</code></td>
            <td><span class="status-badge ${statusClass}">${d.status.toUpperCase()}</span></td>
            <td style="font-size:0.75rem; color:#aaa;">${d.admin_notes || (d.status === 'pending' ? 'Pending Admin Approval' : '-')}</td>
          `;
          tbody.appendChild(tr);
        });
      } else {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #888; padding: 16px;">No deposit transactions submitted yet.</td></tr>`;
      }
    } catch (err) {
      console.error('Error loading my deposits:', err);
    }
  }

  // ==================== USER WITHDRAWALS ====================
  openWithdrawModal() {
    if (!this.currentUser) {
      document.getElementById('authModal').classList.add('open');
      return;
    }
    const err = document.getElementById('withdrawError');
    const succ = document.getElementById('withdrawSuccess');
    if (err) err.style.display = 'none';
    if (succ) succ.style.display = 'none';

    const balEl = document.getElementById('withdrawAvailableBal');
    if (balEl) balEl.textContent = `$${this.currentUser.balance.toFixed(2)}`;

    const amtInput = document.getElementById('withdrawAmountInput');
    if (amtInput) amtInput.value = '';

    document.getElementById('withdrawModal').classList.add('open');
    this.loadMyWithdrawals();
  }

  async handleSubmitWithdraw(e) {
    if (e) e.preventDefault();
    const errBox = document.getElementById('withdrawError');
    const succBox = document.getElementById('withdrawSuccess');
    if (errBox) errBox.style.display = 'none';
    if (succBox) succBox.style.display = 'none';

    const amount = parseFloat(document.getElementById('withdrawAmountInput').value);
    const payoutMethod = document.getElementById('radioPayoutBank')?.checked ? 'bank' : 'upi';
    const upiId = document.getElementById('withdrawUpiId')?.value.trim();
    const accountHolderName = document.getElementById('withdrawAccountName')?.value.trim();
    const bankName = document.getElementById('withdrawBankName')?.value.trim();
    const accountNumber = document.getElementById('withdrawAccountNumber')?.value.trim();
    const ifscCode = document.getElementById('withdrawIfscCode')?.value.trim();

    if (isNaN(amount) || amount < 10) {
      if (errBox) {
        errBox.textContent = 'Minimum withdrawal amount is $10.00';
        errBox.style.display = 'block';
      }
      return;
    }

    if (amount > this.currentUser.balance) {
      if (errBox) {
        errBox.textContent = `Insufficient balance. Available: $${this.currentUser.balance.toFixed(2)}`;
        errBox.style.display = 'block';
      }
      return;
    }

    if (payoutMethod === 'upi' && (!upiId || upiId.length < 3)) {
      if (errBox) {
        errBox.textContent = 'Please enter a valid UPI ID (e.g. name@okhdfcbank)';
        errBox.style.display = 'block';
      }
      return;
    }

    if (payoutMethod === 'bank' && (!accountNumber || !ifscCode || !accountHolderName)) {
      if (errBox) {
        errBox.textContent = 'Please provide Account Holder Name, Account Number, and IFSC Code';
        errBox.style.display = 'block';
      }
      return;
    }

    const btn = document.getElementById('btnSubmitWithdraw');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Submitting Request...';
    }

    try {
      const res = await fetch('/api/wallet/withdraw', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          amount,
          payoutMethod,
          upiId,
          accountHolderName,
          bankName,
          accountNumber,
          ifscCode,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        if (errBox) {
          errBox.textContent = data.error || 'Failed to submit withdrawal request';
          errBox.style.display = 'block';
        }
        return;
      }

      this.currentUser.balance = data.newBalance;
      this.renderUserSection();

      const balEl = document.getElementById('withdrawAvailableBal');
      if (balEl) balEl.textContent = `$${this.currentUser.balance.toFixed(2)}`;

      if (succBox) {
        succBox.textContent = `✅ Withdrawal request for $${data.amount.toFixed(2)} submitted successfully! Administrator will process payout.`;
        succBox.style.display = 'block';
      }
      document.getElementById('withdrawAmountInput').value = '';
      this.loadMyWithdrawals();
    } catch {
      if (errBox) {
        errBox.textContent = 'Network error while submitting withdrawal request';
        errBox.style.display = 'block';
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '💸 Submit Withdrawal Request';
      }
    }
  }

  async loadMyWithdrawals() {
    if (!this.token) return;
    try {
      const res = await fetch('/api/wallet/my-withdrawals', {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const data = await res.json();
      const tbody = document.getElementById('myWithdrawalsTableBody');
      if (!tbody) return;
      tbody.innerHTML = '';

      if (data.withdrawals && data.withdrawals.length > 0) {
        data.withdrawals.forEach((w) => {
          const tr = document.createElement('tr');
          const statusClass = w.status === 'approved' ? 'status-active' : (w.status === 'rejected' ? 'status-banned' : 'status-pending');
          tr.innerHTML = `
            <td style="font-size:0.75rem; color:#888;">${new Date(w.createdAt).toLocaleString()}</td>
            <td><strong>$${w.amount.toFixed(2)}</strong></td>
            <td><span class="role-badge role-user">${(w.payoutMethod || 'UPI').toUpperCase()}</span></td>
            <td><code style="color:#3498db; font-size:0.8rem;">${w.destination}</code></td>
            <td><span class="status-badge ${statusClass}">${w.status.toUpperCase()}</span></td>
            <td style="font-size:0.75rem; color:#aaa;">${w.adminNotes || (w.status === 'pending' ? 'Pending Payout Approval' : '-')}</td>
          `;
          tbody.appendChild(tr);
        });
      } else {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #888; padding: 16px;">No withdrawal requests found.</td></tr>`;
      }
    } catch (err) {
      console.error('Error loading my withdrawals:', err);
    }
  }

  // ==================== PROVABLY FAIR VERIFIER ====================
  openVerifierWithData(round) {
    document.getElementById('verifyServerSeed').value = round.serverSeed || '';
    document.getElementById('verifyClientSeed').value = round.clientSeed || '';
    document.getElementById('verifyExpectedHash').value = round.serverSeedHash || '';
    document.getElementById('verifyExpectedMultiplier').value = round.multiplier || '';
    document.getElementById('verifyModal').classList.add('open');
    this.handleVerification();
  }

  async handleVerification() {
    const serverSeed = document.getElementById('verifyServerSeed').value.trim();
    const clientSeed = document.getElementById('verifyClientSeed').value.trim();
    const expectedHash = document.getElementById('verifyExpectedHash').value.trim();
    const expectedMultiplier = document.getElementById('verifyExpectedMultiplier').value;
    const resBox = document.getElementById('verificationResult');

    if (!serverSeed || !clientSeed) {
      alert('Please provide both Server Seed and Client Seed');
      return;
    }

    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverSeed, clientSeed, expectedHash, expectedMultiplier }),
      });
      const result = await res.json();

      resBox.style.display = 'block';
      resBox.innerHTML = `
        <div style="background: rgba(0,0,0,0.3); padding: 14px; border-radius: 8px; border: 1px solid ${result.valid ? '#2ecc71' : '#e74c3c'}">
          <h4 style="color: ${result.valid ? '#2ecc71' : '#e74c3c'}; margin-bottom: 8px;">
            ${result.valid ? '✅ Cryptographic Verification Successful (100% Fair)' : '❌ Verification Failed'}
          </h4>
          <p style="font-size: 0.85rem; font-family: monospace; word-break: break-all;">
            <strong>Calculated Multiplier:</strong> ${result.calculatedMultiplier.toFixed(2)}x<br>
            <strong>Pre-Round Hash Match:</strong> ${result.isHashValid ? 'Valid' : 'Invalid / Mismatch'}<br>
            <strong>Combined SHA-512 Hash:</strong><br>${result.combinedHash}
          </p>
        </div>
      `;
    } catch {
      alert('Verification request failed');
    }
  }

  // ==================== ADMIN PANEL (REQUIREMENTS 1 & 2 + FLIGHT CONTROLS + BANKING) ====================
  async openAdminPanel() {
    document.getElementById('adminModal').classList.add('open');
    this.updateAdminStatusPill();
    await Promise.all([
      this.loadAdminStats(),
      this.loadAdminUsers(),
      this.loadAdminRounds(),
      this.loadAdminLogs(),
      this.loadAdminDeposits(),
      this.loadAdminWithdrawals(),
      this.loadAdminPaymentSettings(),
      this.loadAdminFlightConfig(),
    ]);
  }

  async loadAdminStats() {
    try {
      const res = await fetch('/api/admin/stats', {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (!res.ok) return;

      const s = data.stats;
      document.getElementById('kpiTotalUsers').textContent = s.totalUsers;
      document.getElementById('kpiActiveUsers').textContent = s.activeUsers;
      document.getElementById('kpiTotalAdmins').textContent = s.totalAdmins;
      document.getElementById('kpiHouseProfit').textContent = `$${s.houseProfit.toFixed(2)}`;
      document.getElementById('kpiTotalWagered').textContent = `$${s.totalWagered.toFixed(2)}`;
      document.getElementById('kpiTotalRounds').textContent = s.totalRounds;
    } catch {}
  }

  // Feature 1: Full Access of Users
  async loadAdminUsers() {
    const search = document.getElementById('adminUserSearchInput').value.trim();
    try {
      const res = await fetch(`/api/admin/users?search=${encodeURIComponent(search)}`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (!res.ok) return;

      const tbody = document.getElementById('adminUsersTableBody');
      tbody.innerHTML = '';

      const adminsTbody = document.getElementById('currentAdminsTableBody');
      adminsTbody.innerHTML = '';

      data.users.forEach((u) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${u.id}</td>
          <td><strong>${u.username}</strong></td>
          <td><span class="role-badge role-${u.role}">${u.role}</span></td>
          <td style="font-family: monospace; font-weight: 700; color: #4cd964;">$${u.balance.toFixed(2)}</td>
          <td>${u.total_bets}</td>
          <td>$${u.total_wagered.toFixed(2)}</td>
          <td>$${u.total_won.toFixed(2)}</td>
          <td><span class="status-badge ${u.is_active ? 'status-active' : 'status-banned'}">${u.is_active ? 'Active' : 'Banned'}</span></td>
          <td>
            <button class="btn-table-action" onclick="app.openAdjustBalance(${u.id}, '${u.username}', ${u.balance})">Adjust Balance</button>
            <button class="btn-table-action ${u.is_active ? 'btn-table-ban' : ''}" onclick="app.toggleUserStatus(${u.id}, ${u.is_active})">${u.is_active ? 'Ban' : 'Unban'}</button>
            <button class="btn-table-action" onclick="app.viewUserBets(${u.id}, '${u.username}')">Bets</button>
            ${u.role !== 'admin' ? `<button class="btn-table-action" style="color: #bb6bd9;" onclick="app.changeUserRole(${u.id}, 'admin')">Make Admin</button>` : ''}
          </td>
        `;
        tbody.appendChild(tr);

        // Populate active admins tab
        if (u.role === 'admin') {
          const adminTr = document.createElement('tr');
          adminTr.innerHTML = `
            <td>${u.id}</td>
            <td><strong>${u.username}</strong></td>
            <td>$${u.balance.toFixed(2)}</td>
            <td>
              ${u.id !== this.currentUser.id ? `<button class="btn-table-action btn-table-ban" onclick="app.changeUserRole(${u.id}, 'user')">Demote to User</button>` : '<span style="color:#888;">(Current Session)</span>'}
            </td>
          `;
          adminsTbody.appendChild(adminTr);
        }
      });
    } catch {}
  }

  // Feature 2: In Admin Panel, Add Admins
  async handleCreateAdmin() {
    const username = document.getElementById('newAdminUsername').value.trim();
    const password = document.getElementById('newAdminPassword').value;
    const initialBalance = document.getElementById('newAdminBalance').value;
    const errBox = document.getElementById('createAdminError');
    const successBox = document.getElementById('createAdminSuccess');

    errBox.style.display = 'none';
    successBox.style.display = 'none';

    try {
      const res = await fetch('/api/admin/create-admin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ username, password, initialBalance }),
      });
      const data = await res.json();

      if (!res.ok) {
        errBox.textContent = data.error || 'Failed to create admin';
        errBox.style.display = 'block';
        return;
      }

      successBox.textContent = `Administrator "${data.admin.username}" created successfully!`;
      successBox.style.display = 'block';
      document.getElementById('createAdminForm').reset();
      this.loadAdminUsers();
      this.loadAdminStats();
    } catch (err) {
      errBox.textContent = 'Server request failed';
      errBox.style.display = 'block';
    }
  }

  async changeUserRole(userId, newRole) {
    if (!confirm(`Are you sure you want to change user ${userId} role to "${newRole}"?`)) return;

    try {
      const res = await fetch(`/api/admin/users/${userId}/role`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ role: newRole }),
      });
      if (res.ok) {
        this.loadAdminUsers();
        this.loadAdminStats();
      } else {
        const data = await res.json();
        alert(data.error);
      }
    } catch {
      alert('Role change failed');
    }
  }

  openAdjustBalance(userId, username, currentBalance) {
    this.currentAdjustUserId = userId;
    document.getElementById('adjustBalanceUsername').textContent = username;
    document.getElementById('adjustBalanceCurrent').textContent = `$${currentBalance.toFixed(2)}`;
    document.getElementById('adjustBalanceAmount').value = '';
    document.getElementById('adjustBalanceReason').value = '';
    document.getElementById('adjustBalanceModal').classList.add('open');
  }

  async handleSubmitAdjustBalance() {
    const amount = parseFloat(document.getElementById('adjustBalanceAmount').value);
    const reason = document.getElementById('adjustBalanceReason').value;

    if (isNaN(amount) || amount === 0) {
      alert('Enter a valid amount (+ or -)');
      return;
    }

    try {
      const res = await fetch(`/api/admin/users/${this.currentAdjustUserId}/balance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ amount, reason }),
      });
      if (res.ok) {
        document.getElementById('adjustBalanceModal').classList.remove('open');
        this.loadAdminUsers();
        this.loadAdminStats();
      } else {
        const data = await res.json();
        alert(data.error);
      }
    } catch {
      alert('Balance update failed');
    }
  }

  async toggleUserStatus(userId, currentActive) {
    const action = currentActive ? 'ban' : 'unban';
    if (!confirm(`Are you sure you want to ${action} user ${userId}?`)) return;

    try {
      const res = await fetch(`/api/admin/users/${userId}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ isActive: !currentActive }),
      });
      if (res.ok) {
        this.loadAdminUsers();
        this.loadAdminStats();
      } else {
        const data = await res.json();
        alert(data.error);
      }
    } catch {
      alert('Status change failed');
    }
  }

  async viewUserBets(userId, username) {
    document.getElementById('userBetsModalUsername').textContent = username;
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const data = await res.json();
      const tbody = document.getElementById('userBetsModalTableBody');
      tbody.innerHTML = '';

      if (data.bets && data.bets.length > 0) {
        data.bets.forEach((b) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${b.id}</td>
            <td>#${b.round_id}</td>
            <td>$${b.amount.toFixed(2)}</td>
            <td>${b.auto_cashout ? `${b.auto_cashout}x` : '-'}</td>
            <td>${b.cashed_out_at ? `${b.cashed_out_at.toFixed(2)}x` : '-'}</td>
            <td style="color: ${b.payout > 0 ? '#2ecc71' : '#ff4757'}">+$${b.payout.toFixed(2)}</td>
            <td><span class="status-badge ${b.status === 'won' ? 'status-active' : 'status-banned'}">${b.status}</span></td>
            <td style="font-size:0.75rem; color:#888;">${new Date(b.created_at).toLocaleTimeString()}</td>
          `;
          tbody.appendChild(tr);
        });
      } else {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: #888;">No bets recorded for this user yet.</td></tr>`;
      }

      document.getElementById('userBetsModal').classList.add('open');
    } catch {
      alert('Failed to load user bets');
    }
  }

  async loadAdminRounds() {
    try {
      const res = await fetch('/api/admin/rounds?limit=30', {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const data = await res.json();
      const tbody = document.getElementById('adminRoundsTableBody');
      tbody.innerHTML = '';

      data.rounds.forEach((r) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>#${r.id}</strong></td>
          <td><span class="history-pill ${r.crash_multiplier >= 10 ? 'pill-gold' : r.crash_multiplier >= 2 ? 'pill-purple' : 'pill-blue'}">${r.crash_multiplier.toFixed(2)}x</span></td>
          <td style="font-family: monospace; font-size: 0.72rem;">${r.server_seed}</td>
          <td style="font-family: monospace; font-size: 0.72rem;">${r.client_seed}</td>
          <td><span class="status-badge status-active">${r.status}</span></td>
          <td style="font-size: 0.75rem; color: #888;">${new Date(r.created_at).toLocaleTimeString()}</td>
        `;
        tbody.appendChild(tr);
      });
    } catch {}
  }

  async loadAdminLogs() {
    try {
      const res = await fetch('/api/admin/logs', {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const data = await res.json();
      const tbody = document.getElementById('adminLogsTableBody');
      tbody.innerHTML = '';

      data.logs.forEach((l) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-size: 0.75rem; color: #888;">${new Date(l.created_at).toLocaleTimeString()}</td>
          <td><strong>${l.action}</strong></td>
          <td>🛡️ ${l.admin_username || 'System'}</td>
          <td>${l.target_username ? `👤 ${l.target_username}` : '-'}</td>
          <td style="font-family: monospace; font-size: 0.72rem;">${l.details || '-'}</td>
        `;
        tbody.appendChild(tr);
      });
    } catch {}
  }

  // ==================== LIVE FLIGHT CONTROLS & EMERGENCY CRASH ====================
  updateAdminStatusPill() {
    const pill = document.getElementById('adminGameStatusPill');
    if (!pill) return;
    if (this.gameState === 'WAITING') {
      pill.textContent = `State: WAITING (${this.countdown ? this.countdown.toFixed(1) : 0}s) | Round #${this.roundId || '-'}`;
      pill.style.background = 'rgba(52, 152, 219, 0.2)';
      pill.style.borderColor = 'rgba(52, 152, 219, 0.4)';
      pill.style.color = '#3498db';
    } else if (this.gameState === 'FLYING') {
      pill.textContent = `State: FLYING (${this.currentMultiplier.toFixed(2)}x) | Round #${this.roundId || '-'}`;
      pill.style.background = 'rgba(46, 204, 113, 0.2)';
      pill.style.borderColor = 'rgba(46, 204, 113, 0.4)';
      pill.style.color = '#2ecc71';
    } else if (this.gameState === 'CRASHED') {
      pill.textContent = `State: CRASHED @ ${this.crashMultiplier ? this.crashMultiplier.toFixed(2) : '-'}x | Round #${this.roundId || '-'}`;
      pill.style.background = 'rgba(229, 27, 36, 0.2)';
      pill.style.borderColor = 'rgba(229, 27, 36, 0.4)';
      pill.style.color = '#e51b24';
    }
  }

  async handleForceCrash() {
    if (!confirm('🚨 Emergency: Force plane to crash ("Flew Away") right now?')) return;
    try {
      const res = await fetch('/api/admin/game/force-crash', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
      });
      const data = await res.json();
      if (res.ok) {
        alert(`💥 ${data.message || 'Plane has crashed!'}`);
        this.updateAdminStatusPill();
      } else {
        alert(data.error || 'Failed to force crash');
      }
    } catch {
      alert('Request failed');
    }
  }

  async handleSetNextMultiplier() {
    const input = document.getElementById('adminNextMultiplierInput');
    const mult = parseFloat(input.value);
    if (isNaN(mult) || mult < 1.0) {
      alert('Please enter a multiplier >= 1.00x');
      return;
    }

    try {
      const res = await fetch('/api/admin/game/set-next-multiplier', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ multiplier: mult }),
      });
      const data = await res.json();
      if (res.ok) {
        const text = document.getElementById('nextMultiplierStatusText');
        if (text) {
          text.textContent = `Next round crash point set to: ${mult.toFixed(2)}x`;
          text.style.color = '#2ecc71';
        }
        alert(`🎯 Target crash multiplier for next round set to ${mult.toFixed(2)}x`);
        input.value = '';
      } else {
        alert(data.error || 'Failed to set next multiplier');
      }
    } catch {
      alert('Request failed');
    }
  }

  async handleSaveFlightConfig() {
    const countdownSec = parseFloat(document.getElementById('adminCountdownSecInput').value);
    const speedFactor = parseFloat(document.getElementById('adminSpeedFactorInput').value);

    try {
      const res = await fetch('/api/admin/game/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ countdownSec, speedFactor }),
      });
      const data = await res.json();
      if (res.ok) {
        alert(`⏱️ Flight config updated: Countdown = ${data.countdownSec}s, Curve Rate = ${data.flightSpeedFactor}`);
      } else {
        alert(data.error || 'Failed to update flight config');
      }
    } catch {
      alert('Request failed');
    }
  }

  async loadAdminFlightConfig() {
    try {
      const res = await fetch('/api/admin/game/status', {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (res.ok && data) {
        if (data.countdownSec) {
          const el = document.getElementById('adminCountdownSecInput');
          if (el) el.value = data.countdownSec;
        }
        if (data.flightSpeedFactor) {
          const el = document.getElementById('adminSpeedFactorInput');
          if (el) el.value = data.flightSpeedFactor;
        }
        if (data.forcedNextMultiplier) {
          const text = document.getElementById('nextMultiplierStatusText');
          if (text) {
            text.textContent = `Next round multiplier set to: ${data.forcedNextMultiplier.toFixed(2)}x`;
            text.style.color = '#2ecc71';
          }
        }
      }
    } catch {}
  }

  // ==================== ADMIN DEPOSITS & RECEIVING BANK SETTINGS ====================
  async loadAdminDeposits() {
    try {
      const res = await fetch('/api/admin/deposits', {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const data = await res.json();
      const tbody = document.getElementById('adminDepositsTableBody');
      if (!tbody) return;
      tbody.innerHTML = '';

      if (data.deposits && data.deposits.length > 0) {
        data.deposits.forEach((d) => {
          const tr = document.createElement('tr');
          const isPending = d.status === 'pending';
          const statusBadge = d.status === 'approved'
            ? '<span class="status-badge status-active">APPROVED</span>'
            : (d.status === 'rejected' ? '<span class="status-badge status-banned">REJECTED</span>' : '<span class="status-badge status-pending" style="background: rgba(241,196,15,0.2); color: #f1c40f;">PENDING</span>');

          let actions = '';
          if (isPending) {
            actions = `
              <button class="btn-table-action" style="color: #2ecc71; border-color: #2ecc71;" onclick="app.approveDeposit(${d.id})">Approve & Credit</button>
              <button class="btn-table-action btn-table-ban" onclick="app.rejectDeposit(${d.id})">Reject</button>
            `;
          } else {
            actions = `<span style="font-size:0.75rem; color:#888;">${d.admin_notes || d.status}</span>`;
          }

          tr.innerHTML = `
            <td>#${d.id}</td>
            <td><strong>${d.username}</strong></td>
            <td style="font-weight:700; color:#2ecc71;">$${d.amount.toFixed(2)}</td>
            <td><span class="role-badge role-user">${(d.payment_method || 'UPI').toUpperCase()}</span></td>
            <td><code style="font-family: monospace; font-size: 0.85rem; color: #3498db; font-weight: 700;">${d.utr_number}</code></td>
            <td>${d.sender_name || '-'}</td>
            <td style="font-size: 0.75rem; color: #888;">${new Date(d.created_at).toLocaleTimeString()}</td>
            <td>${statusBadge}</td>
            <td>${actions}</td>
          `;
          tbody.appendChild(tr);
        });
      } else {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: #888; padding: 20px;">No incoming deposit requests found.</td></tr>`;
      }
    } catch (err) {
      console.error('Failed to load admin deposits:', err);
    }
  }

  async approveDeposit(depositId) {
    if (!confirm(`Are you sure you want to approve deposit #${depositId} and credit the user's wallet?`)) return;

    try {
      const res = await fetch(`/api/admin/deposits/${depositId}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.message || 'Deposit approved successfully!');
        this.loadAdminDeposits();
        this.loadAdminUsers();
        this.loadAdminStats();
        if (this.currentUser) this.fetchCurrentUser();
      } else {
        alert(data.error || 'Failed to approve deposit');
      }
    } catch {
      alert('Approve request failed');
    }
  }

  async rejectDeposit(depositId) {
    const reason = prompt('Enter rejection reason (e.g., UTR not found, incorrect amount, fake receipt):', 'UTR reference not found in bank statement');
    if (!reason) return;

    try {
      const res = await fetch(`/api/admin/deposits/${depositId}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json();
      if (res.ok) {
        alert('Deposit request rejected.');
        this.loadAdminDeposits();
        this.loadAdminStats();
      } else {
        alert(data.error || 'Failed to reject deposit');
      }
    } catch {
      alert('Reject request failed');
    }
  }

  // ==================== ADMIN WITHDRAWALS ====================
  async loadAdminWithdrawals() {
    try {
      const res = await fetch('/api/admin/withdrawals', {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const data = await res.json();
      const tbody = document.getElementById('adminWithdrawalsTableBody');
      if (!tbody) return;
      tbody.innerHTML = '';

      if (data.withdrawals && data.withdrawals.length > 0) {
        data.withdrawals.forEach((w) => {
          const tr = document.createElement('tr');
          const isPending = w.status === 'pending';
          const statusBadge = w.status === 'approved'
            ? '<span class="status-badge status-active">APPROVED</span>'
            : (w.status === 'rejected' ? '<span class="status-badge status-banned">REJECTED</span>' : '<span class="status-badge status-pending" style="background: rgba(241,196,15,0.2); color: #f1c40f;">PENDING</span>');

          const details = w.accountDetailsParsed || {};
          const destText = w.payout_method === 'upi'
            ? `UPI: ${details.upiId || '-'}`
            : `${details.accountHolderName || ''} | A/C: ${details.accountNumber || ''} | IFSC: ${details.ifscCode || ''} (${details.bankName || ''})`;

          let actions = '';
          if (isPending) {
            actions = `
              <button class="btn-table-action" style="color: #2ecc71; border-color: #2ecc71;" onclick="app.approveWithdrawal(${w.id})">Approve Payout</button>
              <button class="btn-table-action btn-table-ban" onclick="app.rejectWithdrawal(${w.id})">Reject & Refund</button>
            `;
          } else {
            actions = `<span style="font-size:0.75rem; color:#888;">${w.admin_notes || w.status}</span>`;
          }

          tr.innerHTML = `
            <td>#${w.id}</td>
            <td><strong>${w.username}</strong></td>
            <td style="font-weight:700; color:#f39c12;">$${w.amount.toFixed(2)}</td>
            <td><span class="role-badge role-user">${(w.payout_method || 'UPI').toUpperCase()}</span></td>
            <td><code style="font-family: monospace; font-size: 0.8rem; color: #3498db;">${destText}</code></td>
            <td style="font-size: 0.75rem; color: #888;">${new Date(w.created_at).toLocaleTimeString()}</td>
            <td>${statusBadge}</td>
            <td>${actions}</td>
          `;
          tbody.appendChild(tr);
        });
      } else {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: #888; padding: 20px;">No outgoing withdrawal requests found.</td></tr>`;
      }
    } catch (err) {
      console.error('Failed to load admin withdrawals:', err);
    }
  }

  async approveWithdrawal(withdrawalId) {
    const notes = prompt('Enter payment transaction reference (e.g. UPI Ref / Bank IMPS number):', `IMPS_${Date.now()}`);
    if (!notes) return;

    try {
      const res = await fetch(`/api/admin/withdrawals/${withdrawalId}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ notes }),
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.message || 'Withdrawal approved!');
        this.loadAdminWithdrawals();
        this.loadAdminStats();
      } else {
        alert(data.error || 'Failed to approve withdrawal');
      }
    } catch {
      alert('Approve request failed');
    }
  }

  async rejectWithdrawal(withdrawalId) {
    const reason = prompt('Enter rejection reason (funds will be refunded to user):', 'Incorrect bank account details / invalid IFSC');
    if (!reason) return;

    try {
      const res = await fetch(`/api/admin/withdrawals/${withdrawalId}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.message || 'Withdrawal rejected and balance refunded!');
        this.loadAdminWithdrawals();
        this.loadAdminUsers();
        this.loadAdminStats();
        if (this.currentUser) this.fetchCurrentUser();
      } else {
        alert(data.error || 'Failed to reject withdrawal');
      }
    } catch {
      alert('Reject request failed');
    }
  }

  async loadAdminPaymentSettings() {
    try {
      const res = await fetch('/api/admin/payment-settings', {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (res.ok && data.settings) {
        const s = data.settings;
        const setVal = (id, val) => {
          const el = document.getElementById(id);
          if (el && val !== undefined) el.value = val || '';
        };
        setVal('settingUpiId', s.upi_id);
        setVal('settingAccountName', s.account_name);
        setVal('settingBankName', s.bank_name);
        setVal('settingAccountNumber', s.account_number);
        setVal('settingIfscCode', s.ifsc_code);
        setVal('settingInstructions', s.instructions);
        setVal('settingRazorpayKeyId', s.razorpay_key_id);
        setVal('settingRazorpayKeySecret', s.razorpay_key_secret);
      }
    } catch (err) {
      console.error('Failed to load admin payment settings:', err);
    }
  }

  async handleSavePaymentSettings(e) {
    if (e) e.preventDefault();
    const succ = document.getElementById('paymentSettingsSuccess');
    const err = document.getElementById('paymentSettingsError');
    if (succ) succ.style.display = 'none';
    if (err) err.style.display = 'none';

    const upi_id = document.getElementById('settingUpiId').value.trim();
    const account_name = document.getElementById('settingAccountName').value.trim();
    const bank_name = document.getElementById('settingBankName').value.trim();
    const account_number = document.getElementById('settingAccountNumber').value.trim();
    const ifsc_code = document.getElementById('settingIfscCode').value.trim();
    const instructions = document.getElementById('settingInstructions').value.trim();
    const razorpay_key_id = (document.getElementById('settingRazorpayKeyId')?.value || '').trim();
    const razorpay_key_secret = (document.getElementById('settingRazorpayKeySecret')?.value || '').trim();

    if (!upi_id || !account_name) {
      if (err) {
        err.textContent = 'Please enter both your UPI ID and Account Holder Name';
        err.style.display = 'block';
      }
      return;
    }

    try {
      const res = await fetch('/api/admin/payment-settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          upi_id,
          account_name,
          bank_name,
          account_number,
          ifsc_code,
          instructions,
          razorpay_key_id,
          razorpay_key_secret,
        }),
      });
      const data = await res.json();

      if (res.ok) {
        if (succ) {
          succ.textContent = '✅ Bank and UPI details saved! User deposits will now be directed to this account.';
          succ.style.display = 'block';
        }
        await this.loadPaymentInfo();
      } else {
        if (err) {
          err.textContent = data.error || 'Failed to update payment settings';
          err.style.display = 'block';
        }
      }
    } catch {
      if (err) {
        err.textContent = 'Network error while saving payment settings';
        err.style.display = 'block';
      }
    }
  }
}

// Global initialization
window.app = new AviatorApp();
