//! Settlement: converts accumulated net energy positions into an atomic
//! peer-to-peer USDC payment swap.
//!
//! ## Model
//!
//! A meter with a positive net (generation > consumption) is a *producer*
//! exporting surplus; a negative net is a *consumer* importing deficit. The
//! wheeled energy is the smaller of total surplus and total deficit, so the
//! market always clears.
//!
//! Money is computed in token base units (1 USDC = `10^decimals` base units):
//!
//! * consumer pays `matched_wh * price / 1000` (`price` is per kWh);
//! * the operator fee is `fee_bps` of consumer payments;
//! * producers split the remainder pro-rata to their matched surplus.
//!
//! Payments execute as `transfer_from(contract, consumer, producer, amount)`
//! — the contract spends each consumer's pre-approved allowance and moves
//! USDC straight to producers in a single atomic invocation. The operator fee
//! is whatever consumer obligation remains after producers are paid, which
//! keeps `total_paid == total_producer_net + fee` exactly.

use soroban_sdk::{token::TokenClient, Address, Env, Vec};

use crate::error::Error;
use crate::events::{Payment, Settled};
use crate::storage;
use crate::types::{Config, Report};

const BPS: i128 = 10_000;

/// Settle the meters in `meter_ids` and return a report.
pub fn run(env: &Env, config: &Config, meter_ids: Vec<u64>) -> Result<Report, Error> {
    // ---- 1. Classify net positions ---------------------------------------
    let mut prod_owners: Vec<Address> = Vec::new(env);
    let mut prod_wh: Vec<i128> = Vec::new(env);
    let mut cons_owners: Vec<Address> = Vec::new(env);
    let mut cons_wh: Vec<i128> = Vec::new(env);

    let mut total_surplus: i128 = 0;
    let mut total_deficit: i128 = 0;

    for meter_id in meter_ids.iter() {
        let meter = storage::read_meter(env, meter_id).ok_or(Error::MeterNotFound)?;
        let net = storage::read_net(env, meter_id);
        if net > 0 {
            total_surplus += net;
            prod_owners.push_back(meter.owner);
            prod_wh.push_back(net);
        } else if net < 0 {
            let deficit = -net;
            total_deficit += deficit;
            cons_owners.push_back(meter.owner);
            cons_wh.push_back(deficit);
        }
    }

    if prod_owners.is_empty() || cons_owners.is_empty() {
        return Err(Error::NothingToSettle);
    }

    let traded_wh = if total_surplus < total_deficit {
        total_surplus
    } else {
        total_deficit
    };
    let price = config.price as i128;

    // ---- 2. Compute money -------------------------------------------------
    // Consumer obligations (gross, before fee).
    let mut total_paid: i128 = 0;
    let mut cons_pay: Vec<i128> = Vec::new(env);
    for wh in cons_wh.iter() {
        let matched = wh * traded_wh / total_deficit;
        let pay = matched * price / 1000;
        cons_pay.push_back(pay);
        total_paid += pay;
    }

    // Operator fee + rounding remainder are removed from the pool first.
    let base_fee = total_paid * (config.fee_bps as i128) / BPS;
    let producer_pool = total_paid - base_fee;

    // Producer matched surplus total (drives pro-rata allocation).
    let mut matched_total: i128 = 0;
    for wh in prod_wh.iter() {
        matched_total += wh * traded_wh / total_surplus;
    }

    // Producer net payouts, pro-rata to matched surplus.
    let mut total_net: i128 = 0;
    let mut prod_net: Vec<i128> = Vec::new(env);
    for wh in prod_wh.iter() {
        let matched = wh * traded_wh / total_surplus;
        let net = if matched_total > 0 {
            producer_pool * matched / matched_total
        } else {
            0
        };
        prod_net.push_back(net);
        total_net += net;
    }

    // Absorb any producer-allocation rounding into the operator fee so the
    // books stay exactly balanced: `total_paid == total_net + fee`.
    let fee = total_paid - total_net;

    // ---- 3. Execute the atomic swap --------------------------------------
    let token = TokenClient::new(env, &config.token);
    let spender = env.current_contract_address();

    let mut ci: u32 = 0;
    let mut pi: u32 = 0;
    let mut pay_left = cons_pay.get(0).unwrap();
    let mut net_left = prod_net.get(0).unwrap();

    while ci < cons_pay.len() && pi < prod_net.len() {
        let amount = if pay_left < net_left {
            pay_left
        } else {
            net_left
        };
        if amount > 0 {
            let from = cons_owners.get(ci).unwrap();
            let to = prod_owners.get(pi).unwrap();
            token.transfer_from(&spender, &from, &to, &amount);
            Payment {
                from: from.clone(),
                to: to.clone(),
                amount,
            }
            .publish(env);
            pay_left -= amount;
            net_left -= amount;
        }
        if pay_left == 0 {
            ci += 1;
            if ci < cons_pay.len() {
                pay_left = cons_pay.get(ci).unwrap();
            }
        }
        if net_left == 0 {
            pi += 1;
            if pi < prod_net.len() {
                net_left = prod_net.get(pi).unwrap();
            }
        }
    }

    // Any remaining consumer obligation is the operator fee -> admin.
    if ci < cons_pay.len() && pay_left > 0 {
        let from = cons_owners.get(ci).unwrap();
        token.transfer_from(&spender, &from, &config.admin, &pay_left);
        Payment {
            from: from.clone(),
            to: config.admin.clone(),
            amount: pay_left,
        }
        .publish(env);
        ci += 1;
    }
    while ci < cons_pay.len() {
        let pay = cons_pay.get(ci).unwrap();
        if pay > 0 {
            let from = cons_owners.get(ci).unwrap();
            token.transfer_from(&spender, &from, &config.admin, &pay);
            Payment {
                from: from.clone(),
                to: config.admin.clone(),
                amount: pay,
            }
            .publish(env);
        }
        ci += 1;
    }

    // ---- 4. Reset positions for the next window --------------------------
    for meter_id in meter_ids.iter() {
        storage::clear_net(env, meter_id);
    }

    let report = Report {
        traded_wh,
        producers: prod_owners.len(),
        consumers: cons_owners.len(),
        paid_out: total_net,
        fee,
    };

    Settled {
        traded_wh,
        producers: report.producers,
        consumers: report.consumers,
        paid_out: total_net,
        fee,
    }
    .publish(env);

    Ok(report)
}
