//! Public contract interface. Admin-gated functions use `require_auth`, which
//! the Soroban host enforces with signatures — a non-admin caller reverts
//! before any state is touched.

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Vec};

use crate::error::Error;
use crate::events::MeterAdded;
use crate::types::{Config, Meter, Report};
use crate::{meter, settle, storage};

#[contract]
pub struct GridPulse;

#[contractimpl]
impl GridPulse {
    /// Initialize the grid. Called once at deploy via `env.register`.
    ///
    /// * `admin`  — grid operator (receives the settlement fee).
    /// * `token`  — SEP-41 settlement token (USDC SAC address).
    /// * `price`  — clearing price in token base units per kWh.
    /// * `fee_bps`— operator fee in basis points (max 10000).
    pub fn __constructor(env: Env, admin: Address, token: Address, price: u64, fee_bps: u32) {
        if fee_bps > 10_000 {
            panic!("GridPulse: fee_bps must be <= 10000");
        }
        storage::write_config(
            &env,
            &Config {
                admin,
                token,
                price,
                fee_bps,
            },
        );
    }

    /// Register a meter owned by `owner` and signed by the device key `signer`.
    /// Admin only. Returns the new meter id.
    pub fn register_meter(env: Env, owner: Address, signer: BytesN<32>) -> Result<u64, Error> {
        let config = storage::read_config(&env);
        config.admin.require_auth();

        let id = storage::next_meter_id(&env);
        let meter = Meter {
            id,
            owner: owner.clone(),
            signer: signer.clone(),
            active: true,
            nonce: 0,
            last_ts: 0,
        };
        storage::write_meter(&env, &meter);

        MeterAdded {
            meter_id: id,
            owner,
            signer,
        }
        .publish(&env);

        Ok(id)
    }

    /// Activate or deactivate a meter. Admin only.
    pub fn set_meter_active(env: Env, meter_id: u64, active: bool) -> Result<(), Error> {
        let config = storage::read_config(&env);
        config.admin.require_auth();

        let mut meter = storage::read_meter(&env, meter_id).ok_or(Error::MeterNotFound)?;
        meter.active = active;
        storage::write_meter(&env, &meter);
        Ok(())
    }

    /// Reassign a meter to a new owner account. Admin only.
    pub fn update_meter_owner(env: Env, meter_id: u64, owner: Address) -> Result<(), Error> {
        let config = storage::read_config(&env);
        config.admin.require_auth();

        let mut meter = storage::read_meter(&env, meter_id).ok_or(Error::MeterNotFound)?;
        meter.owner = owner;
        storage::write_meter(&env, &meter);
        Ok(())
    }

    /// Update the clearing price (token base units per kWh). Admin only.
    pub fn set_price(env: Env, price: u64) -> Result<(), Error> {
        let mut config = storage::read_config(&env);
        config.admin.require_auth();
        config.price = price;
        storage::write_config(&env, &config);
        Ok(())
    }

    /// Update the operator fee (basis points, max 10000). Admin only.
    pub fn set_fee_bps(env: Env, fee_bps: u32) -> Result<(), Error> {
        if fee_bps > 10_000 {
            return Err(Error::BadFee);
        }
        let mut config = storage::read_config(&env);
        config.admin.require_auth();
        config.fee_bps = fee_bps;
        storage::write_config(&env, &config);
        Ok(())
    }

    /// Submit a signed meter reading for the current settlement window.
    #[allow(clippy::too_many_arguments)]
    pub fn submit_reading(
        env: Env,
        meter_id: u64,
        timestamp: u64,
        generation_wh: u64,
        consumption_wh: u64,
        nonce: u64,
        signature: BytesN<64>,
    ) -> Result<(), Error> {
        meter::submit(
            &env,
            meter_id,
            timestamp,
            generation_wh,
            consumption_wh,
            nonce,
            &signature,
        )
    }

    /// Atomically settle the given meters: wheel energy, swap USDC from
    /// consumers to producers, and collect the operator fee.
    pub fn settle(env: Env, meter_ids: Vec<u64>) -> Result<Report, Error> {
        let config = storage::read_config(&env);
        settle::run(&env, &config, meter_ids)
    }

    // ---- Views -----------------------------------------------------------

    /// Current grid configuration.
    pub fn config(env: Env) -> Config {
        storage::read_config(&env)
    }

    /// A registered meter, if any.
    pub fn meter(env: Env, meter_id: u64) -> Result<Meter, Error> {
        storage::read_meter(&env, meter_id).ok_or(Error::MeterNotFound)
    }

    /// A meter's accumulated net watt-hours for the current window.
    pub fn net_position(env: Env, meter_id: u64) -> i128 {
        storage::read_net(&env, meter_id)
    }
}
