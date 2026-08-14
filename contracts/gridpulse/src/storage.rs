//! Storage access helpers. Centralizes key layout and TTL management.
//!
//! Layout:
//! - Instance: `Config`, `NextId` (small, always-hot config).
//! - Persistent: `Meter(u64)` (long-lived registrations).
//! - Temporary: `Net(u64)` (ephemeral per-window energy positions).

use soroban_sdk::Env;

use crate::types::{Config, DataKey, Meter};

/// Bump a persistent entry's TTL only if it drops below this many ledgers.
const TTL_THRESHOLD: u32 = 26_000; // ~36 hours at 5s ledgers

/// Read the grid configuration.
pub fn read_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .expect("GridPulse: not initialized")
}

/// Write the grid configuration.
pub fn write_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
}

/// Allocate and return the next meter id.
pub fn next_meter_id(env: &Env) -> u64 {
    let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
    env.storage().instance().set(&DataKey::NextId, &(id + 1));
    id
}

/// Read a meter registration, if any.
pub fn read_meter(env: &Env, meter_id: u64) -> Option<Meter> {
    env.storage().persistent().get(&DataKey::Meter(meter_id))
}

/// Write a meter registration and refresh its TTL.
pub fn write_meter(env: &Env, meter: &Meter) {
    let key = DataKey::Meter(meter.id);
    env.storage().persistent().set(&key, meter);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, env.storage().max_ttl());
}

/// Read a meter's accumulated net watt-hours for the current window.
pub fn read_net(env: &Env, meter_id: u64) -> i128 {
    env.storage()
        .temporary()
        .get(&DataKey::Net(meter_id))
        .unwrap_or(0)
}

/// Write a meter's accumulated net watt-hours for the current window.
pub fn write_net(env: &Env, meter_id: u64, net: i128) {
    env.storage().temporary().set(&DataKey::Net(meter_id), &net);
}

/// Remove a meter's net position after settlement.
pub fn clear_net(env: &Env, meter_id: u64) {
    env.storage().temporary().remove(&DataKey::Net(meter_id));
}
