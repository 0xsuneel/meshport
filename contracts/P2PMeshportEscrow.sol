// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title P2PMeshportEscrow
 * @notice Same escrow mechanism as P2PEscrow.sol, with ONE structural
 * change: admin power is split into two tiers instead of one address that
 * can do everything.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * P2PEscrow.sol had a single `admin` address that could pause the whole
 * contract, freeze trades, AND force-release/refund real funds during
 * dispute resolution. That means the SAME key used for routine, low-risk
 * actions (like an emergency pause) was also the key that could move
 * money. Losing or leaking that one key is catastrophic either way, and
 * — as this project found out directly — a mismatched/lost key locks out
 * even routine actions like pause with no recovery path except a
 * transferAdmin() from the old key.
 *
 * ── The fix ──────────────────────────────────────────────────────────────
 * Two tiers:
 *   - PAUSER: can pause()/unpause() and freeze/unfreeze individual trades.
 *     Cannot move a single unit of value. Safe to hand to an everyday
 *     hot wallet used from the admin panel day-to-day — worst case if
 *     this key leaks is someone pausing the contract, which is
 *     inconvenient but instantly reversible by any other pauser or admin.
 *   - ADMIN: everything PAUSER can do, PLUS dispute-driven release/refund
 *     and PAUSER/ADMIN role management. This is the fund-moving key —
 *     keep it on a wallet you touch rarely (ideally eventually a multi-sig;
 *     see the transferAdmin two-step pattern below, which composes fine
 *     with a multi-sig as the admin address).
 *
 * Still deliberately NOT a full multi-sig or DAO — that's a separate,
 * later upgrade. This is the minimum change that removes "one leaked key
 * can drain funds" and "one lost key permanently blocks routine ops."
 */
