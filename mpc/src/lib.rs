//! MeshPort MPC: 2-of-3 threshold ECDSA (DKLs23) for the wallet, as a
//! stateless WebAssembly module shared by the wallet frame (browser) and the
//! MeshPort signing service (api/wallet-mpc.ts, Node).
//!
//! Parties: 1 = phone (wallet frame), 2 = MeshPort server, 3 = backup.
//! Any two sign together; the private key is never assembled - not at key
//! generation, not when signing.
//!
//! Every protocol phase is one JSON-in / JSON-out call. A party's secret
//! working state between phases is returned to the caller (`state`), so the
//! server needs no memory between HTTP requests - it seals that state itself.
//! Messages for other parties come back in lists; each carries its receiver.
//!
//! ABI (no wasm-bindgen): `mpc_alloc` / `mpc_free` for buffers and
//! `mpc_call(op, input) -> (ptr << 32) | len` of a JSON reply that is either
//! `{"ok": ...}` or `{"error": "..."}`. Randomness comes from WASI
//! `random_get` (crypto.getRandomValues on the JS side).

use std::collections::BTreeMap;

use dkls23::protocols::dkg::{
    self, BroadcastDerivationPhase2to4, BroadcastDerivationPhase3to4, KeepInitMulPhase3to4,
    KeepInitZeroSharePhase2to3, KeepInitZeroSharePhase3to4, ProofCommitment, SessionData,
    TransmitInitMulPhase3to4, TransmitInitZeroSharePhase2to4, TransmitInitZeroSharePhase3to4,
    UniqueKeepDerivationPhase2to3,
};
use dkls23::protocols::signing::{
    Broadcast3to4, KeepPhase1to2, KeepPhase2to3, SignData, TransmitPhase1to2, TransmitPhase2to3,
    UniqueKeep1to2, UniqueKeep2to3,
};
use dkls23::protocols::{Parameters, Party, PartyIndex};
use k256::{Scalar, Secp256k1 as C};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

type R<T> = Result<T, String>;

const THRESHOLD: u8 = 2;
const SHARE_COUNT: u8 = 3;

fn party_index(i: u8) -> R<PartyIndex> {
    if !(1..=SHARE_COUNT).contains(&i) {
        return Err(format!("party index {i} out of range"));
    }
    PartyIndex::new(i).map_err(|_| format!("invalid party index {i}"))
}

fn session(i: u8, sid_hex: &str) -> R<SessionData> {
    let session_id = hex::decode(sid_hex.trim_start_matches("0x")).map_err(|e| format!("session id: {e}"))?;
    if session_id.len() < 16 {
        return Err("session id must be at least 16 bytes".into());
    }
    Ok(SessionData {
        parameters: Parameters { threshold: THRESHOLD, share_count: SHARE_COUNT },
        party_index: party_index(i)?,
        session_id,
    })
}

fn hash32(hex_str: &str) -> R<[u8; 32]> {
    let v = hex::decode(hex_str.trim_start_matches("0x")).map_err(|e| format!("hash: {e}"))?;
    v.try_into().map_err(|_| "hash must be 32 bytes".to_string())
}

// Parsed straight from the text - not via serde_json::Value and never with
// #[serde(flatten)]: maps keyed by party index arrive with string keys ("2"),
// which only the direct text parser turns back into numbers.
fn from<T: for<'de> Deserialize<'de>>(input: &str, what: &str) -> R<T> {
    serde_json::from_str(input).map_err(|e| format!("{what}: {e}"))
}

fn map<T>(pairs: Vec<(u8, T)>) -> R<BTreeMap<PartyIndex, T>> {
    pairs.into_iter().map(|(i, v)| Ok((party_index(i)?, v))).collect()
}

fn address(party: &Party<C>) -> String {
    dkls23::secp256k1::compute_eth_address(&party.pk).to_lowercase()
}

// ── Key generation ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct DkgIn {
    i: u8,
    sid: String,
}

#[derive(Serialize, Deserialize)]
struct Dkg2State {
    poly_point: Scalar,
    zero_keep: BTreeMap<PartyIndex, KeepInitZeroSharePhase2to3>,
    bip_keep: UniqueKeepDerivationPhase2to3,
}

#[derive(Serialize, Deserialize)]
struct Dkg3State {
    poly_point: Scalar,
    zero_keep: BTreeMap<PartyIndex, KeepInitZeroSharePhase3to4>,
    mul_keep: BTreeMap<PartyIndex, KeepInitMulPhase3to4<C>>,
}

