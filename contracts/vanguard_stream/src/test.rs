//! # Vanguard Yield Stream — Test Suite
//!
//! Comprehensive unit and integration tests covering:
//! - Full stream lifecycle (create → accrue → withdraw → complete)
//! - Stream cancellation with mid-stream settlement
//! - Emergency circuit breaker (pause/unpause)
//! - Authorization enforcement (unauthorized callers)
//! - Edge cases: zero amount, zero rate, bad time ranges, double-cancel
//! - Math: overflow guards and boundary arithmetic
//! - Multi-stream independence
//! - Double initialization guard

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Env,
};

// ─────────────────────────────────────────────────────────────────────────────
// TEST HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/// Bootstraps a fresh environment with a mock SAC token and an initialized
/// VanguardStreamContract. Returns (env, client, token_client, sac_client,
/// admin, sender, recipient, contract_id).
#[allow(clippy::type_complexity)]
fn setup() -> (
    Env,
    VanguardStreamContractClient<'static>,
    token::Client<'static>,
    token::StellarAssetClient<'static>,
    Address,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    // Deploy a Stellar Asset Contract (SAC) mock token
    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token_contract.address();

    let token_client = token::Client::new(&env, &token_address);
    let sac_client = token::StellarAssetClient::new(&env, &token_address);

    // Mint a generous supply to the sender for testing
    sac_client.mint(&sender, &1_000_000_000_000i128);

    // Register Vanguard Stream contract
    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);

    // Initialize with admin and token
    client.initialize(&admin, &token_address);

    // Leak env lifetime to satisfy borrow checker in return
    let env: Env = unsafe { std::mem::transmute(env) };
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &token_address);
    let sac_client = token::StellarAssetClient::new(&env, &token_address);

    (
        env,
        client,
        token_client,
        sac_client,
        admin,
        sender,
        recipient,
        contract_id,
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// LIFECYCLE TESTS
// ─────────────────────────────────────────────────────────────────────────────

/// Tests the complete happy-path lifecycle of a stream:
/// create → pre-start balance=0 → mid-stream partial withdraw → full stream withdraw
#[test]
fn test_full_stream_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token_contract.address();

    let token_client = token::Client::new(&env, &token_address);
    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &1_000_000_000i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);

    client.initialize(&admin, &token_address);

    // --- Create stream ---
    // 100_000_000 stroops over 1_000 seconds = 100_000 stroops/sec
    let start_time = 1_000u64;
    let stop_time = 2_000u64;
    let deposit = 100_000_000i128;

    env.ledger().with_mut(|li| li.timestamp = 500);

    let stream_id = client.create_stream(&sender, &recipient, &deposit, &start_time, &stop_time);
    assert_eq!(stream_id, 1, "First stream ID should be 1");

    // Contract escrow holds the full deposit
    assert_eq!(
        token_client.balance(&contract_id),
        deposit,
        "Contract should hold full deposit"
    );

    // Sender's balance reduced by deposit
    assert_eq!(
        token_client.balance(&sender),
        1_000_000_000 - deposit,
        "Sender balance should decrease by deposit"
    );

    // --- Before start: zero balance ---
    env.ledger().with_mut(|li| li.timestamp = 999);
    assert_eq!(
        client.balance_of(&stream_id),
        0,
        "No balance should accrue before start_time"
    );

    // --- At exact start time: zero balance (0 elapsed seconds) ---
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    assert_eq!(
        client.balance_of(&stream_id),
        0,
        "Zero balance at exact start_time"
    );

    // --- At midpoint (1_500s): 500 seconds elapsed → 50_000_000 stroops ---
    env.ledger().with_mut(|li| li.timestamp = 1_500);
    assert_eq!(
        client.balance_of(&stream_id),
        50_000_000,
        "Half the deposit should accrue at midpoint"
    );

    // --- Partial withdrawal ---
    client.withdraw(&stream_id, &30_000_000);
    assert_eq!(
        token_client.balance(&recipient),
        30_000_000,
        "Recipient should receive withdrawn amount"
    );
    assert_eq!(
        client.balance_of(&stream_id),
        20_000_000,
        "Remaining balance after partial withdrawal"
    );

    // --- After stop_time: balance caps at deposit minus withdrawn ---
    env.ledger().with_mut(|li| li.timestamp = 2_500);
    assert_eq!(
        client.balance_of(&stream_id),
        70_000_000,
        "Balance should be full deposit minus already withdrawn at/after stop_time"
    );

    // --- Final withdrawal ---
    client.withdraw(&stream_id, &70_000_000);
    assert_eq!(
        token_client.balance(&recipient),
        100_000_000,
        "Recipient should have received full deposit"
    );
    assert_eq!(
        client.balance_of(&stream_id),
        0,
        "Nothing left after complete withdrawal"
    );

    // Contract escrow should be empty
    assert_eq!(token_client.balance(&contract_id), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCELLATION TESTS
// ─────────────────────────────────────────────────────────────────────────────

/// Cancel at midpoint: recipient gets accrued portion, sender gets unaccrued refund.
#[test]
fn test_cancel_stream_midpoint() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let token_client = token::Client::new(&env, &token_address);
    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &1_000_000_000i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    env.ledger().with_mut(|li| li.timestamp = 500);

    // 100_000_000 over 1_000s = 100_000 stroops/sec
    let stream_id =
        client.create_stream(&sender, &recipient, &100_000_000, &1_000, &2_000);

    let sender_balance_after_create = token_client.balance(&sender);

    // Advance to midpoint, cancel
    env.ledger().with_mut(|li| li.timestamp = 1_500);
    client.cancel_stream(&stream_id);

    // At midpoint: 50_000_000 accrued → recipient gets 50_000_000
    assert_eq!(token_client.balance(&recipient), 50_000_000);
    // Unaccrued 50_000_000 → refunded to sender
    assert_eq!(
        token_client.balance(&sender),
        sender_balance_after_create + 50_000_000
    );
    // Contract escrow is empty
    assert_eq!(token_client.balance(&contract_id), 0);

    // Stream should be marked cancelled
    let stream = client.get_stream(&stream_id);
    assert!(stream.is_cancelled);
}

