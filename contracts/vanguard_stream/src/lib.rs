//! # Vanguard Yield Stream — Core Smart Contract
//!
//! A second-by-second linear payment streaming protocol built on Soroban.
//! Enables trustless, continuous token distribution for payroll, RWA yield
//! disbursements, and vesting schedules on the Stellar Network.
//!
//! ## Key Design Decisions
//! - Integer-only arithmetic (no floats) for deterministic precision
//! - `require_auth` on every state-mutating entrypoint
//! - Persistent storage with automatic TTL renewal to prevent state archival
//! - Admin-controlled circuit breaker for emergency security response

#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, token, Address, Env};

mod types;
use types::*;

/// Enumeration of all contract-level error codes.
/// Surfaces as `Error(Contract, #N)` in Soroban transaction results.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Contract has not been initialized yet
    NotInitialized = 1,
    /// initialize() called more than once
    AlreadyInitialized = 2,
    /// Caller is not the authorized party for this operation
    Unauthorized = 3,
    /// start_time is in the past or stop_time <= start_time
    InvalidTimeRange = 4,
    /// Deposit amount is zero, negative, or results in zero rate-per-second
    InvalidAmount = 5,
    /// No stream exists for the provided stream_id
    StreamNotFound = 6,
    /// Stream has already passed its stop_time (informational, unused currently)
    StreamEnded = 7,
    /// Operation attempted on an already-cancelled stream
    StreamCancelled = 8,
    /// Checked arithmetic operation would overflow/underflow
    MathOverflow = 9,
    /// All state-mutating calls are halted while contract is paused
    ContractPaused = 10,
}

/// Approximate ledger count for 30 days, assuming ~5-second average ledger close time.
/// Used as the TTL threshold and extension period for all persistent state.
const THIRTY_DAYS_IN_LEDGERS: u32 = 518_400;

#[contract]
pub struct VanguardStreamContract;

#[contractimpl]
impl VanguardStreamContract {
    // ─────────────────────────────────────────────────────────────
    // ADMIN FUNCTIONS
    // ─────────────────────────────────────────────────────────────

