# Aviator — Full-Featured Provably Fair Crash Game & Admin Operations

A full-stack, clean-room recreation of the popular Aviator crash game, built with Node.js, WebSockets, HTML5 Canvas, SQLite, and an administrative operations console with flight control and online UPI payment gateway routing.

---

## What's New in this Release

1. **Hidden Credentials:** All demo usernames and passwords have been removed from the login screen and UI forms for clean security and privacy.
2. **Live Flight Controller & Emergency Crash:**
   - **Emergency Crash ("Flew Away Now"):** Immediately force the plane to crash in real time while flying.
   - **Preset / Rig Next Multiplier:** Specify the exact crash point (e.g. `1.20x`, `5.50x`, `20.00x`) for the upcoming round.
   - **Fly Time & Speed Config:** Customize the countdown betting duration (2–30s) and flight curve climbing speed.
3. **Online / UPI Payment Gateway with Direct Admin Bank Account Routing:**
   - **All User Payments Go Directly to Admin:** Configure your receiving UPI ID, account holder name, bank name, account number, and IFSC code in the Admin Panel.
   - **Dynamic QR Code & Intent Link:** The deposit modal generates a standard UPI QR code and deep link with the selected amount.
   - **12-Digit UTR Submission:** Users enter their transaction/UTR reference ID after paying.
   - **Admin Verification Queue:** Admin reviews incoming payments and clicks **Approve & Credit** to immediately credit user wallet balance.
4. **Razorpay Payment Gateway (Developer Sandbox & Test Mode):**
   - **Instant Online Checkout:** Deposit using UPI, Debit/Credit Cards, or NetBanking via Razorpay Checkout SDK.
   - **HMAC-SHA256 Signature Verification:** Server-side signature checks prevent tampering and credit user wallet automatically upon confirmation.
   - **Flexible Sandbox Simulation:** Works out-of-the-box in simulation test mode, or connects to real Razorpay Test Keys (`rzp_test_...`) via Admin Panel or `.env`.
5. **User Withdrawal System & Admin Payout Queue:**
   - **User Cashout Request:** Users can click **💸 Withdraw** to request payouts to their UPI VPA or Bank Account (IMPS/NEFT).
   - **Atomic Balance Deduction:** Funds are deducted immediately upon request to prevent double spending.
   - **Admin Payout Queue:** Admin reviews withdrawal requests with user account details and marks them as approved upon payment.
   - **Automatic Balance Refund on Rejection:** If an admin rejects a withdrawal (e.g. invalid IFSC or account), the requested amount is automatically refunded back to the user's wallet balance.

---

## Architecture & Technology Stack

- **Game Engine & WebSocket Server:** Node.js + `ws` for real-time multiplayer state synchronization (~50ms ticker).
- **REST APIs:** Express 4 for authentication, wallet transactions, UPI deposit workflows, and administrative operations.
- **Database:** High-performance SQLite via Node 24 native `node:sqlite` (`DatabaseSync`), with WAL mode and atomic balance updates.
- **Cryptography (Provably Fair):** SHA-256 pre-round server seed hashing and SHA-512 52-bit entropy derivation with an authentic 3% house edge formula:
  $$\text{Multiplier} = \max\left(1.00, \left\lfloor \frac{97}{1 - \frac{N}{2^{52}}} \right\rfloor \div 100 \right)$$
- **Frontend Engine:**
  - High-framerate 60 FPS HTML5 Canvas engine with glowing exponential Bezier flight curves, red propeller plane with spinning rotor, and particle blast trails.
  - Dual simultaneous betting docks (Panel 1 and Panel 2) with manual and auto cashout.
  - Procedural Web Audio API synthesizer (takeoff whoosh, climb tone, cashout celebration chime, crash explosion).
  - Built-in Provably Fair mathematical verifier.
- **Administrative Operations:**
  - **Live Flight Controller:** Emergency crash button ("Flew Away Now"), next round multiplier override, and flight duration tuning.
  - **Bank & UPI Configuration:** Set your personal/business UPI ID and bank account details where all user deposits are routed.
  - **Deposit Approval Queue:** Verify user-submitted UTR numbers against your bank statement and approve with 1-click wallet crediting.
  - **Full Access of Users:** Search users, adjust balances (+/-), view bet history, and ban/unban accounts.
  - **Manage Admins:** Provision new administrators or promote/demote existing users.

