//! Contract events. Topics are chosen for off-chain indexers.

use soroban_sdk::{contractevent, Address, BytesN};

/// A meter was registered.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MeterAdded {
    #[topic]
    pub meter_id: u64,
    pub owner: Address,
    pub signer: BytesN<32>,
}

/// A signed meter reading was accepted.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reading {
    #[topic]
    pub meter_id: u64,
    pub timestamp: u64,
    pub generation_wh: u64,
    pub consumption_wh: u64,
    pub nonce: u64,
}

/// A single atomic payment leg executed during settlement.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payment {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

/// A settlement window was closed.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settled {
    pub traded_wh: i128,
    pub producers: u32,
    pub consumers: u32,
    pub paid_out: i128,
    pub fee: i128,
}
