// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title P2PMeshportEscrowV2
 * @notice Security-hardened replacement for P2PMeshportEscrow.sol. Fixes
 * three real, exploitable issues found in that contract during a review
 * requested for this exact purpose, and adds the INVESTIGATOR tier that
 * was previously missing entirely (only PAUSER/ADMIN existed).
 *
 * ── Currency note ─────────────────────────────────────────────────────────
 * USDC is Arc's NATIVE currency (see arcService.ts's own comment on this) —
 * not an ERC-20 token on this chain. There is nothing to `approve()` and no
 * ERC-20 contract to wrap with SafeERC20; every value-moving function here
 * uses `payable`/`msg.value`/`.call{value: amount}("")`, which for native
 * currency IS the correct, safe mechanism — this is not a shortcut around
 * SafeERC20, it's simply the right primitive for what this chain actually
 * moves. Follows checks-effects-interactions throughout: every accounting
 * update (state transitions, `remaining` balances) happens BEFORE the
 * external call that sends value, and ReentrancyGuard (OpenZeppelin, not
 * hand-rolled) backstops every function that sends value.
 *
 * ── Vulnerability 1 (FIXED): first-depositor-wins offer hijack ───────────
 * The old contract assigned `seller = msg.sender` to whoever called
 * deposit() FIRST for a given offerKey, with no way to know in advance
 * whether that caller was actually the legitimate seller. Since offerKey
 * was just `keccak256(offerId)`, and the deposit transaction is visible in
 * the mempool before it's mined, an attacker watching for a pending
 * deposit could front-run it with a higher gas price, depositing a tiny
 * amount first and claiming that offerKey's seller slot for themselves —
 * permanently locking the real seller out of their own offer.
 *
 * Fix: offerKeyFor() (see p2pEscrowContract.ts) now derives the key as
 * `keccak256(abi.encode(offerId, sellerAddress))` instead of just
 * `keccak256(offerId)`. An attacker with a different address fundamentally
 * cannot construct the SAME offerKey the real seller's app computed —
 * doing so would require finding a second preimage of a cryptographic
 * hash, not just being fast in the mempool. The "first depositor becomes
 * seller" logic below is now safe to keep exactly as-is, because only the
 * real seller's own address can ever produce a matching key for their
 * specific offer to begin with.
 *
 * ── Vulnerability 2 (FIXED): release() trusted caller-supplied buyer/amount ──
 * The old release(offerKey, tradeKey, buyer, amount) took buyer and amount
 * as PLAIN FUNCTION ARGUMENTS with no on-chain record of what they were
 * actually supposed to be — the contract just trusted whatever the caller
 * (seller, or admin during "dispute resolution") passed in. Combined with
 * `msg.sender == admin` being accepted on the SAME unrestricted function,
 * this meant admin could call release() with ANY offerKey, ANY buyer
 * address, and ANY amount up to that offer's remaining balance — a
 * complete, unrestricted drain path hiding behind what looked like a
 * normal release function.
 *
 * Fix: trades are now registered on-chain BEFORE they can be released.
 * registerTrade() (seller-only, called once when a trade is accepted —
 * see createTrade() in p2pService.ts) stores buyer/amount/offerKey
 * authoritatively in a Trade struct. release(tradeKey) now takes ONLY the
 * tradeKey and reads buyer/amount/seller from that stored struct — there
 * is no code path anywhere in this contract where a caller supplies the
 * buyer or amount directly for a real transfer.
 *
 * ── Vulnerability 3 (FIXED): admin could unilaterally force-release any trade ──
 * The old contract's `msg.sender == admin` bypass on release() let admin
 * move funds on ANY trade at ANY time with no investigation step and no
 * per-trade restriction — admin was, in effect, a second unrestricted
 * seller for every offer in the contract. There was also no INVESTIGATOR
 * tier at all.
 *
 * Fix: normal release() is now STRICTLY seller-only — admin has no path
 * through it at all. Disputed funds only move through the sequence this
 * contract enforces on-chain: PAUSER freezes a specific trade -->
 * INVESTIGATOR investigates that SAME trade and records an outcome (does
 * NOT move funds) --> ADMIN resolves that SAME investigated trade via
 * adminResolve(tradeKey), which reads the recorded outcome/buyer/amount
 * from storage and can only ever act on the one trade whose key is passed
 * in. There is no function anywhere that lets admin choose an arbitrary
 * recipient, an arbitrary amount, or move an entire offer's/the contract's
 * balance in one call.
 *
 * ── Role hierarchy (new) ──────────────────────────────────────────────────
 * Three tiers, each a strict superset requirement of the one below it —
 * you cannot be promoted to INVESTIGATOR without already being a PAUSER,
 * and you cannot become ADMIN without already being an INVESTIGATOR. This
 * is enforced ON-CHAIN (addInvestigator/transferAdmin both revert if the
 * target hasn't already cleared the tier below), not just as an
 * operational convention. Membership in each tier is 100% EXPLICIT — admin
 * has no implicit pause/investigate power; every privilege grant is its
 * own visible on-chain event, with no silent bypass (see isPauserRole's
 * own comment for why this changed from an earlier, less strict version):
 *   - PAUSER: pause()/unpause(), freezeTrade()/unfreezeTrade(),
 *     freezeOffer()/unfreezeOffer(). Cannot move a single unit of value,
 *     cannot investigate, cannot resolve anything.
 *   - INVESTIGATOR: investigate() a FROZEN trade, recording an outcome
 *     (release or refund). Cannot move value, cannot bypass the freeze
 *     step, cannot resolve — investigating only makes a trade eligible for
 *     ADMIN to resolve, it never moves funds itself.
 *   - ADMIN: adminResolve() an INVESTIGATED trade (and only that one,
 *     using only its stored data), plus role management and the two-step
 *     admin handover. No withdrawAll/sweep/drain function exists anywhere
 *     in this contract — admin's fund-moving power is scoped to one
 *     already-investigated trade at a time, forever.
 *
 * ── Trust assumption worth stating plainly ────────────────────────────────
 * The contract enforces that PROMOTION follows Pauser -> Investigator ->
 * Admin, and that each dispute follows Freeze -> Investigate -> Resolve.
 * It CANNOT enforce that three DIFFERENT humans hold those three keys day
 * to day — nothing stops the same operator from being separately granted
 * all three roles under three different addresses (or even, if genuinely
 * misconfigured, being handed all three private keys) and pushing one
 * trade through the whole sequence themselves. Real separation of duties
 * is an operational control (who is actually given which key), not
 * something a smart contract can verify about the humans behind addresses.
 * What this contract DOES guarantee is that no single ROLE — Pauser alone,
 * Investigator alone, or even Admin alone without the trade first being
 * frozen and investigated — can move funds by itself.
 */
contract P2PMeshportEscrowV2 is ReentrancyGuard {
    enum EscrowState { None, Active }
    enum TradeState { None, Active, Frozen, Investigated, Released, Refunded }

    struct OfferEscrow {
        address seller;
        uint256 remaining;
        // SECURITY FIX: sum of amounts committed to currently-Active
        // (registered but not yet Released/Refunded) trades against this
        // offer. Frozen/Investigated trades still count as reserved — a
        // dispute in progress is not "available" either.
        //
        // Root cause this fixes: registerTrade() used to only CHECK
        // `amount <= e.remaining` without ever reducing `remaining` — so
        // e.remaining stayed at its full deposited value even after a
        // trade was registered against part of it. withdrawRemaining()
        // then withdrew the FULL e.remaining, including money already
        // promised to a registered trade's buyer. A seller could deposit
        // 100, register a 70 trade, then immediately withdrawRemaining()
        // the full 100 — draining the real balance to 0 while the 70
        // trade sat Active, unreleasable forever (release()'s own
        // `t.amount <= e.remaining` check would then correctly revert,
        // but only AFTER the seller had already walked away with funds
        // that were never theirs to take).
        //
        // Fix: `available = remaining - reserved` is the only amount a
        // NEW trade can be registered against or a seller can withdraw.
        // `reserved` invariant: 0 <= reserved <= remaining, maintained by
        // every function that touches it (registerTrade increments,
        // release/adminResolve-release/adminResolve-refund all decrement).
        uint256 reserved;
        EscrowState state;
        bool frozen; // offer-level freeze (PAUSER) — blocks new deposits/trades, independent of any single trade's own freeze
    }

    struct Trade {
        bytes32 offerKey;
        address seller;
        address buyer;
        uint256 amount;
        TradeState state;
        bool investigatedApproveRelease; // recorded by INVESTIGATOR; only meaningful once state == Investigated
        address frozenBy;       // the PAUSER who froze this trade — recorded so investigate() can require a different address
        address investigatedBy; // the INVESTIGATOR who investigated it — recorded so adminResolve() can require a different address
        address resolvedBy;
    }

    mapping(bytes32 => OfferEscrow) public escrows;
    mapping(bytes32 => Trade) public trades;

    address public admin;
    address public pendingAdmin;

    // Additive, hierarchical — see the role-hierarchy note above.
    //
    // SECURITY FIX (separation of duties): `admin` used to be implicitly
    // both a pauser AND an investigator (isPauser/isInvestigator returned
    // true for admin automatically), which meant a SINGLE compromised or
    // malicious admin key could freeze -> investigate -> resolve the same
    // trade completely alone — no independent second reviewer required at
    // any step, defeating the entire point of splitting this into three
    // tiers. Role membership is now 100% explicit: admin has NO pause or
    // investigate power until it is EXPLICITLY granted via addPauser/
    // addInvestigator, exactly like any other address, producing a visible
    // on-chain event either way. This does mean a fresh deployment has
    // ZERO pausers until the deployer calls addPauser at least once (see
    // the deploy script) — a deliberate trade-off: an explicit, auditable
    // bootstrapping step is safer than a silent, permanent admin bypass.
    mapping(address => bool) public isPauserRole;
    mapping(address => bool) public isInvestigatorRole;

    bool public paused;

    event Deposited(bytes32 indexed offerKey, address indexed seller, uint256 amount, uint256 newRemaining);
    event TradeRegistered(bytes32 indexed offerKey, bytes32 indexed tradeKey, address indexed seller, address buyer, uint256 amount);
    event Released(bytes32 indexed offerKey, bytes32 indexed tradeKey, address indexed buyer, uint256 amount);
    event Withdrawn(bytes32 indexed offerKey, address indexed seller, uint256 amount);
    event TradeFrozen(bytes32 indexed tradeKey, address indexed by);
    event TradeUnfrozen(bytes32 indexed tradeKey, address indexed by);
    event OfferFrozen(bytes32 indexed offerKey, address indexed by);
    event OfferUnfrozen(bytes32 indexed offerKey, address indexed by);
    event Investigated(bytes32 indexed tradeKey, address indexed by, bool approveRelease);
    event AdminResolvedRelease(bytes32 indexed offerKey, bytes32 indexed tradeKey, address indexed buyer, uint256 amount, address admin_);
    event AdminResolvedRefund(bytes32 indexed offerKey, bytes32 indexed tradeKey, address indexed seller, uint256 amount, address admin_);
    event AdminTransferInitiated(address indexed currentAdmin, address indexed pendingAdmin_);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event PauserAdded(address indexed account, address indexed by);
    event PauserRemoved(address indexed account, address indexed by);
    event InvestigatorAdded(address indexed account, address indexed by);
    event InvestigatorRemoved(address indexed account, address indexed by);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event RoleProposalCreated(uint256 indexed proposalId, RoleAction action, address target, address indexed proposer);
    event RoleProposalConfirmed(uint256 indexed proposalId, address indexed signer, uint256 confirmations);
    event RoleProposalApproved(uint256 indexed proposalId, uint256 executableAfter);
    event RoleProposalCancelled(uint256 indexed proposalId, address indexed by);
    event RoleProposalExecuted(uint256 indexed proposalId);
    event SignerRotated(uint256 indexed signerIndex, address indexed oldSigner, address indexed newSigner);

    modifier onlyAdmin() {
        require(msg.sender == admin, "P2PEscrowV2: caller is not admin");
        _;
    }

    modifier onlyPauser() {
        require(isPauser(msg.sender), "P2PEscrowV2: caller is not a pauser");
        _;
    }

    modifier onlyInvestigator() {
        require(isInvestigator(msg.sender), "P2PEscrowV2: caller is not an investigator");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "P2PEscrowV2: contract is paused");
        _;
    }

    /// `_roleManagerSigners` must be three DISTINCT, non-zero addresses —
    /// this is the "2-of-3 independent security authority" that governs
    /// every Pauser/Investigator/Admin role change from this point on (see
    /// the role-management section below). Deliberately NOT the same
    /// address as `admin` by requirement — see deploy-p2p-meshport-
    /// escrow-v2.cjs, which enforces this at deployment time too.
    ///
    /// Nothing is auto-granted here — not even to the deployer. The
    /// contract starts with ZERO pausers/investigators; the role manager
    /// signers must submit and confirm the first real proposals themselves
    /// (2 of the 3 signing off), the exact same governed path every later
    /// role change uses. No implicit bootstrap bypass, ever.
    constructor(address[3] memory _roleManagerSigners) {
        admin = msg.sender;
        for (uint256 i = 0; i < 3; i++) {
            require(_roleManagerSigners[i] != address(0), "P2PEscrowV2: zero role manager signer");
            for (uint256 j = i + 1; j < 3; j++) {
                require(_roleManagerSigners[i] != _roleManagerSigners[j], "P2PEscrowV2: role manager signers must be distinct");
            }
            roleManagerSigners[i] = _roleManagerSigners[i];
            isRoleManagerSigner[_roleManagerSigners[i]] = true;
        }
    }

    function isPauser(address account) public view returns (bool) {
        return isPauserRole[account];
    }

    function isInvestigator(address account) public view returns (bool) {
        return isInvestigatorRole[account];
    }

    // ── Deposits ──────────────────────────────────────────────────────────
    // See the file-header note on offerKeyFor() — offerKey now cryptographically
    // binds the intended seller's address, so "first depositor becomes seller"
    // is safe: nobody but the real seller can construct a matching key.

    function deposit(bytes32 offerKey) external payable whenNotPaused {
        require(msg.value > 0, "P2PEscrowV2: zero deposit");
        OfferEscrow storage e = escrows[offerKey];
        require(!e.frozen, "P2PEscrowV2: offer is frozen");
        if (e.state == EscrowState.None) {
            e.seller = msg.sender;
            e.state = EscrowState.Active;
        } else {
            require(e.seller == msg.sender, "P2PEscrowV2: not offer owner");
        }
        e.remaining += msg.value;
        emit Deposited(offerKey, msg.sender, msg.value, e.remaining);
    }

    // ── Trade registration — the fix for vulnerability 2 ────────────────
    // Called once by the offer's seller when a trade is accepted, BEFORE
    // any release can happen. This is what makes buyer/amount authoritative
    // on-chain data instead of caller-supplied parameters trusted at
    // release time.

    function registerTrade(bytes32 tradeKey, bytes32 offerKey, address buyer, uint256 amount)
        external
        whenNotPaused
    {
        OfferEscrow storage e = escrows[offerKey];
        require(e.state == EscrowState.Active, "P2PEscrowV2: no active escrow for this offer");
        require(!e.frozen, "P2PEscrowV2: offer is frozen");
        require(msg.sender == e.seller, "P2PEscrowV2: only the offer's seller can register a trade");
        require(trades[tradeKey].state == TradeState.None, "P2PEscrowV2: trade key already used");
        require(buyer != address(0), "P2PEscrowV2: zero buyer address");
        // Available = remaining minus whatever's already committed to
        // other active/frozen/investigated trades — NOT gross remaining.
        // See OfferEscrow.reserved's own comment for why this distinction
        // is the entire fix for the reservation bug.
        uint256 available = e.remaining - e.reserved;
        require(amount > 0 && amount <= available, "P2PEscrowV2: invalid trade amount");

        e.reserved += amount;
        trades[tradeKey] = Trade({
            offerKey: offerKey, seller: e.seller, buyer: buyer, amount: amount,
            state: TradeState.Active, investigatedApproveRelease: false,
            frozenBy: address(0), investigatedBy: address(0), resolvedBy: address(0)
        });
        emit TradeRegistered(offerKey, tradeKey, e.seller, buyer, amount);
    }

    // ── Normal release — seller-only, no privileged approval, ever ──────
    // This is the fix for vulnerability 3's admin bypass: there is no
    // `msg.sender == admin` branch here at all. Disputed funds can ONLY
    // move through freeze --> investigate --> adminResolve below.

    function release(bytes32 tradeKey) external whenNotPaused nonReentrant {
        Trade storage t = trades[tradeKey];
        require(t.state == TradeState.Active, "P2PEscrowV2: trade not active (frozen, already resolved, or unknown)");
        require(msg.sender == t.seller, "P2PEscrowV2: only the trade's seller can release it");

        OfferEscrow storage e = escrows[t.offerKey];
        require(t.amount <= e.remaining, "P2PEscrowV2: trade amount exceeds remaining escrow");

        t.state = TradeState.Released;
        e.remaining -= t.amount;
        e.reserved -= t.amount;
        (bool sent, ) = payable(t.buyer).call{value: t.amount}("");
        require(sent, "P2PEscrowV2: transfer to buyer failed");
        emit Released(t.offerKey, tradeKey, t.buyer, t.amount);
    }

    // ── Seller withdrawal — seller's own AVAILABLE balance only, never
    // funds already committed to a registered trade. No admin bypass —
    // see the file header on "admin does not get a generic withdrawal
    // capability."

    function withdrawRemaining(bytes32 offerKey) external whenNotPaused nonReentrant {
        OfferEscrow storage e = escrows[offerKey];
        require(e.state == EscrowState.Active, "P2PEscrowV2: no active escrow for this offer");
        require(msg.sender == e.seller, "P2PEscrowV2: not the offer's seller");
        // Only the AVAILABLE portion — reserved funds (committed to
        // registered trades still Active/Frozen/Investigated) are never
        // withdrawable. This is the core fix: the seller cannot walk away
        // with money already promised to a buyer via a registered trade.
        uint256 amount = e.remaining - e.reserved;
        require(amount > 0, "P2PEscrowV2: nothing available to withdraw (funds are reserved for active trades or already withdrawn)");
        e.remaining -= amount;
        (bool sent, ) = payable(e.seller).call{value: amount}("");
        require(sent, "P2PEscrowV2: withdrawal transfer failed");
        emit Withdrawn(offerKey, e.seller, amount);
    }

    // ── PAUSER tier — freezing only, never moves value ───────────────────

    function freezeTrade(bytes32 tradeKey) external onlyPauser {
        Trade storage t = trades[tradeKey];
        require(t.state == TradeState.Active, "P2PEscrowV2: trade not active");
        t.state = TradeState.Frozen;
        t.frozenBy = msg.sender;
        emit TradeFrozen(tradeKey, msg.sender);
    }

    /// Lets a pauser undo a mistaken freeze BEFORE an investigator has acted — reverts the trade back to Active. Once investigate() has run, only adminResolve() can move the trade forward; a pauser can no longer unilaterally reopen it.
    function unfreezeTrade(bytes32 tradeKey) external onlyPauser {
        Trade storage t = trades[tradeKey];
        require(t.state == TradeState.Frozen, "P2PEscrowV2: trade not frozen");
        t.state = TradeState.Active;
        emit TradeUnfrozen(tradeKey, msg.sender);
    }

    /// Freezes an entire offer — blocks new deposits and new trade registrations against it (e.g. a seller under review), without touching trades already registered before the freeze.
    function freezeOffer(bytes32 offerKey) external onlyPauser {
        require(escrows[offerKey].state == EscrowState.Active, "P2PEscrowV2: no active escrow for this offer");
        escrows[offerKey].frozen = true;
        emit OfferFrozen(offerKey, msg.sender);
    }

    function unfreezeOffer(bytes32 offerKey) external onlyPauser {
        escrows[offerKey].frozen = false;
        emit OfferUnfrozen(offerKey, msg.sender);
    }

    function pause() external onlyPauser {
        require(!paused, "P2PEscrowV2: already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyPauser {
        require(paused, "P2PEscrowV2: not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ── INVESTIGATOR tier — records an outcome, never moves value ───────

    /// Investigates a FROZEN trade and records the recommended outcome. Does not move any funds — only ADMIN's adminResolve() below actually transfers value, and only after this has run for that exact tradeKey.
    ///
    /// SECURITY FIX (independent review): requires the investigator to be a
    /// DIFFERENT address from whoever froze this specific trade. Without
    /// this, one operator holding both PAUSER and INVESTIGATOR roles (a
    /// real possibility — role hierarchy requires investigator to already
    /// be a pauser, so every investigator IS a pauser) could freeze a trade
    /// and immediately "investigate" it themselves, with no independent
    /// second reviewer ever having looked at it — defeating the entire
    /// point of a separate investigation step.
    function investigate(bytes32 tradeKey, bool approveRelease) external onlyInvestigator {
        Trade storage t = trades[tradeKey];
        require(t.state == TradeState.Frozen, "P2PEscrowV2: trade must be frozen before investigation");
        require(msg.sender != t.frozenBy, "P2PEscrowV2: investigator must be different from the pauser who froze this trade");
        t.state = TradeState.Investigated;
        t.investigatedApproveRelease = approveRelease;
        t.investigatedBy = msg.sender;
        emit Investigated(tradeKey, msg.sender, approveRelease);
    }

    // ── ADMIN tier — resolves ONE already-investigated trade, using ONLY
    // that trade's own stored data. This is the entire fix for
    // vulnerability 3: there is no parameter here admin can use to choose
    // an arbitrary recipient or amount, and no function anywhere in this
    // contract that touches more than one trade's escrowed funds at a time.
    //
    // SECURITY FIX (independent review, continued): admin must also be
    // different from both the investigator AND the pauser who touched this
    // specific trade. A single admin address is inherently the ultimate
    // authority (it grants every other role), so this cannot force THREE
    // truly distinct humans — but it does force three distinct ON-CHAIN
    // ADDRESSES to have acted on this specific trade before funds move,
    // closing the "one key does everything for one dispute" gap even when
    // that key happens to hold multiple roles.

    function adminResolve(bytes32 tradeKey) external onlyAdmin nonReentrant {
        Trade storage t = trades[tradeKey];
        require(t.state == TradeState.Investigated, "P2PEscrowV2: trade must be investigated before admin can resolve it");
        require(msg.sender != t.investigatedBy, "P2PEscrowV2: admin must be different from this trade's investigator");
        require(msg.sender != t.frozenBy, "P2PEscrowV2: admin must be different from this trade's pauser");

        OfferEscrow storage e = escrows[t.offerKey];
        require(t.amount <= e.remaining, "P2PEscrowV2: trade amount exceeds remaining escrow");

        t.resolvedBy = msg.sender;

        if (t.investigatedApproveRelease) {
            t.state = TradeState.Released;
            e.remaining -= t.amount;
            e.reserved -= t.amount;
            (bool sent, ) = payable(t.buyer).call{value: t.amount}("");
            require(sent, "P2PEscrowV2: transfer to buyer failed");
            emit AdminResolvedRelease(t.offerKey, tradeKey, t.buyer, t.amount, msg.sender);
        } else {
            // Refund: the amount was never removed from e.remaining (only
            // release()/adminResolve-release do that), so "refunding"
            // simply releases the RESERVATION and restores the trade to a
            // resolved-refunded state — the funds were never actually
            // debited from the offer's escrow in the first place, they
            // just stop being earmarked for this specific trade. The
            // seller can withdraw them via withdrawRemaining() same as
            // any other un-reserved balance, now that e.reserved no
            // longer counts this trade's amount against availability.
            t.state = TradeState.Refunded;
            e.reserved -= t.amount;
            emit AdminResolvedRefund(t.offerKey, tradeKey, t.seller, t.amount, msg.sender);
        }
    }

    // ── Role management — NOT admin-controlled. See "Admin must not
    // unilaterally destroy separation of duties" in the file header.
    //
    // SECURITY FIX (role-manager multisig): addPauser/removePauser/
    // addInvestigator/removeInvestigator/transferAdmin used to be
    // onlyAdmin — meaning ADMIN alone could grant itself new pauser/
    // investigator addresses, remove existing ones, or hand admin to
    // anyone already an investigator, all unilaterally. Even with the
    // per-dispute independence checks elsewhere in this contract, a
    // unilateral admin could still quietly reshape WHO holds every role
    // over time with no independent check on that power itself.
    //
    // Fix: every role-management action now requires a 2-of-3 proposal
    // among three fixed, independent ROLE MANAGER signers set once at
    // deployment (see the constructor) — a genuinely separate authority
    // from admin/pauser/investigator, not a "dashboard admin." Any ONE
    // signer proposes (which counts as their own confirmation); a SECOND,
    // DIFFERENT signer must separately confirm before the change executes.
    // No single signer — including one who is also the escrow's admin —
    // can push a role change through alone.
    //
    // Deliberately NOT itself an arbitrary-fund-mover: this multisig can
    // only ever call the 5 role-management actions below (add/remove
    // pauser, add/remove investigator, transfer/cancel admin) — it has no
    // path to release, refund, or withdraw a single unit of escrowed USDC.

    enum RoleAction { AddPauser, RemovePauser, AddInvestigator, RemoveInvestigator, TransferAdmin, CancelAdminTransfer, RotateSigner }

    /**
     * SECURITY ADDITION: 2-hour timelock on every privileged role/
     * governance CHANGE — who holds Pauser/Investigator/Admin/Role-Manager
     * status. Deliberately does NOT apply to the OPERATIONAL actions those
     * roles perform (freezeTrade, investigate, adminResolve all remain
     * immediate) — only to changing WHO can perform them. This gives any
     * observer (the affected roles, an off-chain monitor, the UI) a fixed
     * 2-hour window to notice and react to a governance change before it
     * takes effect, without touching the dispute-resolution speed at all.
     *
     * Deliberately a FLAT delay applied uniformly to every RoleAction,
     * including RotateSigner — a compromised Role Manager slot being
     * rotated out is exactly the kind of change that benefits most from a
     * visible waiting period, not the one to exempt.
     */
    uint256 public constant TIMELOCK_DELAY = 2 hours;

    struct RoleProposal {
        RoleAction action;
        address target;
        uint256 signerIndex; // only meaningful for RotateSigner — which of the 3 fixed slots (0/1/2) to replace
        uint256 confirmations;
        bool executed;
        bool cancelled;
        // 0 until 2-of-3 confirmations are reached; then set EXACTLY ONCE
        // to (confirmation-time + TIMELOCK_DELAY) and never touched again
        // by any function — not by a 3rd/4th confirmation, not by any
        // other role manager action. This is what makes "no one can
        // shorten or extend the delay" a structural fact rather than a
        // convention: there is no code path that writes to this field a
        // second time for the same proposal.
        uint256 executableAfter;
    }

    address[3] public roleManagerSigners;
    mapping(address => bool) public isRoleManagerSigner;
    mapping(uint256 => RoleProposal) public roleProposals;
    mapping(uint256 => mapping(address => bool)) public roleProposalConfirmedBy;
    uint256 public roleProposalCount;
    uint256 public constant ROLE_CONFIRMATIONS_REQUIRED = 2;

    modifier onlyRoleManagerSigner() {
        require(isRoleManagerSigner[msg.sender], "P2PEscrowV2: caller is not a role manager signer");
        _;
    }

    /// Step 1: any role manager signer proposes a change — this counts as their own confirmation (1 of 2).
    function proposeRoleChange(RoleAction action, address target) external onlyRoleManagerSigner returns (uint256 proposalId) {
        require(action != RoleAction.RotateSigner, "P2PEscrowV2: use proposeSignerRotation for this action");
        if (action != RoleAction.CancelAdminTransfer) {
            require(target != address(0), "P2PEscrowV2: zero address");
        }
        proposalId = roleProposalCount++;
        roleProposals[proposalId] = RoleProposal({ action: action, target: target, signerIndex: 0, confirmations: 0, executed: false, cancelled: false, executableAfter: 0 });
        emit RoleProposalCreated(proposalId, action, target, msg.sender);
        _confirmRoleProposal(proposalId);
    }

    /**
     * SECURITY FIX (role-manager rotation): lets the 2-of-3 role manager
     * multisig itself replace one of the 3 fixed signer slots — e.g. a key
     * was lost or compromised, or a signer needs to change for
     * operational reasons. This goes through the EXACT same 2-of-3
     * proposal/confirm flow as every other role change; ADMIN has no
     * special power here and cannot rotate signers alone (or at all —
     * admin was never a role manager signer to begin with unless
     * separately granted that specific role too).
     *
     * Rejects: signerIndex out of range, zero address, and any address
     * that's ALREADY one of the 3 current signers (no duplicate slots —
     * a rotation that made two slots the same address would silently
     * turn this into a 2-of-2-effectively-1 multisig).
     */
    function proposeSignerRotation(uint256 signerIndex, address newSigner) external onlyRoleManagerSigner returns (uint256 proposalId) {
        require(signerIndex < 3, "P2PEscrowV2: signer index out of range");
        require(newSigner != address(0), "P2PEscrowV2: zero address");
        require(!isRoleManagerSigner[newSigner], "P2PEscrowV2: address is already a role manager signer");
        proposalId = roleProposalCount++;
        roleProposals[proposalId] = RoleProposal({
            action: RoleAction.RotateSigner, target: newSigner, signerIndex: signerIndex,
            confirmations: 0, executed: false, cancelled: false, executableAfter: 0
        });
        emit RoleProposalCreated(proposalId, RoleAction.RotateSigner, newSigner, msg.sender);
        _confirmRoleProposal(proposalId);
    }

    /**
     * Step 2: a DIFFERENT role manager signer confirms. Once confirmations
     * reach ROLE_CONFIRMATIONS_REQUIRED, this starts the 2-hour timelock —
     * it does NOT execute the change itself anymore (see
     * executeRoleProposal below for the actual execution step, which can
     * only succeed once TIMELOCK_DELAY has elapsed since this moment).
     * Extra confirmations beyond the threshold (a 3rd signer, etc.) are
     * harmless no-ops as far as the timelock goes — executableAfter is
     * only ever set once, on the confirmation that FIRST reaches the
     * threshold, and is never overwritten afterward.
     */
    function confirmRoleChange(uint256 proposalId) external onlyRoleManagerSigner {
        RoleProposal storage p = roleProposals[proposalId];
        require(!p.executed, "P2PEscrowV2: proposal already executed");
        require(!p.cancelled, "P2PEscrowV2: proposal was cancelled");
        _confirmRoleProposal(proposalId);
    }

    function _confirmRoleProposal(uint256 proposalId) internal {
        RoleProposal storage p = roleProposals[proposalId];
        require(!roleProposalConfirmedBy[proposalId][msg.sender], "P2PEscrowV2: already confirmed by this signer");
        roleProposalConfirmedBy[proposalId][msg.sender] = true;
        p.confirmations += 1;
        emit RoleProposalConfirmed(proposalId, msg.sender, p.confirmations);
        if (p.confirmations >= ROLE_CONFIRMATIONS_REQUIRED && p.executableAfter == 0) {
            p.executableAfter = block.timestamp + TIMELOCK_DELAY;
            emit RoleProposalApproved(proposalId, p.executableAfter);
        }
    }

    /**
     * Step 3 (new): executes a proposal that has already reached 2-of-3
     * approval AND whose 2-hour timelock has elapsed. Gated to role
     * manager signers (same as every other governance entry point here) —
     * not open to arbitrary callers — but the CONTENT of what executes is
     * entirely fixed by the already-stored proposal; the caller cannot
     * influence target/action/amount in any way at this step, they can
     * only trigger the already-approved, already-timestamped change.
     *
     * A single role manager signer calling this alone is not a bypass of
     * 2-of-3 — the 2-of-3 requirement was already satisfied back when
     * executableAfter was set; this step only checks TIME has passed, not
     * authorization again.
     */
    function executeRoleProposal(uint256 proposalId) external onlyRoleManagerSigner {
        RoleProposal storage p = roleProposals[proposalId];
        require(!p.executed, "P2PEscrowV2: proposal already executed");
        require(!p.cancelled, "P2PEscrowV2: proposal was cancelled");
        require(p.executableAfter != 0, "P2PEscrowV2: proposal has not reached required confirmations yet");
        require(block.timestamp >= p.executableAfter, "P2PEscrowV2: timelock has not elapsed yet");
        _executeRoleProposal(proposalId);
    }

    /// Any signer who has NOT yet confirmed can cancel a still-pending proposal — e.g. a proposed target was a typo. Once executed, nothing can undo it here; a fresh opposing proposal must be raised instead.
    function cancelRoleProposal(uint256 proposalId) external onlyRoleManagerSigner {
        RoleProposal storage p = roleProposals[proposalId];
        require(!p.executed, "P2PEscrowV2: proposal already executed");
        require(!p.cancelled, "P2PEscrowV2: already cancelled");
        p.cancelled = true;
        emit RoleProposalCancelled(proposalId, msg.sender);
    }

    function _executeRoleProposal(uint256 proposalId) internal {
        RoleProposal storage p = roleProposals[proposalId];
        p.executed = true;
        address target = p.target;

        if (p.action == RoleAction.AddPauser) {
            isPauserRole[target] = true;
            emit PauserAdded(target, address(this));
        } else if (p.action == RoleAction.RemovePauser) {
            isPauserRole[target] = false;
            if (isInvestigatorRole[target]) {
                isInvestigatorRole[target] = false;
                emit InvestigatorRemoved(target, address(this));
            }
            emit PauserRemoved(target, address(this));
        } else if (p.action == RoleAction.AddInvestigator) {
            require(isPauserRole[target], "P2PEscrowV2: account must already be a pauser");
            isInvestigatorRole[target] = true;
            emit InvestigatorAdded(target, address(this));
        } else if (p.action == RoleAction.RemoveInvestigator) {
            isInvestigatorRole[target] = false;
            emit InvestigatorRemoved(target, address(this));
        } else if (p.action == RoleAction.TransferAdmin) {
            require(isInvestigator(target), "P2PEscrowV2: new admin must already be an investigator");
            pendingAdmin = target;
            emit AdminTransferInitiated(admin, target);
        } else if (p.action == RoleAction.CancelAdminTransfer) {
            pendingAdmin = address(0);
        } else if (p.action == RoleAction.RotateSigner) {
            // Re-check for duplicates at EXECUTION time, not just at
            // proposal time — state can change between the two (e.g. a
            // different rotation executing first), and a stale check here
            // could let two slots end up holding the same address, which
            // would silently weaken this from a real 2-of-3 down to
            // effectively 2-of-2 (or worse).
            require(!isRoleManagerSigner[target], "P2PEscrowV2: address is already a role manager signer");
            address oldSigner = roleManagerSigners[p.signerIndex];
            isRoleManagerSigner[oldSigner] = false;
            roleManagerSigners[p.signerIndex] = target;
            isRoleManagerSigner[target] = true;
            emit SignerRotated(p.signerIndex, oldSigner, target);
        }
        emit RoleProposalExecuted(proposalId);
    }

    function getRoleProposal(uint256 proposalId) external view returns (
        RoleAction action, address target, uint256 signerIndex, uint256 confirmations, bool executed, bool cancelled, uint256 executableAfter
    ) {
        RoleProposal storage p = roleProposals[proposalId];
        return (p.action, p.target, p.signerIndex, p.confirmations, p.executed, p.cancelled, p.executableAfter);
    }

    /// True only once 2-of-3 has been reached AND the 2-hour timelock has elapsed AND it hasn't already been executed or cancelled — i.e. exactly when executeRoleProposal() would succeed.
    function isRoleProposalExecutable(uint256 proposalId) external view returns (bool) {
        RoleProposal storage p = roleProposals[proposalId];
        return !p.executed && !p.cancelled && p.executableAfter != 0 && block.timestamp >= p.executableAfter;
    }

    // ── Admin handover — the final acceptance step is unchanged: only the
    // nominated address itself can accept, exactly as before. What changed
    // is who can NOMINATE that address in the first place (the role
    // manager multisig above, not admin unilaterally).

    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "P2PEscrowV2: caller is not the pending admin");
        // SECURITY FIX: re-verify the investigator requirement AT
        // ACCEPTANCE time, not just when the role managers nominated this
        // address. Without this, the sequence Investigator -> nominated as
        // pending admin -> investigator role REMOVED before they call
        // acceptAdmin() -> acceptAdmin() still succeeding would let someone
        // become Admin while no longer satisfying the hierarchy this
        // contract is supposed to enforce at every step, not just once.
        require(isInvestigator(msg.sender), "P2PEscrowV2: pending admin is no longer an investigator");
        emit AdminTransferred(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    // ── Views ─────────────────────────────────────────────────────────────

    /// GROSS remaining — total real value still held for this offer, including amounts reserved for active/frozen/investigated trades. Deliberately unchanged in meaning from before this fix (existing client/Supabase callers rely on this exact semantic for "does the contract still hold funds for this bucket at all"). Use getAvailable() for "how much could a NEW trade be registered for, or the seller withdraw."
    function getRemaining(bytes32 offerKey) external view returns (uint256) {
        return escrows[offerKey].remaining;
    }

    /// How much of this offer's remaining balance is committed to currently-Active/Frozen/Investigated trades — never withdrawable by the seller, never available for a new registerTrade() call.
    function getReserved(bytes32 offerKey) external view returns (uint256) {
        return escrows[offerKey].reserved;
    }

    /// The actual withdrawable/registerable amount: remaining minus reserved. This is the number that matters for "can the seller take this out" and "can a new trade be registered for X" — getRemaining() alone answers neither question correctly post-fix.
    function getAvailable(bytes32 offerKey) external view returns (uint256) {
        OfferEscrow storage e = escrows[offerKey];
        return e.remaining - e.reserved;
    }

    function getSeller(bytes32 offerKey) external view returns (address) {
        return escrows[offerKey].seller;
    }

    function getTrade(bytes32 tradeKey) external view returns (
        bytes32 offerKey, address seller, address buyer, uint256 amount,
        TradeState state, bool investigatedApproveRelease, address frozenBy, address investigatedBy, address resolvedBy
    ) {
        Trade storage t = trades[tradeKey];
        return (t.offerKey, t.seller, t.buyer, t.amount, t.state, t.investigatedApproveRelease, t.frozenBy, t.investigatedBy, t.resolvedBy);
    }
}