---

## Initial Admin Setup

On a new database, the app creates the `admin` account using `ADMIN_PASSWORD`. Set a unique password of at least 12 characters before the first start. No default admin password or demo player is created. New registrations receive a $1,000.00 starting balance for gameplay.

In production, also set `JWT_SECRET` to a random value of at least 32 bytes. The app refuses to start in production without it. Render generates both values through `render.yaml`.

---

## Quick Start & Setup Instructions

### 1. Prerequisites
- **Node.js** v22.x or v24.x+ installed.

### 2. Installation
From the `aviator-app` directory:
```bash
npm install
```

### 3. Configure secrets before first start
Set `ADMIN_PASSWORD` to a unique password (at least 12 characters) and `JWT_SECRET` to a random value of at least 32 bytes. These are required to initialize a new database and run in production, respectively. Do not commit real values.

### 4. Run the Automated Test Suite
To verify the complete Provably Fair math, live flight controls, emergency crash, UPI deposits, user management, and admin operations:
```bash
npm test
```
*All 31 unit and integration tests will run and pass with 0 failures.*

### 5. Start the Application
```bash
npm start
```
The server will start at:
- **Web Game & Admin UI:** [http://localhost:3000](http://localhost:3000)
- **WebSocket Endpoint:** `ws://localhost:3000/ws`

---

## How to Use the New Features

### 1. Emergency Crash & Flight Manipulation (Admin)
1. Sign in as `admin` using the `ADMIN_PASSWORD` value set for the app.
2. Click **⚙️ Admin Console** in the top navigation bar.
3. At the top of the Admin Console, find the **Live Flight Controller & Crash Manager**:
   - **💥 FLEW AWAY NOW (Crash Plane):** Click this button while a flight is active (`FLYING`). The plane immediately crashes and flies away on screen for all players!
   - **🎯 Set Next Crash Multiplier:** Enter a target value (e.g. `1.15` or `10.50`) and click **Set Multiplier**. The next round will crash at that exact number.
   - **⏱️ Fly Time & Speed Config:** Change the betting countdown duration (e.g. `5` seconds) and exponential climb rate, then click **Save**.

### 2. Set Your Bank Account & UPI Details (Where Money Goes)
1. In the **Admin Console**, click the **💳 Deposit Requests & Banking** tab.
2. Scroll to **🏦 Your Receiving Bank & UPI Details**.
3. Enter:
   - **Your UPI ID:** your configured payment address
   - **Account Holder Name:** Your name or company name
   - **Bank Name & Account Number:** Your bank details
   - **IFSC Code:** Your branch IFSC
   - **Instructions:** Custom notes displayed on user deposit screen
4. Click **💾 Save Receiving Account Details**.
5. All future deposit requests and QR codes will now direct money directly to your account.

### 3. User Deposit & Online UPI Flow
1. As a player, click **+ Deposit** in the top header.
2. The modal displays:
   - Your configured **UPI ID** with a **📋 Copy** button.
   - Dynamic **UPI QR Code** (scannable by Google Pay, PhonePe, Paytm, BHIM, etc.).
   - Bank Name, Account Number, and IFSC code.
3. The user pays via their UPI / Bank app and receives a 12-digit reference number (UTR).
4. The user enters the amount and their **12-digit Transaction Reference / UTR Number**, then clicks **Submit Payment for Verification**.
5. The transaction appears in the **My Deposit History** tab as `PENDING`.

### 4. Approving Deposits & Crediting User Balances
1. In the **Admin Console** under **💳 Deposit Requests & Banking**, check the **Incoming Deposit Verification Queue**.
2. Match the user's 12-digit UTR against your bank/UPI transaction history.
3. Click **Approve & Credit**:
   - The user's wallet is credited atomically with the deposit amount.
   - The deposit status switches to `APPROVED`.
4. If a UTR is fake or unverified, click **Reject** and provide a reason.