/// Phase 1: this party's polynomial evaluated for every party.
/// `fragments[j]` is for party j+1 (including itself) - send it privately.
fn dkg1(input: &str) -> R<Value> {
    let a: DkgIn = from(input, "dkg1")?;
    let data = session(a.i, &a.sid)?;
    Ok(json!({ "fragments": dkg::phase1::<C>(&data) }))
}

/// Phase 2: `fragments` = what each party 1..=3 sent to this party, in order.
fn dkg2(input: &str) -> R<Value> {
    #[derive(Deserialize)]
    struct In {
        i: u8,
        sid: String,
        fragments: Vec<Scalar>,
    }
    let a: In = from(input, "dkg2")?;
    if a.fragments.len() != usize::from(SHARE_COUNT) {
        return Err("need one fragment from every party".into());
    }
    let data = session(a.i, &a.sid)?;
    let (poly_point, proof, zero_keep, zero_transmit, bip_keep, bip) = dkg::phase2::<C>(&data, &a.fragments);
    let state = Dkg2State { poly_point, zero_keep, bip_keep };
    Ok(json!({ "state": state, "proof": proof, "zero_transmit": zero_transmit, "bip": bip }))
}

fn dkg3(input: &str) -> R<Value> {
    #[derive(Deserialize)]
    struct In {
        i: u8,
        sid: String,
        state: Dkg2State,
    }
    let a: In = from(input, "dkg3")?;
    let data = session(a.i, &a.sid)?;
    let (zero_keep, zero_transmit, mul_keep, mul_transmit, bip) =
        dkg::phase3::<C>(&data, &a.state.zero_keep, &a.state.bip_keep);
    let state = Dkg3State { poly_point: a.state.poly_point, zero_keep, mul_keep };
    Ok(json!({ "state": state, "zero_transmit": zero_transmit, "mul_transmit": mul_transmit, "bip": bip }))
}

/// Phase 4: everything received; outputs this party's key share and the address.
fn dkg4(input: &str) -> R<Value> {
    #[derive(Deserialize)]
    struct In {
        i: u8,
        sid: String,
        state: Dkg3State,
        proofs: Vec<ProofCommitment<C>>,
        zero2: Vec<TransmitInitZeroSharePhase2to4>,
        zero3: Vec<TransmitInitZeroSharePhase3to4>,
        mul: Vec<TransmitInitMulPhase3to4<C>>,
        bip2: Vec<(u8, BroadcastDerivationPhase2to4)>,
        bip3: Vec<(u8, BroadcastDerivationPhase3to4)>,
    }
    let a: In = from(input, "dkg4")?;
    let data = session(a.i, &a.sid)?;
    let (party, _pkg) = dkg::phase4::<C>(
        &data,
        &a.state.poly_point,
        &a.proofs,
        &a.state.zero_keep,
        &a.zero2,
        &a.zero3,
        &a.state.mul_keep,
        &a.mul,
        &map(a.bip2)?,
        &map(a.bip3)?,
        |pk| dkls23::secp256k1::compute_eth_address(pk),
    )
    .map_err(|e| format!("key generation aborted by party {:?}: {}", e.index, e.description()))?;
    let addr = address(&party);
    Ok(json!({ "share": party, "address": addr }))
}

// ── Signing ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SignIn {
    share: Party<C>,
    /// Fresh per signature, the same for both signers (hex, >= 16 bytes).
    sign_id: String,
    /// The other signer's party index.
    with: u8,
    /// The 32-byte hash being signed (e.g. a transaction's signing hash).
    hash: String,
}

impl SignIn {
    fn data(&self) -> R<SignData> {
        let sign_id = hex::decode(self.sign_id.trim_start_matches("0x")).map_err(|e| format!("sign id: {e}"))?;
        if sign_id.len() < 16 {
            return Err("sign id must be at least 16 bytes".into());
        }
        if self.with == self.share.party_index.as_u8() {
            return Err("a party can't sign with itself".into());
        }
        Ok(SignData { sign_id, counterparties: vec![party_index(self.with)?], message_hash: hash32(&self.hash)? })
    }
}

#[derive(Serialize, Deserialize)]
struct Sign1State {
    unique: UniqueKeep1to2<C>,
    keep: BTreeMap<PartyIndex, KeepPhase1to2<C>>,
}

#[derive(Serialize, Deserialize)]
struct Sign2State {
    unique: UniqueKeep2to3<C>,
    keep: BTreeMap<PartyIndex, KeepPhase2to3<C>>,
}

fn abort(e: dkls23::protocols::Abort) -> String {
    format!("signing aborted by party {:?}: {}", e.index, e.description())
}

