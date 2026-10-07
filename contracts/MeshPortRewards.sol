// SPDX-License-Identifier: MIT
// ⚠️ Deploy with EVM VERSION: paris — Arc Testnet does not support PUSH0 (solc 0.8.20's default target is Shanghai). See contracts/README.md.
pragma solidity ^0.8.20;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title MeshPortRewards
 * @notice Converts MeshPort Points to USDC at a fixed rate.
 * @dev Deployed on Arc Testnet. Treasury holds USDC for payouts.
 *
 * Rate: 1000 points = 0.50 USDC  (rate stored as: 500 = 0.0005 USDC per point, 6 decimals)
 * i.e. 1 point = 500 / 1_000_000 USDC = 0.0000005 USDC
 * So 1000 points = 1000 * 500 / 1_000_000 = 0.5 USDC ✓
 */

interface IUSDC {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract MeshPortRewards {
    using ECDSA for bytes32;

    // ── State ───────────────────────────────────────────────────────────────
    /// @notice Current owner. Transferable via the timelocked two-step
    /// scheduleTransferOwnership → transferOwnership → acceptOwnership flow.
    address public owner;
    /// @notice Address that may call acceptOwnership(), set by transferOwnership().
    address public pendingOwner;
    address public immutable usdcToken;

    /// @notice Delay between scheduling and executing a sensitive admin action
    /// (signer rotation, rate change, treasury withdrawal, ownership transfer).
    /// If the owner key is compromised, this is the window to notice the
    /// scheduled operation, pause claims and cancel it.
    uint256 public constant TIMELOCK_DELAY = 2 days;

    /// @notice operationId => timestamp from which it may execute (0 = not scheduled).
    mapping(bytes32 => uint256) public scheduledAt;

    /// @notice Address whose private key signs claim vouchers.
    /// Set via setPointsSigner (onlyOwner).
    address public pointsSigner;

    // Rate: usdcPerThousandPoints in micro-USDC (6 decimals)
    // Default: 500_000 = 0.5 USDC per 1000 points
    uint256 public usdcPerThousandPoints = 500_000;

    bool public paused;

    // Claim tracking: claimId => claimed
    mapping(bytes32 => bool) public hasClaimed;

    // Daily limits: user => day => points claimed
    mapping(address => mapping(uint256 => uint256)) public dailyClaimed;
    uint256 public constant MAX_DAILY_POINTS = 1000;

