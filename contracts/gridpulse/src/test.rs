#![cfg(test)]

extern crate std;

use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, BytesN, Env};

use crate::contract::{GridPulse, GridPulseClient};
use crate::error::Error;
use crate::meter::reading_payload;
use crate::types::Report;

/// Clearing price in token base units per kWh (1 token / kWh, 6 decimals).
const PRICE: u64 = 1_000_000;

// ---------------------------------------------------------------------------
// Mock SEP-41 token (test-only, lives in this module)
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum TKey {
    Admin,
    Bal(Address),
    Allow(AllowKey),
}

#[contracttype]
#[derive(Clone)]
struct AllowKey {
    owner: Address,
    spender: Address,
}

#[contracttype]
#[derive(Clone)]
struct Allow {
    amount: i128,
    until: u32,
}

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    /// Test-only initializer. Named `init` (not `__constructor`) so its export
    /// does not collide with the GridPulse constructor in this crate.
    pub fn init(env: Env, admin: Address) {
        env.storage().instance().set(&TKey::Admin, &admin);
    }

    /// Test helper: mint tokens to `to`. Admin only.
    pub fn mint(env: Env, to: Address, amount: i128) {
        let admin: Address = env.storage().instance().get(&TKey::Admin).unwrap();
        admin.require_auth();
        let key = TKey::Bal(to.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(bal + amount));
    }

    pub fn approve(env: Env, owner: Address, spender: Address, amount: i128, until: u32) {
        owner.require_auth();
        let key = TKey::Allow(AllowKey {
            owner: owner.clone(),
            spender: spender.clone(),
        });
        env.storage()
            .persistent()
            .set(&key, &Allow { amount, until });
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();

        let akey = TKey::Allow(AllowKey {
            owner: from.clone(),
            spender: spender.clone(),
        });
        let allow: Allow = env
            .storage()
            .persistent()
            .get(&akey)
            .unwrap_or(Allow { amount: 0, until: 0 });
        if allow.amount < amount {
            panic!("MockToken: insufficient allowance");
        }
        env.storage().persistent().set(
            &akey,
            &Allow {
                amount: allow.amount - amount,
                until: allow.until,
            },
        );

        let fkey = TKey::Bal(from.clone());
        let fbal: i128 = env.storage().persistent().get(&fkey).unwrap_or(0);
        if fbal < amount {
            panic!("MockToken: insufficient balance");
        }
        env.storage().persistent().set(&fkey, &(fbal - amount));

        let tkey = TKey::Bal(to.clone());
        let tbal: i128 = env.storage().persistent().get(&tkey).unwrap_or(0);
        env.storage().persistent().set(&tkey, &(tbal + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().persistent().get(&TKey::Bal(id)).unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// Fixture + helpers
// ---------------------------------------------------------------------------

struct Fixture {
    env: Env,
    admin: Address,
    token_id: Address,
    gp_id: Address,
    token: MockTokenClient,
    gp: GridPulseClient,
}

fn fixture(price: u64, fee_bps: u32) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(MockToken, ());
    let token = MockTokenClient::new(&env, &token_id);
    token.init(&admin);

    let gp_id = env.register(GridPulse, (&admin, &token_id, price, fee_bps));
    let gp = GridPulseClient::new(&env, &gp_id);

    Fixture {
        env,
        admin,
        token_id,
        gp_id,
        token,
        gp,
    }
}

/// Derive a deterministic Ed25519 signing key from a seed byte.
fn signer(seed: u8) -> SigningKey {
    let mut bytes = [0u8; 32];
    bytes[0] = seed;
    bytes[1] = 0x42;
    SigningKey::from_bytes(&bytes)
}

/// Register a meter and return `(meter_id, signing_key)`.
fn register_meter(fx: &Fixture, owner: &Address, seed: u8) -> (u64, SigningKey) {
    let sk = signer(seed);
    let pk: BytesN<32> = BytesN::from_array(&fx.env, &sk.verifying_key().to_bytes());
    let id = fx.gp.register_meter(owner, &pk).unwrap();
    (id, sk)
}

/// Submit a correctly-signed reading.
fn submit(
    fx: &Fixture,
    sk: &SigningKey,
    meter_id: u64,
    ts: u64,
    gen: u64,
    cons: u64,
    nonce: u64,
) {
    let payload = reading_payload(meter_id, ts, gen, cons, nonce);
    let sig: BytesN<64> = BytesN::from_array(&fx.env, &sk.sign(&payload).to_bytes());
    fx.gp
        .submit_reading(&meter_id, &ts, &gen, &cons, &nonce, &sig)
        .unwrap();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn test_register_and_view_meter() {
    let fx = fixture(PRICE, 0);
    let owner = Address::generate(&fx.env);

    let sk = signer(7);
    let pk: BytesN<32> = BytesN::from_array(&fx.env, &sk.verifying_key().to_bytes());
    let id = fx.gp.register_meter(&owner, &pk).unwrap();
    assert_eq!(id, 1);

    let meter = fx.gp.meter(&id).unwrap();
    assert_eq!(meter.id, 1);
    assert_eq!(meter.owner, owner);
    assert_eq!(meter.signer, pk);
    assert!(meter.active);
    assert_eq!(meter.nonce, 0);
    assert_eq!(meter.last_ts, 0);

    let cfg = fx.gp.config();
    assert_eq!(cfg.admin, fx.admin);
    assert_eq!(cfg.token, fx.token_id);
    assert_eq!(cfg.price, PRICE);
    assert_eq!(cfg.fee_bps, 0);
}

#[test]
fn test_balanced_settlement() {
    // 8 kWh surplus == 8 kWh deficit, 1% operator fee, price 1 token/kWh.
    let fx = fixture(PRICE, 100);

    let p1 = Address::generate(&fx.env);
    let p2 = Address::generate(&fx.env);
    let c1 = Address::generate(&fx.env);
    let c2 = Address::generate(&fx.env);

    let (m1, sk1) = register_meter(&fx, &p1, 1);
    let (m2, sk2) = register_meter(&fx, &p2, 2);
    let (m3, sk3) = register_meter(&fx, &c1, 3);
    let (m4, sk4) = register_meter(&fx, &c2, 4);

    submit(&fx, &sk1, m1, 100, 10_000, 5_000, 1); // +5000 Wh
    submit(&fx, &sk2, m2, 100, 8_000, 5_000, 1); // +3000 Wh
    submit(&fx, &sk3, m3, 100, 1_000, 6_000, 1); // -5000 Wh
    submit(&fx, &sk4, m4, 100, 0, 3_000, 1); // -3000 Wh

    assert_eq!(fx.gp.net_position(&m1), 5_000);
    assert_eq!(fx.gp.net_position(&m3), -5_000);

    // Consumers fund + approve the contract as spender.
    fx.token.mint(&c1, &5_000_000i128);
    fx.token.mint(&c2, &3_000_000i128);
    fx.token
        .approve(&c1, &fx.gp_id, &5_000_000i128, &100_000u32);
    fx.token
        .approve(&c2, &fx.gp_id, &3_000_000i128, &100_000u32);

    let ids = vec![&fx.env, m1, m2, m3, m4];
    let report = fx.gp.settle(&ids).unwrap();

    // 8000 Wh wheeled. Gross = 8_000_000. Fee 1% = 80_000. Pool = 7_920_000.
    assert_eq!(
        report,
        Report {
            traded_wh: 8_000,
            producers: 2,
            consumers: 2,
            paid_out: 7_920_000,
            fee: 80_000,
        }
    );

    assert_eq!(fx.token.balance(&p1), 4_950_000);
    assert_eq!(fx.token.balance(&p2), 2_970_000);
    assert_eq!(fx.token.balance(&fx.admin), 80_000);
    assert_eq!(fx.token.balance(&c1), 0);
    assert_eq!(fx.token.balance(&c2), 0);

    // Net positions reset for the next window.
    assert_eq!(fx.gp.net_position(&m1), 0);
    assert_eq!(fx.gp.net_position(&m3), 0);
}

#[test]
fn test_settlement_with_surplus_excess() {
    // Producers export more than consumers import; producers are curtailed
    // pro-rata so the market still clears. No fee for clarity.
    let fx = fixture(PRICE, 0);

    let p1 = Address::generate(&fx.env);
    let p2 = Address::generate(&fx.env);
    let c1 = Address::generate(&fx.env);

    let (m1, sk1) = register_meter(&fx, &p1, 1);
    let (m2, sk2) = register_meter(&fx, &p2, 2);
    let (m3, sk3) = register_meter(&fx, &c1, 3);

    submit(&fx, &sk1, m1, 100, 9_000, 3_000, 1); // +6000 Wh
    submit(&fx, &sk2, m2, 100, 7_000, 3_000, 1); // +4000 Wh
    submit(&fx, &sk3, m3, 100, 1_000, 5_000, 1); // -4000 Wh

    fx.token.mint(&c1, &4_000_000i128);
    fx.token
        .approve(&c1, &fx.gp_id, &4_000_000i128, &100_000u32);

    let ids = vec![&fx.env, m1, m2, m3];
    let report = fx.gp.settle(&ids).unwrap();

    // Only 4000 Wh wheeled. c1 pays 4_000_000. p1 gets 2400/4000, p2 1600/4000.
    assert_eq!(
        report,
        Report {
            traded_wh: 4_000,
            producers: 2,
            consumers: 1,
            paid_out: 4_000_000,
            fee: 0,
        }
    );

    assert_eq!(fx.token.balance(&p1), 2_400_000);
    assert_eq!(fx.token.balance(&p2), 1_600_000);
    assert_eq!(fx.token.balance(&c1), 0);
    assert_eq!(fx.token.balance(&fx.admin), 0);
}

#[test]
fn test_replay_rejected() {
    let fx = fixture(PRICE, 0);
    let owner = Address::generate(&fx.env);
    let (id, sk) = register_meter(&fx, &owner, 9);

    submit(&fx, &sk, id, 100, 500, 100, 1);

    // Replaying the same nonce must fail with StaleNonce.
    let payload = reading_payload(id, 100, 500, 100, 1);
    let sig: BytesN<64> = BytesN::from_array(&fx.env, &sk.sign(&payload).to_bytes());
    let res = fx
        .gp
        .try_submit_reading(&id, &100u64, &500u64, &100u64, &1u64, &sig);
    assert!(matches!(res, Err(Ok(Error::StaleNonce))));
}

#[test]
fn test_bad_signature_rejected() {
    let fx = fixture(PRICE, 0);
    let owner = Address::generate(&fx.env);
    let (id, _sk) = register_meter(&fx, &owner, 9);

    // Forged (all-zero) signature: the host `ed25519_verify` reverts the call.
    let sig: BytesN<64> = BytesN::from_array(&fx.env, &[0u8; 64]);
    let res = fx
        .gp
        .try_submit_reading(&id, &100u64, &500u64, &100u64, &1u64, &sig);
    assert!(matches!(res, Err(Err(_))));

    // State must be untouched.
    assert_eq!(fx.gp.net_position(&id), 0);
}