contract P2PMeshportEscrow {
    enum EscrowState { None, Active }

    struct OfferEscrow {
        address seller;
        uint256 remaining;
        EscrowState state;
    }

    mapping(bytes32 => OfferEscrow) public escrows;
    mapping(bytes32 => bool) public tradeFrozen;
    mapping(bytes32 => bool) public tradeReleased;

    address public admin;
    address public pendingAdmin;

    // Pausers are additive — admin is always implicitly a pauser too (see
    // isPauser()), so there's never a state where NO ONE can pause.
    mapping(address => bool) public isPauserRole;

    bool public paused;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _reentrancyStatus = _NOT_ENTERED;

    event Deposited(bytes32 indexed offerKey, address indexed seller, uint256 amount, uint256 newRemaining);
    event Released(bytes32 indexed offerKey, bytes32 indexed tradeKey, address indexed buyer, uint256 amount, bool viaAdmin);
    event Withdrawn(bytes32 indexed offerKey, address indexed seller, uint256 amount, bool viaAdmin);
    event TradeFrozen(bytes32 indexed tradeKey, address indexed by);
    event TradeUnfrozen(bytes32 indexed tradeKey, address indexed by);
    event AdminTransferInitiated(address indexed currentAdmin, address indexed pendingAdmin_);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event PauserAdded(address indexed account, address indexed by);
    event PauserRemoved(address indexed account, address indexed by);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    modifier onlyAdmin() {
        require(msg.sender == admin, "P2PEscrow: caller is not admin");
        _;
    }

    // Admin automatically counts as a pauser — pause power is a SUBSET of
    // admin power, never a separate, disconnected permission.
    modifier onlyPauser() {
        require(msg.sender == admin || isPauserRole[msg.sender], "P2PEscrow: caller is not a pauser");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "P2PEscrow: contract is paused");
        _;
    }

    modifier nonReentrant() {
        require(_reentrancyStatus != _ENTERED, "P2PEscrow: reentrant call");
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    constructor() {
        admin = msg.sender;
    }

    function isPauser(address account) public view returns (bool) {
        return account == admin || isPauserRole[account];
    }

    // ── Deposits / releases / withdrawals — unchanged from P2PEscrow.sol ──

    function deposit(bytes32 offerKey) external payable whenNotPaused {
        require(msg.value > 0, "P2PEscrow: zero deposit");
        OfferEscrow storage e = escrows[offerKey];
        if (e.state == EscrowState.None) {
            e.seller = msg.sender;
            e.state = EscrowState.Active;
        } else {
            require(e.seller == msg.sender, "P2PEscrow: not offer owner");
        }
        e.remaining += msg.value;
        emit Deposited(offerKey, msg.sender, msg.value, e.remaining);
    }

    /// Fund-moving — stays gated to the seller (normal flow) or ADMIN only
    /// (dispute resolution). NOT callable by a plain pauser.
    function release(bytes32 offerKey, bytes32 tradeKey, address payable buyer, uint256 amount)
        external
        whenNotPaused
        nonReentrant
    {
        OfferEscrow storage e = escrows[offerKey];
        require(e.state == EscrowState.Active, "P2PEscrow: no active escrow for this offer");
        require(!tradeFrozen[tradeKey], "P2PEscrow: trade is frozen, admin must unfreeze first");
        require(!tradeReleased[tradeKey], "P2PEscrow: trade already released");
        require(msg.sender == e.seller || msg.sender == admin, "P2PEscrow: not authorized to release");
        require(amount > 0 && amount <= e.remaining, "P2PEscrow: invalid release amount");
        require(buyer != address(0), "P2PEscrow: zero buyer address");

        tradeReleased[tradeKey] = true;
        e.remaining -= amount;
        (bool sent, ) = buyer.call{value: amount}("");
        require(sent, "P2PEscrow: transfer to buyer failed");
        emit Released(offerKey, tradeKey, buyer, amount, msg.sender == admin);
    }

    /// Fund-moving — same gating as before (seller or ADMIN only).
    function withdrawRemaining(bytes32 offerKey) external whenNotPaused nonReentrant {
        OfferEscrow storage e = escrows[offerKey];
        require(e.state == EscrowState.Active, "P2PEscrow: no active escrow for this offer");
        require(msg.sender == e.seller || msg.sender == admin, "P2PEscrow: not authorized to withdraw");
        uint256 amount = e.remaining;
        require(amount > 0, "P2PEscrow: nothing left to withdraw");
        e.remaining = 0;
        address seller = e.seller;
        (bool sent, ) = payable(seller).call{value: amount}("");
        require(sent, "P2PEscrow: withdrawal transfer failed");
        emit Withdrawn(offerKey, seller, amount, msg.sender == admin);
    }

    // ── Trade freeze — now PAUSER-level, not ADMIN-only ──────────────────
    // Freezing doesn't move money, only blocks release() for one trade —
    // safe to let the everyday admin-panel key do this directly.

    function freezeTrade(bytes32 tradeKey) external onlyPauser {
        tradeFrozen[tradeKey] = true;
        emit TradeFrozen(tradeKey, msg.sender);
    }

    function unfreezeTrade(bytes32 tradeKey) external onlyPauser {
        tradeFrozen[tradeKey] = false;
        emit TradeUnfrozen(tradeKey, msg.sender);
    }

    // ── Pause — now PAUSER-level ──────────────────────────────────────────

    function pause() external onlyPauser {
        require(!paused, "P2PEscrow: already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyPauser {
        require(paused, "P2PEscrow: not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ── Pauser role management — ADMIN-only ──────────────────────────────
    // This is how you make your everyday admin-panel wallet able to pause
    // WITHOUT giving it fund-moving power: admin calls addPauser(yourWallet)
    // once, and from then on that wallet can pause/freeze directly.

    function addPauser(address account) external onlyAdmin {
        require(account != address(0), "P2PEscrow: zero address");
        isPauserRole[account] = true;
        emit PauserAdded(account, msg.sender);
    }

    function removePauser(address account) external onlyAdmin {
        isPauserRole[account] = false;
        emit PauserRemoved(account, msg.sender);
    }

    // ── Admin handover — unchanged two-step pattern ──────────────────────
    // Note: `admin` can later BE a multi-sig contract address instead of a
    // single wallet, with zero changes needed here — onlyAdmin just checks
    // msg.sender, and a multi-sig's own internal approval flow is what
    // eventually calls into this contract as that single msg.sender.

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "P2PEscrow: zero address");
        pendingAdmin = newAdmin;
        emit AdminTransferInitiated(admin, newAdmin);
    }

    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "P2PEscrow: caller is not the pending admin");
        emit AdminTransferred(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    function getRemaining(bytes32 offerKey) external view returns (uint256) {
        return escrows[offerKey].remaining;
    }

    function getSeller(bytes32 offerKey) external view returns (address) {
        return escrows[offerKey].seller;
    }
}