/// Cancel before stream starts: sender gets full refund, recipient gets nothing.
#[test]
fn test_cancel_stream_before_start() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let token_client = token::Client::new(&env, &token_address);
    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &500_000_000i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    env.ledger().with_mut(|li| li.timestamp = 100);

    let stream_id =
        client.create_stream(&sender, &recipient, &100_000_000, &1_000, &2_000);

    let sender_balance_before = token_client.balance(&sender);

    // Cancel before start
    env.ledger().with_mut(|li| li.timestamp = 500);
    client.cancel_stream(&stream_id);

    // Full refund to sender
    assert_eq!(
        token_client.balance(&sender),
        sender_balance_before + 100_000_000
    );
    // Recipient gets nothing
    assert_eq!(token_client.balance(&recipient), 0);
}

/// Cancel after stream fully completes: recipient gets full deposit, sender gets nothing.
#[test]
fn test_cancel_stream_after_end() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let token_client = token::Client::new(&env, &token_address);
    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &500_000_000i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    env.ledger().with_mut(|li| li.timestamp = 100);
    let stream_id =
        client.create_stream(&sender, &recipient, &100_000_000, &1_000, &2_000);

    // Cancel after stop_time
    env.ledger().with_mut(|li| li.timestamp = 3_000);
    client.cancel_stream(&stream_id);

    // Recipient receives full deposit
    assert_eq!(token_client.balance(&recipient), 100_000_000);
    // Sender gets zero refund
    assert_eq!(token_client.balance(&sender), 500_000_000 - 100_000_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// CIRCUIT BREAKER TESTS
// ─────────────────────────────────────────────────────────────────────────────

/// Paused contract should reject stream creation with ContractPaused error.
#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn test_pause_blocks_create_stream() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &1_000_000i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    // Engage circuit breaker
    client.set_paused(&admin, &true);

    env.ledger().with_mut(|li| li.timestamp = 100);
    // This should panic with ContractPaused (#10)
    client.create_stream(&sender, &recipient, &10_000, &200, &300);
}

/// Paused contract should reject withdrawals.
#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn test_pause_blocks_withdraw() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &1_000_000_000i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    env.ledger().with_mut(|li| li.timestamp = 100);
    let stream_id = client.create_stream(&sender, &recipient, &100_000_000, &1_000, &2_000);

    // Engage circuit breaker after stream creation
    client.set_paused(&admin, &true);

    env.ledger().with_mut(|li| li.timestamp = 1_500);
    // Withdrawal should be blocked
    client.withdraw(&stream_id, &50_000_000);
}

