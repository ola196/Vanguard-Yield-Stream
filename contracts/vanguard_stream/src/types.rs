use soroban_sdk::{contracttype, Address};

/// Storage key enumeration for all contract state entries.
/// Used to namespace data in Soroban's key-value persistent and instance storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Address of the contract administrator (set once on initialize)
    Admin,
    /// Address of the Stellar Asset Contract (SAC) token used for streaming
    Token,
    /// Per-stream state, keyed by stream ID
    Stream(u64),
    /// Auto-incrementing stream ID counter
    NextStreamId,
    /// Global circuit-breaker flag — halts all state-mutating operations when true
    Paused,
}

/// Represents a single active or historical payment stream.
/// Stored in persistent storage with automatic TTL renewal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stream {
    /// Unique numeric stream identifier
    pub id: u64,
    /// Address of the party funding the stream
    pub sender: Address,
    /// Address of the party receiving streamed tokens
    pub recipient: Address,
    /// Total tokens locked into escrow at stream creation (in stroops)
    pub deposit_amount: i128,
    /// Cumulative tokens already withdrawn by the recipient
    pub withdrawn_amount: i128,
    /// Unix timestamp when streaming begins
    pub start_time: u64,
    /// Unix timestamp when streaming ends
    pub stop_time: u64,
    /// Tokens accrued per second: deposit_amount / (stop_time - start_time)
    pub rate_per_second: i128,
    /// True if the sender cancelled the stream before stop_time
    pub is_cancelled: bool,
}