    /// Initialize the contract with an admin and a Stellar Asset Contract token.
    ///
    /// # Arguments
    /// * `admin` — Address that will hold admin privileges (pause/unpause)
    /// * `token` — SAC token address used for all stream deposits and transfers
    ///
    /// # Errors
    /// Returns `AlreadyInitialized` if called more than once.
    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }

        // Admin must sign this transaction to prove ownership of the address
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::NextStreamId, &1u64);
        env.storage().instance().set(&DataKey::Paused, &false);

        // Extend instance storage TTL so contract state persists for 30 days
        env.storage()
            .instance()
            .extend_ttl(THIRTY_DAYS_IN_LEDGERS, THIRTY_DAYS_IN_LEDGERS);

        Ok(())
    }

    /// Toggle the emergency circuit breaker.
    ///
    /// When `paused = true`, all stream creation, withdrawals, and cancellations
    /// are blocked until an admin calls this with `paused = false`.
    ///
    /// # Arguments
    /// * `admin` — Must match the stored admin address
    /// * `paused` — Target pause state
    ///
    /// # Errors
    /// Returns `NotInitialized` if contract is not yet set up.
    /// Returns `Unauthorized` if the caller is not the stored admin.
    pub fn set_paused(env: Env, admin: Address, paused: bool) -> Result<(), Error> {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }

        // Verify admin's signature on this transaction
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &paused);

        Ok(())
    }

    // ─────────────────────────────────────────────────────────────
    // STREAM LIFECYCLE FUNCTIONS
    // ─────────────────────────────────────────────────────────────

    /// Create a new second-by-second linear payment stream.
    ///
    /// Transfers `amount` tokens from `sender` into contract escrow immediately.
    /// The recipient can then withdraw accrued tokens at any time between
    /// `start_time` and `stop_time`.
    ///
    /// # Arguments
    /// * `sender`     — Funding party (must sign the transaction)
    /// * `recipient`  — Receiving party
    /// * `amount`     — Total tokens to stream, in stroops
    /// * `start_time` — Unix timestamp for stream start (must be >= now)
    /// * `stop_time`  — Unix timestamp for stream end (must be > start_time)
    ///
    /// # Returns
    /// The newly assigned `stream_id` (starts at 1, increments by 1).
    ///
    /// # Errors
    /// * `ContractPaused`   — Contract is currently paused
    /// * `InvalidAmount`    — amount <= 0 or rate_per_second rounds to 0
    /// * `InvalidTimeRange` — start_time < now or stop_time <= start_time
    /// * `NotInitialized`   — Contract not yet initialized
    pub fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        amount: i128,
        start_time: u64,
        stop_time: u64,
    ) -> Result<u64, Error> {
        Self::ensure_not_paused(&env)?;

        // Only the sender can authorize funding their own stream
        sender.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let now = env.ledger().timestamp();

        // Enforce valid time window: start must be in the future, end after start
        if start_time < now || stop_time <= start_time {
            return Err(Error::InvalidTimeRange);
        }

        let duration = stop_time
            .checked_sub(start_time)
            .ok_or(Error::MathOverflow)?;

        // Calculate integer rate-per-second (truncates fractional stroops)
        let rate_per_second = amount
            .checked_div(duration as i128)
            .ok_or(Error::MathOverflow)?;

        // Guard: if amount is too small for the duration, rate rounds to zero
        if rate_per_second == 0 {
            return Err(Error::InvalidAmount);
        }

        // Fetch the registered token address
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)?;

        // Pull the full deposit into contract escrow atomically
        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(&sender, &env.current_contract_address(), &amount);

        // Read and increment the stream ID counter
        let stream_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextStreamId)
            .unwrap_or(1);

        let stream = Stream {
            id: stream_id,
            sender,
            recipient,
            deposit_amount: amount,
            withdrawn_amount: 0,
            start_time,
            stop_time,
            rate_per_second,
            is_cancelled: false,
        };

        // Persist stream state with a 30-day TTL window
        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &stream);
        env.storage().persistent().extend_ttl(
            &DataKey::Stream(stream_id),
            THIRTY_DAYS_IN_LEDGERS,
            THIRTY_DAYS_IN_LEDGERS,
        );

        // Advance the counter for the next stream
        env.storage()
            .instance()
            .set(&DataKey::NextStreamId, &(stream_id + 1));
        env.storage()
            .instance()
            .extend_ttl(THIRTY_DAYS_IN_LEDGERS, THIRTY_DAYS_IN_LEDGERS);

        Ok(stream_id)
    }

    /// Calculate the currently withdrawable balance for a stream.
    ///
    /// Uses the formula:
    /// `withdrawable = (elapsed_seconds * rate_per_second) - withdrawn_amount`
    ///
    /// where `elapsed_seconds` is capped at `stop_time - start_time`.
    ///
    /// # Arguments
    /// * `stream_id` — ID of the stream to query
    ///
    /// # Returns
    /// Available balance in stroops, or 0 if stream hasn't started yet.
    ///
    /// # Errors
    /// * `StreamNotFound` — No stream with the given ID
    /// * `MathOverflow`   — Arithmetic would overflow (should never occur with valid data)
    pub fn balance_of(env: Env, stream_id: u64) -> Result<i128, Error> {
        let stream: Stream = env
            .storage()
            .persistent()
            .get(&DataKey::Stream(stream_id))
            .ok_or(Error::StreamNotFound)?;

        let now = env.ledger().timestamp();

        // Stream hasn't started yet — no tokens have accrued
        if now < stream.start_time {
            return Ok(0);
        }

        // Cap elapsed time at the stream's full duration
        let elapsed = if now >= stream.stop_time {
            stream.stop_time - stream.start_time
        } else {
            now - stream.start_time
        };

        // Total tokens that should have accrued by now
        let total_accrued = (elapsed as i128)
            .checked_mul(stream.rate_per_second)
            .ok_or(Error::MathOverflow)?;

        // Subtract already-withdrawn amount to get net withdrawable
        let withdrawable = total_accrued
            .checked_sub(stream.withdrawn_amount)
            .ok_or(Error::MathOverflow)?;

        Ok(withdrawable)
    }

    /// Withdraw accrued tokens from a stream to the recipient's wallet.
    ///
    /// Only the stream's `recipient` may call this. Partial withdrawals are
    /// supported — the caller specifies exactly how much to pull out.
    ///
    /// # Arguments
    /// * `stream_id` — Target stream
    /// * `amount`    — Tokens to withdraw (must be <= current `balance_of`)
    ///
    /// # Errors
    /// * `ContractPaused`  — Contract is currently paused
    /// * `StreamNotFound`  — No stream with the given ID
    /// * `InvalidAmount`   — amount <= 0 or exceeds available balance
    /// * `MathOverflow`    — Arithmetic overflow on withdrawn_amount update
    pub fn withdraw(env: Env, stream_id: u64, amount: i128) -> Result<(), Error> {
        Self::ensure_not_paused(&env)?;

        let mut stream: Stream = env
            .storage()
            .persistent()
            .get(&DataKey::Stream(stream_id))
            .ok_or(Error::StreamNotFound)?;

        if stream.is_cancelled {
            return Err(Error::StreamCancelled);
        }

        // Only the designated recipient may withdraw
        stream.recipient.require_auth();

        let available = Self::balance_of(env.clone(), stream_id)?;

        if amount <= 0 || amount > available {
            return Err(Error::InvalidAmount);
        }

        // Update withdrawn tally before transferring (checks-effects-interactions)
        stream.withdrawn_amount = stream
            .withdrawn_amount
            .checked_add(amount)
            .ok_or(Error::MathOverflow)?;

        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &stream);
        env.storage().persistent().extend_ttl(
            &DataKey::Stream(stream_id),
            THIRTY_DAYS_IN_LEDGERS,
            THIRTY_DAYS_IN_LEDGERS,
        );

        // Transfer tokens from contract escrow to recipient
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)?;

        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(&env.current_contract_address(), &stream.recipient, &amount);

        Ok(())
    }

    /// Cancel a stream and settle final balances.
    ///
    /// Sends any accrued-but-unwithdrawn tokens to the recipient and returns
    /// the remaining unaccrued deposit back to the sender. Only the sender
    /// may cancel.
    ///
    /// # Arguments
    /// * `stream_id` — Target stream
    ///
    /// # Errors
    /// * `ContractPaused`    — Contract is currently paused
    /// * `StreamNotFound`    — No stream with the given ID
    /// * `StreamCancelled`   — Stream was already cancelled
    /// * `MathOverflow`      — Arithmetic overflow computing unaccrued balance
    pub fn cancel_stream(env: Env, stream_id: u64) -> Result<(), Error> {
        Self::ensure_not_paused(&env)?;

        let mut stream: Stream = env
            .storage()
            .persistent()
            .get(&DataKey::Stream(stream_id))
            .ok_or(Error::StreamNotFound)?;

        // Only the original sender may cancel
        stream.sender.require_auth();

        if stream.is_cancelled {
            return Err(Error::StreamCancelled);
        }

        // Compute what recipient has earned so far (accrued but not yet withdrawn)
        let accrued = Self::balance_of(env.clone(), stream_id)?;

        // What remains in escrow that recipient has NOT earned
        let unaccrued = stream
            .deposit_amount
            .checked_sub(stream.withdrawn_amount)
            .ok_or(Error::MathOverflow)?
            .checked_sub(accrued)
            .ok_or(Error::MathOverflow)?;

        // Mark cancelled and settle the stream before external calls.
        // Setting withdrawn_amount to the full deposit makes the terminal
        // state unambiguous to balance_of and prevents later claims.
        stream.is_cancelled = true;
        stream.withdrawn_amount = stream
            .deposit_amount
            .checked_sub(unaccrued)
            .ok_or(Error::MathOverflow)?;
        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &stream);

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)?;

        let token_client = token::Client::new(&env, &token_addr);

        // Pay recipient their earned portion
        if accrued > 0 {
            token_client.transfer(&env.current_contract_address(), &stream.recipient, &accrued);
        }

        // Refund sender their unearned deposit
        if unaccrued > 0 {
            token_client.transfer(&env.current_contract_address(), &stream.sender, &unaccrued);
        }

        Ok(())
    }

    /// Get full stream metadata by ID.
    ///
    /// Useful for frontend dashboards to display stream details without
    /// computing balance separately.
    pub fn get_stream(env: Env, stream_id: u64) -> Result<Stream, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Stream(stream_id))
            .ok_or(Error::StreamNotFound)
    }

    // ─────────────────────────────────────────────────────────────
    // INTERNAL HELPERS
    // ─────────────────────────────────────────────────────────────

    /// Internal guard: returns `Err(ContractPaused)` if the circuit breaker is active.
    fn ensure_not_paused(env: &Env) -> Result<(), Error> {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);

        if paused {
            Err(Error::ContractPaused)
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod test;