fn sign1(input: &str) -> R<Value> {
    #[derive(Deserialize)]
    struct In {
        base: SignIn,
    }
    let a: In = from(input, "sign1")?;
    let data = a.base.data()?;
    let (unique, keep, transmit) = a.base.share.sign_phase1(&data).map_err(abort)?;
    Ok(json!({ "state": Sign1State { unique, keep }, "transmit": transmit }))
}

fn sign2(input: &str) -> R<Value> {
    #[derive(Deserialize)]
    struct In {
        base: SignIn,
        state: Sign1State,
        received: Vec<TransmitPhase1to2>,
    }
    let a: In = from(input, "sign2")?;
    let data = a.base.data()?;
    let (unique, keep, transmit) =
        a.base.share.sign_phase2(&data, a.state.unique, a.state.keep, &a.received).map_err(abort)?;
    Ok(json!({ "state": Sign2State { unique, keep }, "transmit": transmit }))
}

fn sign3(input: &str) -> R<Value> {
    #[derive(Deserialize)]
    struct In {
        base: SignIn,
        state: Sign2State,
        received: Vec<TransmitPhase2to3<C>>,
    }
    let a: In = from(input, "sign3")?;
    let data = a.base.data()?;
    let (x_coord, broadcast) =
        a.base.share.sign_phase3(&data, a.state.unique, a.state.keep, &a.received).map_err(abort)?;
    Ok(json!({ "state": { "x": x_coord }, "broadcast": broadcast }))
}

/// Both signers' phase-3 broadcasts in; a normal (low-s) ECDSA signature out.
fn sign4(input: &str) -> R<Value> {
    #[derive(Deserialize)]
    struct X {
        x: String,
    }
    #[derive(Deserialize)]
    struct In {
        base: SignIn,
        state: X,
        broadcasts: Vec<Broadcast3to4<C>>,
    }
    let a: In = from(input, "sign4")?;
    let data = a.base.data()?;
    let (s_hex, recovery_id) = a.base.share.sign_phase4(&data, &a.state.x, &a.broadcasts, true).map_err(abort)?;
    Ok(json!({ "r": format!("0x{}", a.state.x), "s": format!("0x{s_hex}"), "v": 27 + recovery_id }))
}

fn share_info(input: &str) -> R<Value> {
    #[derive(Deserialize)]
    struct In {
        share: Party<C>,
    }
    let a: In = from(input, "share_info")?;
    Ok(json!({ "address": address(&a.share), "party": a.share.party_index.as_u8() }))
}

/// Dispatch by operation name. Pure: no globals, no I/O but randomness.
pub fn call(op: &str, input: &str) -> String {
    let v = input;
    let out = match op {
        "dkg1" => dkg1(v),
        "dkg2" => dkg2(v),
        "dkg3" => dkg3(v),
        "dkg4" => dkg4(v),
        "sign1" => sign1(v),
        "sign2" => sign2(v),
        "sign3" => sign3(v),
        "sign4" => sign4(v),
        "share_info" => share_info(v),
        _ => Err(format!("unknown operation {op}")),
    };
    match out {
        Ok(v) => json!({ "ok": v }).to_string(),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

// ── WebAssembly ABI ─────────────────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
mod abi {
    use std::alloc::{alloc, dealloc, Layout};

    #[no_mangle]
    pub extern "C" fn mpc_alloc(len: usize) -> *mut u8 {
        if len == 0 {
            return std::ptr::NonNull::dangling().as_ptr();
        }
        unsafe { alloc(Layout::from_size_align(len, 1).unwrap()) }
    }

    /// # Safety
    /// `ptr` must come from `mpc_alloc(len)` or `mpc_call`, freed once.
    #[no_mangle]
    pub unsafe extern "C" fn mpc_free(ptr: *mut u8, len: usize) {
        if len != 0 {
            // Clear before freeing: buffers hold key shares and protocol state.
            std::ptr::write_bytes(ptr, 0, len);
            dealloc(ptr, Layout::from_size_align(len, 1).unwrap());
        }
    }

    /// # Safety
    /// Both inputs must be valid UTF-8 buffers allocated with `mpc_alloc`.
    #[no_mangle]
    pub unsafe extern "C" fn mpc_call(op_ptr: *const u8, op_len: usize, in_ptr: *const u8, in_len: usize) -> u64 {
        let op = std::str::from_utf8(std::slice::from_raw_parts(op_ptr, op_len)).unwrap_or("");
        let input = std::str::from_utf8(std::slice::from_raw_parts(in_ptr, in_len)).unwrap_or("");
        let out = super::call(op, input).into_bytes().into_boxed_slice();
        let len = out.len();
        let ptr = Box::into_raw(out) as *mut u8;
        ((ptr as u64) << 32) | len as u64
    }
}
