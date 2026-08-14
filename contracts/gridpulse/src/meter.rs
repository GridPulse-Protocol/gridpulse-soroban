//! Meter reading submission and signature verification.

use soroban_sdk::{Bytes, BytesN, Env};

use crate::error::Error;
use crate::events::Reading;
use crate::storage;

/// Size of the canonical reading payload: five big-endian `u64` fields.
pub const PAYLOAD_LEN: usize = 40;

/// Build the canonical 40-byte payload that a meter signs.
///
/// Layout (all fields big-endian `u64`):
/// `meter_id || timestamp || generation_wh || consumption_wh || nonce`.
///
/// The device firmware and any off-chain relay MUST sign exactly these bytes
/// with Ed25519 (no domain-separating prefix) for a reading to be accepted.
pub fn reading_payload(
    meter_id: u64,
    timestamp: u64,
    generation_wh: u64,
    consumption_wh: u64,
    nonce: u64,
) -> [u8; PAYLOAD_LEN] {
    let mut buf = [0u8; PAYLOAD_LEN];
    buf[0..8].copy_from_slice(&meter_id.to_be_bytes());
    buf[8..16].copy_from_slice(&timestamp.to_be_bytes());
    buf[16..24].copy_from_slice(&generation_wh.to_be_bytes());
    buf[24..32].copy_from_slice(&consumption_wh.to_be_bytes());
    buf[32..40].copy_from_slice(&nonce.to_be_bytes());
    buf
}

/// Submit a signed meter reading, accumulating the net position for the
/// current settlement window.
///
/// A bad signature reverts the invocation via the host's `ed25519_verify`,
/// so no partial state is observable.
#[allow(clippy::too_many_arguments)]
pub fn submit(
    env: &Env,
    meter_id: u64,
    timestamp: u64,
    generation_wh: u64,
    consumption_wh: u64,
    nonce: u64,
    signature: &BytesN<64>,
) -> Result<(), Error> {
    let mut meter = storage::read_meter(env, meter_id).ok_or(Error::MeterNotFound)?;

    if !meter.active {
        return Err(Error::MeterInactive);
    }
    if nonce <= meter.nonce {
        return Err(Error::StaleNonce);
    }
    if timestamp < meter.last_ts {
        return Err(Error::StaleTimestamp);
    }

    // Verify the device signature over the canonical payload. Panics (and
    // reverts) if the signature is invalid.
    let payload = reading_payload(meter_id, timestamp, generation_wh, consumption_wh, nonce);
    let message = Bytes::from_array(env, &payload);
    env.crypto()
        .ed25519_verify(&meter.signer, &message, signature);

    // Net watt-hours for this reading: generation minus consumption.
    let delta = (generation_wh as i128) - (consumption_wh as i128);
    let net = storage::read_net(env, meter_id);
    let updated = net.checked_add(delta).ok_or(Error::Overflow)?;
    storage::write_net(env, meter_id, updated);

    // Advance replay protection and monotonicity state.
    meter.nonce = nonce;
    meter.last_ts = timestamp;
    storage::write_meter(env, &meter);

    Reading {
        meter_id,
        timestamp,
        generation_wh,
        consumption_wh,
        nonce,
    }
    .publish(env);

    Ok(())
}