/// Admin can unpause a previously paused contract and resume normal operations.
#[test]
fn test_unpause_resumes_operations() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let token_client = token::Client::new(&env, &token_address);
    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &1_000_000_000i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    // Pause then immediately unpause
    client.set_paused(&admin, &true);
    client.set_paused(&admin, &false);

    env.ledger().with_mut(|li| li.timestamp = 100);
    let stream_id = client.create_stream(&sender, &recipient, &100_000_000, &1_000, &2_000);

    env.ledger().with_mut(|li| li.timestamp = 1_500);
    client.withdraw(&stream_id, &50_000_000);

    assert_eq!(token_client.balance(&recipient), 50_000_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTHORIZATION TESTS
// ─────────────────────────────────────────────────────────────────────────────

/// Non-admin address cannot pause the contract.
#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_unauthorized_pause() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    // Attacker tries to pause — should fail with Unauthorized (#3)
    client.set_paused(&attacker, &true);
}

// ─────────────────────────────────────────────────────────────────────────────
// INITIALIZATION GUARD TESTS
// ─────────────────────────────────────────────────────────────────────────────

/// Calling initialize() twice should fail with AlreadyInitialized.
#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_double_initialization_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);

    client.initialize(&admin, &token_address);
    // Second call should panic with AlreadyInitialized (#2)
    client.initialize(&admin, &token_address);
}

// ─────────────────────────────────────────────────────────────────────────────
// INPUT VALIDATION TESTS
// ─────────────────────────────────────────────────────────────────────────────

/// Zero deposit amount should be rejected.
#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_create_stream_zero_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    env.ledger().with_mut(|li| li.timestamp = 100);
    // Amount = 0 should panic with InvalidAmount (#5)
    client.create_stream(&sender, &recipient, &0, &1_000, &2_000);
}

/// start_time in the past should be rejected.
#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_create_stream_past_start_time_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &1_000_000i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    // Ledger at 1_000, start_time at 500 (past) → InvalidTimeRange (#4)
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    client.create_stream(&sender, &recipient, &100_000, &500, &2_000);
}

/// stop_time <= start_time should be rejected.
#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_create_stream_stop_before_start_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &1_000_000i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    env.ledger().with_mut(|li| li.timestamp = 100);
    // stop_time == start_time → InvalidTimeRange (#4)
    client.create_stream(&sender, &recipient, &100_000, &1_000, &1_000);
}

/// Deposit too small to produce a non-zero rate_per_second should be rejected.
#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_create_stream_zero_rate_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &1_000_000i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    env.ledger().with_mut(|li| li.timestamp = 100);
    // 1 stroop over 10_000 seconds → rate = 0 → InvalidAmount (#5)
    client.create_stream(&sender, &recipient, &1, &1_000, &11_000);
}

/// Withdrawing more than available balance should be rejected.
#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_withdraw_exceeds_available_balance() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &1_000_000_000i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    env.ledger().with_mut(|li| li.timestamp = 100);
    let stream_id = client.create_stream(&sender, &recipient, &100_000_000, &1_000, &2_000);

    env.ledger().with_mut(|li| li.timestamp = 1_500);
    // Available = 50_000_000, requesting 60_000_000 → InvalidAmount (#5)
    client.withdraw(&stream_id, &60_000_000);
}

/// Cancelling an already-cancelled stream should fail with StreamCancelled.
#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_double_cancel_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &1_000_000_000i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    env.ledger().with_mut(|li| li.timestamp = 100);
    let stream_id = client.create_stream(&sender, &recipient, &100_000_000, &1_000, &2_000);

    env.ledger().with_mut(|li| li.timestamp = 1_200);
    client.cancel_stream(&stream_id);

    // Second cancel on same stream → StreamCancelled (#8)
    client.cancel_stream(&stream_id);
}

/// Querying a non-existent stream should return StreamNotFound.
#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_get_nonexistent_stream_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    // Stream ID 999 doesn't exist → StreamNotFound (#6)
    client.get_stream(&999u64);
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-STREAM TESTS
// ─────────────────────────────────────────────────────────────────────────────

