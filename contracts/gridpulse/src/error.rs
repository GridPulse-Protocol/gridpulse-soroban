//! Contract error type.

use soroban_sdk::contracterror;

/// Errors returned by GridPulse functions.
///
/// Note: an invalid meter signature is *not* represented here. `Env::crypto`
/// `ed25519_verify` is a host function that reverts the invocation on a bad
/// signature, so a forged reading fails atomically before any state changes.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// The contract has not been initialized.
    NotInitialized = 1,
    /// The contract has already been initialized.
    AlreadyInitialized = 2,
    /// The referenced meter does not exist.
    MeterNotFound = 3,
    /// The referenced meter is inactive.
    MeterInactive = 4,
    /// Reading nonce is not greater than the stored nonce (replay).
    StaleNonce = 5,
    /// Reading timestamp is older than the stored timestamp.
    StaleTimestamp = 6,
    /// Generation/consumption values are invalid.
    BadReading = 7,
    /// An arithmetic operation overflowed.
    Overflow = 8,
    /// There is no surplus or deficit to settle.
    NothingToSettle = 9,
    /// Operator fee basis points exceed 10000.
    BadFee = 10,
}
