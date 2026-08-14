//! On-chain data types (SCVal-encoded) shared across the contract.
//!
//! `#[contracttype]` requires type, variant, and field names of at most 10
//! characters, which is why a few names here are abbreviated.

use soroban_sdk::{contracttype, Address, BytesN};

/// Storage keys, namespaced by storage class.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Instance: grid configuration (`Config`).
    Config,
    /// Instance: next meter id to assign (`u64`).
    NextId,
    /// Persistent: a registered meter (`Meter`).
    Meter(u64),
    /// Temporary: net watt-hours accrued this settlement window (`i128`).
    Net(u64),
}

/// Grid configuration held in instance storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// Grid operator. Receives the settlement fee.
    pub admin: Address,
    /// SEP-41 settlement token (e.g. USDC via its Stellar Asset Contract).
    pub token: Address,
    /// Clearing price in token base units per kWh (1000 Wh).
    pub price: u64,
    /// Operator fee in basis points (1/10000), charged on consumer payments.
    pub fee_bps: u32,
}

/// A registered IoT smart meter.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Meter {
    /// Numeric meter id.
    pub id: u64,
    /// Account that receives payments / owes for consumption.
    pub owner: Address,
    /// Ed25519 public key of the physical meter device.
    pub signer: BytesN<32>,
    /// Whether the meter may submit readings.
    pub active: bool,
    /// Highest nonce accepted so far (replay protection).
    pub nonce: u64,
    /// Most recent reading timestamp (monotonicity check).
    pub last_ts: u64,
}

/// Result summary returned by `settle`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Report {
    /// Watt-hours actually wheeled (min of total surplus and deficit).
    pub traded_wh: i128,
    /// Number of producers paid.
    pub producers: u32,
    /// Number of consumers charged.
    pub consumers: u32,
    /// Total token base units paid to producers (net of fee).
    pub paid_out: i128,
    /// Total token base units collected as the operator fee.
    pub fee: i128,
}
