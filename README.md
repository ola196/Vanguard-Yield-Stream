# Vanguard Yield Stream

**Vanguard Yield Stream** is a second-by-second payment streaming protocol built natively on [Soroban](https://developers.stellar.org/docs/smart-contracts) smart contracts on the Stellar Network. It converts static token deposits into continuous linear payment streams — enabling trustless payroll, RWA yield disbursements, and token vesting without manual claim-and-transfer steps.

---

## The Problem It Solves

Tokenized Real-World Assets (RWAs) on Stellar — such as Franklin Templeton's BENJI fund, Backed Finance instruments, or Spiko T-Bills — generate interest continuously. But conventional disbursement models require manual, periodic transfers. This creates:

- **Cash-flow friction** — recipients wait for scheduled transfers instead of accessing earned yield in real time.
- **Operational overhead** — issuers must execute on-chain transfers manually or maintain centralised automation.
- **Trust gaps** — recipients have no guarantee funds will arrive; senders have no enforceable streaming obligation.

**Vanguard Yield Stream** solves all three. A sender deposits tokens once into a Soroban escrow and specifies a recipient and time window. Tokens accrue to the recipient every second at a deterministic integer rate. The recipient can withdraw any accrued amount at any time. The sender can cancel early, with automatic settlement of earned and unearned portions.

---

## Why This Is Valuable to the Stellar Ecosystem

| Use Case | How It Applies |
|---|---|
| **RWA Yield Distribution** | Tokenised fund managers can stream yield to holders continuously rather than via batch distributions |
| **Streaming Payroll** | DAOs and remote teams can replace bi-weekly payroll with a continuous stream — employees access earned income in real time |
| **Token Vesting** | Projects can lock founder/team allocations and stream them over multi-year vesting schedules on-chain |
| **Freelance Escrow** | Clients lock payment upfront; freelancers withdraw in proportion to elapsed time or milestones |
| **Subscription Billing** | Service providers receive continuous payment rather than one-shot monthly transfers |

Stellar's 5-second ledger close time and sub-cent fees make it uniquely suited for high-frequency, micro-value streaming at scale — something that would be prohibitively expensive on most EVM chains.

---

## Architecture

```
vanguard yield stream/
├── Cargo.toml                          # Workspace manifest
├── contracts/
│   └── vanguard_stream/
│       ├── Cargo.toml                  # soroban-sdk 22.0.0 dependency
│       └── src/
│           ├── lib.rs                  # Contract core logic
│           ├── types.rs                # DataKey enum + Stream struct
│           └── test.rs                 # Unit test suite
│       └── tests/
│           └── integration.rs          # Cross-crate integration tests
├── scripts/
│   ├── deploy.sh                       # Bash deployment (Linux/macOS/WSL)
│   └── deploy.ps1                      # PowerShell deployment (Windows)
├── frontend/
│   ├── package.json
│   ├── next.config.js
│   ├── tailwind.config.ts
│   ├── tsconfig.json
│   ├── .env.local.example
│   └── src/
│       ├── app/
│       │   ├── layout.tsx              # Root layout with metadata
│       │   ├── page.tsx                # Entry page
│       │   └── globals.css             # Tailwind + custom animations
│       ├── components/
│       │   ├── StreamDashboard.tsx     # Top-level layout + state
│       │   ├── WalletConnect.tsx       # Freighter connection UI
│       │   ├── CreateStreamForm.tsx    # Stream creation form
│       │   ├── StreamCard.tsx          # Live stream visualiser card
│       │   ├── StreamList.tsx          # Stream tracker + refresh
│       │   └── ui/
│       │       ├── Badge.tsx
│       │       ├── Button.tsx
│       │       └── Card.tsx
│       └── lib/
│           ├── freighter.ts            # Freighter wallet service
│           └── soroban.ts              # Contract invocation + utilities
└── README.md
```

---

## Smart Contract Design

### Storage Layout

The contract uses two storage tiers:

- **Instance storage** — Admin address, token address, next stream ID counter, and pause flag. Extended automatically on every write.
- **Persistent storage** — Per-stream `Stream` structs, keyed by `DataKey::Stream(u64)`. Each entry has its TTL renewed on every read-mutating operation.

### Stream Lifecycle

```
create_stream()
  └─► Transfer deposit → escrow
  └─► Compute rate_per_second = deposit / duration
  └─► Persist Stream { id, sender, recipient, deposit, 0, start, stop, rate, false }

balance_of()  [read-only]
  └─► elapsed = min(now, stop_time) - start_time
  └─► accrued = elapsed × rate_per_second
  └─► withdrawable = accrued - withdrawn_amount

withdraw()
  └─► recipient.require_auth()
  └─► Check amount <= balance_of()
  └─► Update withdrawn_amount (checked_add)
  └─► Transfer from escrow → recipient

cancel_stream()
  └─► sender.require_auth()
  └─► Compute accrued (balance_of) and unaccrued (deposit - withdrawn - accrued)
  └─► Mark is_cancelled = true
  └─► Transfer accrued → recipient (if > 0)
  └─► Transfer unaccrued → sender (if > 0)
```

### Security Properties

**Authentication**
- `initialize` — requires admin signature
- `set_paused` — requires admin signature; address verified against stored admin
- `create_stream` — requires sender signature (prevents spoofed streams funded by others)
- `withdraw` — requires recipient signature
- `cancel_stream` — requires sender signature

**Arithmetic Safety**

All arithmetic uses Rust's checked operations (`checked_add`, `checked_sub`, `checked_mul`, `checked_div`). Any overflow returns `Error::MathOverflow` rather than panicking or silently wrapping. The release profile also has `overflow-checks = true` as a secondary defense layer.

**Checks-Effects-Interactions**

State is always written before external token transfers. In `cancel_stream`, `is_cancelled = true` is persisted before any transfer calls, preventing re-entrancy through repeated cancellation.

**Rate Truncation**

Integer division truncates fractional stroops. For example, depositing 1,000,001 stroops over 1,000 seconds yields a rate of 1,000 stroops/sec — the 1-stroop remainder is returned to the sender on cancellation. This is deterministic and predictable.

**Emergency Circuit Breaker**

`set_paused(true)` halts all `create_stream`, `withdraw`, and `cancel_stream` calls immediately. `set_paused(false)` resumes operations. This allows an admin to freeze the contract in seconds if a vulnerability or market incident is detected.

### TTL Management

Soroban state has ledger rent via TTL (Time-to-Live). This contract extends TTL proactively:

- Instance storage is extended on `initialize`, `create_stream`, and `withdraw` calls.
- Persistent stream entries are extended on `create_stream`, `withdraw`, and `cancel_stream`.

The constant `THIRTY_DAYS_IN_LEDGERS = 518_400` is based on a ~5-second average ledger close time. This keeps active streams alive without requiring a separate maintenance transaction.

---

## Test Suite

19 unit tests plus external integration coverage covering every execution path:

| Test | What It Verifies |
|---|---|
| `test_full_stream_lifecycle` | Create → pre-start 0 balance → midpoint accrual → partial withdraw → post-end full withdraw |
| `test_cancel_stream_midpoint` | 50/50 split on cancel at midpoint; escrow emptied |
| `test_cancel_stream_before_start` | Full refund to sender when cancelled before start |
| `test_cancel_stream_after_end` | Full amount to recipient when cancelled after stop_time |
| `test_pause_blocks_create_stream` | ContractPaused (#10) on create while paused |
| `test_pause_blocks_withdraw` | ContractPaused (#10) on withdraw while paused |
| `test_unpause_resumes_operations` | Pause → unpause → normal operation restored |
| `test_unauthorized_pause` | Unauthorized (#3) when non-admin tries to pause |
| `test_double_initialization_rejected` | AlreadyInitialized (#2) on second initialize call |
| `test_create_stream_zero_amount_rejected` | InvalidAmount (#5) on zero deposit |
| `test_create_stream_past_start_time_rejected` | InvalidTimeRange (#4) on past start_time |
| `test_create_stream_stop_before_start_rejected` | InvalidTimeRange (#4) on stop_time == start_time |
| `test_create_stream_zero_rate_rejected` | InvalidAmount (#5) when rate rounds to zero |
| `test_withdraw_exceeds_available_balance` | InvalidAmount (#5) on over-withdrawal |
| `test_double_cancel_rejected` | StreamCancelled (#8) on second cancel |
| `test_get_nonexistent_stream_fails` | StreamNotFound (#6) on unknown ID |
| `test_multiple_streams_independent` | Two streams don't interfere with each other |
| `test_rate_truncation_refunded_on_cancel` | 1-stroop truncation remainder returned to sender |
| `test_single_second_precision` | Per-second balance accrual accuracy at 1s intervals |

Run the full suite:

```bash
cargo test
```

Run with output:

```bash
cargo test -- --nocapture
```

---

## Quick Start

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| Rust | 1.84+ | [rustup.rs](https://rustup.rs) |
| wasm32v1-none target | — | `rustup target add wasm32v1-none` |
| stellar-cli | latest | `cargo install stellar-cli` |
| Node.js | 18+ | [nodejs.org](https://nodejs.org) |
| Freighter | latest | [freighter.app](https://www.freighter.app) |

### 1. Build and test the contract

```bash
# From the workspace root
cargo test
```

### 2. Configure a Testnet identity

```bash
# Generate a new keypair
stellar keys generate admin --network testnet

# Fund it from the Testnet Friendbot
stellar keys fund admin --network testnet
```

### 3. Deploy to Testnet

**Linux / macOS / WSL:**
```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

**Windows (PowerShell):**
```powershell
.\scripts\deploy.ps1
```

**With a specific token SAC address:**
```bash
./scripts/deploy.sh --identity admin --token CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

The script will:
1. Run the full test suite
2. Compile the WASM binary
3. Deploy to Testnet
4. Initialize the contract
5. Write `NEXT_PUBLIC_STREAM_CONTRACT_ID` to `frontend/.env.local`

### 4. Launch the frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and connect your Freighter wallet.

---

## Frontend Overview

Built with **Next.js 14 App Router**, **TypeScript**, and **Tailwind CSS**.

### Key Screens

**Landing (wallet disconnected)**
- Protocol description and feature highlights
- Connect Freighter button
- Link to install Freighter if not detected

**Dashboard (wallet connected)**
- **Create Stream form** — recipient address, deposit amount, duration (days/hours/minutes), start delay, live rate preview
- **Stream List** — track any stream by ID; shows live progress bar, accrued balance (refreshed every 5 seconds), withdraw panel for recipients, cancel button for senders

### Wallet Integration

`src/lib/freighter.ts` wraps `@stellar/freighter-api`:

- `isFreighterInstalled()` — checks for extension presence (SSR-safe)
- `connectWallet()` — triggers permission popup, returns public key
- `getConnectedAddress()` — restores session on page reload
- `signTx(xdr, passphrase)` — signs a transaction XDR, returns signed XDR

### Contract Integration

`src/lib/soroban.ts` handles:

- Building transactions via `TransactionBuilder`
- Simulation via `server.prepareTransaction()` for fee/footprint
- Signing via Freighter
- Submission and polling via `server.sendTransaction()` + `server.getTransaction()`
- Read-only queries via `server.simulateTransaction()`

---

## Environment Variables

Copy `.env.local.example` to `.env.local` (populated automatically by deploy scripts):

```env
NEXT_PUBLIC_STREAM_CONTRACT_ID=    # Deployed contract ID
NEXT_PUBLIC_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NEXT_PUBLIC_HORIZON_URL=https://horizon-testnet.stellar.org
```

---

## Production Readiness

This repository is a Stellar Testnet project intended for evaluation and
reproducible local testing. Mainnet use requires an independent Soroban
security audit, operational key management, monitoring, and a staged
small-value rollout. Unit tests cannot establish production safety on their
own.

## Security Checklist

Before moving to Mainnet, verify the following:

- [ ] Replace `mock_all_auths()` in tests with explicit auth mocking for each operation
- [ ] Add a time-lock delay to admin operations (e.g., pause requires a 24h notice)
- [ ] Implement multi-sig admin using Stellar's native threshold system
- [ ] Consider rate-limiting stream creation per address to mitigate spam
- [x] Cancelled streams are terminal and cannot be withdrawn twice
- [ ] Audit TTL extension logic — ensure no stream can be created with a duration exceeding the TTL window
- [ ] Engage a third-party Soroban security auditor before handling significant value
- [ ] Verify the SAC token address is the expected issuer before initializing

---

## Gas and Storage Optimization Notes

- **Integer math only** — no floats, no divisions at read time (rate is precomputed at creation)
- **Single persistent entry per stream** — one storage key per stream, not one per second or per event
- **Lazy TTL extension** — TTL is renewed only on state-mutating calls, not on reads
- **`opt-level = "z"`** in release profile minimises WASM binary size, reducing upload fee
- **`lto = true`** with `codegen-units = 1` enables maximum dead-code elimination

---

## License

MIT — see [LICENSE](./LICENSE) for details.

---

## Acknowledgements

- [Stellar Development Foundation](https://stellar.org) for Soroban
- [Sablier Finance](https://sablier.com) for pioneering the payment streaming concept on EVM
- [Freighter](https://www.freighter.app) wallet team
