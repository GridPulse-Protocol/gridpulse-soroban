//! # GridPulse
//!
//! A Decentralized Physical Infrastructure Network (DePIN) contract for
//! residential solar microgrids on Stellar. IoT smart meters sign on-chain
//! generation/consumption updates; when a home produces surplus solar the
//! contract atomically settles a peer-to-peer USDC payment swap with
//! neighboring homes drawing power — no centralized utility database.
//!
//! See the repository README for the architecture, the canonical signature
//! payload layout, and deploy instructions.

#![no_std]

mod contract;
mod error;
mod events;
mod meter;
mod settle;
mod storage;
mod types;

#[cfg(test)]
mod test;

pub use contract::{GridPulse, GridPulseClient};
pub use error::Error;
pub use types::{Config, Meter, Report};