    // ── Events ───────────────────────────────────────────────────────────────
    event RewardClaimed(
        address indexed user,
        uint256 points,
        uint256 usdcAmount,
        bytes32 claimId,
        uint256 timestamp
    );
    event TreasuryFunded(address indexed funder, uint256 amount, uint256 timestamp);
    event TreasuryWithdrawn(address indexed to, uint256 amount, uint256 timestamp);
    event ConversionRateUpdated(uint256 oldRate, uint256 newRate);
    event Paused(address by);
    event Unpaused(address by);
    event PointsSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event OperationScheduled(bytes32 indexed id, bytes4 action, uint256 value, uint256 readyAt);
    event OperationCancelled(bytes32 indexed id);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ────────────────────────────────────────────────────────────────
    error NotOwner();
    error ContractPaused();
    error AlreadyClaimed(bytes32 claimId);
    error InsufficientPoints(uint256 provided, uint256 minimum);
    error InsufficientTreasury(uint256 available, uint256 required);
    error DailyLimitExceeded(uint256 claimed, uint256 limit);
    error ZeroPoints();
    error TransferFailed();
    error InvalidSignature();
    error OperationNotScheduled(bytes32 id);
    error TimelockNotReady(uint256 readyAt);
    error NotPendingOwner();

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address _usdcToken) {
        require(_usdcToken != address(0), "MeshPortRewards: zero USDC token address");
        owner = msg.sender;
        usdcToken = _usdcToken;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Consume a scheduled operation, reverting unless it was scheduled
    /// and its delay has passed.
    modifier timelocked(bytes4 action, uint256 value) {
        _consume(action, value);
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    // ── View functions ────────────────────────────────────────────────────────

    /// @notice Calculate USDC (6 decimals) for a given number of points
    function calculateUSDC(uint256 points) public view returns (uint256) {
        return (points * usdcPerThousandPoints) / 1000;
    }

    /// @notice Current treasury USDC balance
    function treasuryBalance() public view returns (uint256) {
        return IUSDC(usdcToken).balanceOf(address(this));
    }

    /// @notice Check if a claim ID has already been used
    function isClaimUsed(bytes32 claimId) external view returns (bool) {
        return hasClaimed[claimId];
    }

    /// @notice Points already claimed today by user
    function dailyPointsClaimed(address user) external view returns (uint256) {
        uint256 day = block.timestamp / 86400;
        return dailyClaimed[user][day];
    }

    // ── Claim ──────────────────────────────────────────────────────────────────

    /**
     * @notice Claim USDC reward for accumulated points.
     * @param points    Number of points to redeem (minimum 100)
     * @param claimId   Unique off-chain claim ID to prevent double-claims
     * @param signature Signature from pointsSigner over
     *                  keccak256(abi.encode(address(this), block.chainid, msg.sender, points, claimId))
     *                  wrapped with toEthSignedMessageHash (standard Ethereum signed message).
     */
    function claimRewards(uint256 points, bytes32 claimId, bytes calldata signature) external whenNotPaused returns (uint256 usdcAmount) {
        // ── Signature verification — added authorization gate ──────────────
        // Prefix with EIP-191 personal_sign header so a backend can sign with
        // account.signMessage({ message: { raw: digest } }) (viem) or
        // ethers.signMessage(ethers.getBytes(digest)) — both add the same prefix.
        bytes32 digest = keccak256(abi.encode(address(this), block.chainid, msg.sender, points, claimId));
        bytes32 ethDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address recovered = ethDigest.recover(signature);
        if (recovered == address(0) || recovered != pointsSigner) revert InvalidSignature();

        if (points == 0) revert ZeroPoints();
        if (points < 100) revert InsufficientPoints(points, 100);
        if (hasClaimed[claimId]) revert AlreadyClaimed(claimId);

        // Check daily limit
        uint256 day = block.timestamp / 86400;
        uint256 todayClaimed = dailyClaimed[msg.sender][day];
        if (todayClaimed + points > MAX_DAILY_POINTS) {
            revert DailyLimitExceeded(todayClaimed, MAX_DAILY_POINTS);
        }

        // Calculate USDC
        usdcAmount = calculateUSDC(points);

        // Check treasury
        uint256 available = treasuryBalance();
        if (available < usdcAmount) revert InsufficientTreasury(available, usdcAmount);

        // Mark claimed BEFORE transfer (reentrancy protection)
        hasClaimed[claimId] = true;
        dailyClaimed[msg.sender][day] += points;

        // Transfer USDC
        bool ok = IUSDC(usdcToken).transfer(msg.sender, usdcAmount);
        if (!ok) revert TransferFailed();

        emit RewardClaimed(msg.sender, points, usdcAmount, claimId, block.timestamp);
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    /// @notice Fund the treasury by transferring USDC from the caller.
    /// Caller must approve this contract for `amount` USDC first.
    /// @dev HARDENING: reject zero-amount funding to prevent spurious
    /// TreasuryFunded events that could confuse off-chain monitors.
    function fundTreasury(uint256 amount) external {
        require(amount > 0, "MeshPortRewards: zero amount");
        bool ok = IUSDC(usdcToken).transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        emit TreasuryFunded(msg.sender, amount, block.timestamp);
    }

    // ── Timelock ──────────────────────────────────────────────────────────────
    //
    // setPointsSigner, setConversionRate, withdrawTreasury and transferOwnership
    // each need a matching schedule call TIMELOCK_DELAY earlier, e.g.
    //   scheduleSetPointsSigner(x)   … 2 days …   setPointsSigner(x)
    // A stolen owner key therefore cannot rotate the signer or drain the
    // treasury instantly. pauseClaims stays instant: it is the emergency brake.

    /// @notice Id of a scheduled operation: the execute function's selector
    /// plus its single argument (addresses as uint256(uint160(addr))).
    function operationId(bytes4 action, uint256 value) public pure returns (bytes32) {
        return keccak256(abi.encode(action, value));
    }

    function _schedule(bytes4 action, uint256 value) private {
        bytes32 id = operationId(action, value);
        uint256 readyAt = block.timestamp + TIMELOCK_DELAY;
        scheduledAt[id] = readyAt;
        emit OperationScheduled(id, action, value, readyAt);
    }

    function _consume(bytes4 action, uint256 value) private {
        bytes32 id = operationId(action, value);
        uint256 readyAt = scheduledAt[id];
        if (readyAt == 0) revert OperationNotScheduled(id);
        if (block.timestamp < readyAt) revert TimelockNotReady(readyAt);
        delete scheduledAt[id];
    }

    /// @notice Cancel a scheduled operation before it executes.
    function cancelOperation(bytes32 id) external onlyOwner {
        if (scheduledAt[id] == 0) revert OperationNotScheduled(id);
        delete scheduledAt[id];
        emit OperationCancelled(id);
    }

    function scheduleSetPointsSigner(address newSigner) external onlyOwner {
        require(newSigner != address(0), "MeshPortRewards: zero signer address");
        _schedule(this.setPointsSigner.selector, uint256(uint160(newSigner)));
    }

    function scheduleSetConversionRate(uint256 newRate) external onlyOwner {
        require(newRate > 0, "MeshPortRewards: zero conversion rate");
        _schedule(this.setConversionRate.selector, newRate);
    }

    function scheduleWithdrawTreasury(uint256 amount) external onlyOwner {
        require(amount > 0, "MeshPortRewards: zero amount");
        _schedule(this.withdrawTreasury.selector, amount);
    }

    function scheduleTransferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "MeshPortRewards: zero owner address");
        _schedule(this.transferOwnership.selector, uint256(uint160(newOwner)));
    }

    /// @notice Set the address whose private key signs claim vouchers.
    /// The first call after deployment (no signer yet) takes effect at once so
    /// the contract can be set up; every later rotation must be scheduled with
    /// scheduleSetPointsSigner TIMELOCK_DELAY in advance.
    /// @dev SECURITY FIX: zero-address guard — setting pointsSigner to
    /// address(0) would permanently block all claims (no key maps to
    /// address(0), so ECDSA.recover would always return address(0) which
    /// the sig check correctly rejects, but the contract would be bricked
    /// with no recourse other than deploying a new one). Reject it here
    /// instead so a typo or scripting error cannot create a permanent DoS.
    function setPointsSigner(address newSigner) external onlyOwner {
        require(newSigner != address(0), "MeshPortRewards: zero signer address");
        if (pointsSigner != address(0)) {
            _consume(this.setPointsSigner.selector, uint256(uint160(newSigner)));
        }
        emit PointsSignerUpdated(pointsSigner, newSigner);
        pointsSigner = newSigner;
    }

    /// @notice Change the conversion rate. Must be scheduled with
    /// scheduleSetConversionRate TIMELOCK_DELAY in advance.
    /// @dev SECURITY FIX: reject rate == 0. A zero rate makes calculateUSDC
    /// always return 0, so claimRewards would succeed (signature valid,
    /// claimId consumed forever) but transfer 0 USDC — every claim silently
    /// burns the user's claimId and daily allowance for nothing. A rate
    /// change to 0 is never a legitimate operation; reject it on-chain so a
    /// mistaken owner call cannot create an irreversible DoS against all
    /// pending vouchers.
    function setConversionRate(uint256 newRate)
        external onlyOwner timelocked(this.setConversionRate.selector, newRate)
    {
        require(newRate > 0, "MeshPortRewards: zero conversion rate");
        emit ConversionRateUpdated(usdcPerThousandPoints, newRate);
        usdcPerThousandPoints = newRate;
    }

    /// @notice Nominate a new owner. Must be scheduled with
    /// scheduleTransferOwnership TIMELOCK_DELAY in advance; the nominee then
    /// calls acceptOwnership(), so a typo cannot hand the contract to an
    /// address nobody controls.
    function transferOwnership(address newOwner)
        external onlyOwner timelocked(this.transferOwnership.selector, uint256(uint160(newOwner)))
    {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function pauseClaims() external onlyOwner {
        require(!paused, "MeshPortRewards: already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpauseClaims() external onlyOwner {
        require(paused, "MeshPortRewards: not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Withdraw USDC from the treasury back to the owner.
    /// @dev Emergency egress — lets the owner recover USDC in the event of
    /// a contract upgrade, permanent pause, or erroneous funding. Without
    /// this, any USDC in the contract is permanently locked if the contract
    /// is ever deprecated or over-funded. Restricted to onlyOwner; emits a
    /// distinct event so off-chain monitoring can detect unexpected drains.
    /// Must be scheduled with scheduleWithdrawTreasury TIMELOCK_DELAY in advance.
    /// @param amount Amount of USDC (6 decimals) to withdraw.
    function withdrawTreasury(uint256 amount)
        external onlyOwner timelocked(this.withdrawTreasury.selector, amount)
    {
        require(amount > 0, "MeshPortRewards: zero amount");
        uint256 available = IUSDC(usdcToken).balanceOf(address(this));
        require(amount <= available, "MeshPortRewards: amount exceeds treasury balance");
        bool ok = IUSDC(usdcToken).transfer(owner, amount);
        if (!ok) revert TransferFailed();
        emit TreasuryWithdrawn(owner, amount, block.timestamp);
    }
}