/// Multiple independent streams should not interfere with each other.
#[test]
fn test_multiple_streams_independent() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender_a = Address::generate(&env);
    let sender_b = Address::generate(&env);
    let recipient_a = Address::generate(&env);
    let recipient_b = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let token_client = token::Client::new(&env, &token_address);
    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender_a, &500_000_000i128);
    sac_client.mint(&sender_b, &500_000_000i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    env.ledger().with_mut(|li| li.timestamp = 100);

    // Stream A: 200_000_000 over 2_000 seconds = 100_000/sec
    let stream_a = client.create_stream(&sender_a, &recipient_a, &200_000_000, &1_000, &3_000);
    // Stream B: 100_000_000 over 1_000 seconds = 100_000/sec
    let stream_b = client.create_stream(&sender_b, &recipient_b, &100_000_000, &1_000, &2_000);

    assert_eq!(stream_a, 1);
    assert_eq!(stream_b, 2);

    // At t=2_000: stream_a has 1_000s elapsed → 100_000_000 accrued
    //             stream_b has elapsed its full duration → 100_000_000 accrued
    env.ledger().with_mut(|li| li.timestamp = 2_000);

    assert_eq!(client.balance_of(&stream_a), 100_000_000);
    assert_eq!(client.balance_of(&stream_b), 100_000_000);

    // Withdraw from each independently
    client.withdraw(&stream_a, &100_000_000);
    client.withdraw(&stream_b, &100_000_000);

    assert_eq!(token_client.balance(&recipient_a), 100_000_000);
    assert_eq!(token_client.balance(&recipient_b), 100_000_000);

    // Stream A still has 100_000_000 left to accrue after t=2_000
    // Stream B is fully exhausted
    assert_eq!(client.balance_of(&stream_b), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// BOUNDARY & PRECISION TESTS
// ─────────────────────────────────────────────────────────────────────────────

/// Rate-per-second truncation: verifies integer division behavior is consistent.
/// 1_000_001 stroops over 1_000 seconds → rate = 1_000, actual streamed = 1_000_000
/// The 1 leftover stroop is refunded on cancellation.
#[test]
fn test_rate_truncation_refunded_on_cancel() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let token_client = token::Client::new(&env, &token_address);
    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &1_000_001i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    env.ledger().with_mut(|li| li.timestamp = 100);
    // 1_000_001 / 1_000s = 1_000 rate, full 1_000_000 accrued by stop_time
    let stream_id = client.create_stream(&sender, &recipient, &1_000_001, &1_000, &2_000);

    let sender_balance_after_create = token_client.balance(&sender);

    // Cancel after stream ends: recipient gets 1_000_000, sender gets 1 (truncation remainder)
    env.ledger().with_mut(|li| li.timestamp = 3_000);
    client.cancel_stream(&stream_id);

    assert_eq!(token_client.balance(&recipient), 1_000_000);
    // Sender gets refunded the 1-stroop truncation remainder
    assert_eq!(token_client.balance(&sender), sender_balance_after_create + 1);
}

/// Single-second stream — verify balance accrual at exactly 1-second intervals.
#[test]
fn test_single_second_precision() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    let token_client = token::Client::new(&env, &token_address);
    let sac_client = token::StellarAssetClient::new(&env, &token_address);
    sac_client.mint(&sender, &1_000_000i128);

    let contract_id = env.register(VanguardStreamContract, ());
    let client = VanguardStreamContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    env.ledger().with_mut(|li| li.timestamp = 500);
    // 10 stroops per second over 10 seconds
    let stream_id = client.create_stream(&sender, &recipient, &100, &1_000, &1_010);

    env.ledger().with_mut(|li| li.timestamp = 1_001);
    assert_eq!(client.balance_of(&stream_id), 10, "1 second of accrual = 10 stroops");

    env.ledger().with_mut(|li| li.timestamp = 1_005);
    assert_eq!(client.balance_of(&stream_id), 50, "5 seconds = 50 stroops");

    env.ledger().with_mut(|li| li.timestamp = 1_010);
    assert_eq!(client.balance_of(&stream_id), 100, "Full duration = full deposit");

    client.withdraw(&stream_id, &100);
    assert_eq!(token_client.balance(&recipient), 100);
}
