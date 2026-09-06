// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

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
    function balanceOf(address account) external view returns (uint256);
}

contract MeshPortRewards {
    // ── State ───────────────────────────────────────────────────────────────
    address public immutable owner;
    address public immutable usdcToken;

    // Rate: usdcPerThousandPoints in micro-USDC (6 decimals)
    // Default: 500_000 = 0.5 USDC per 1000 points
    uint256 public usdcPerThousandPoints = 500_000;

    bool public paused;

    // Claim tracking: claimId => claimed
    mapping(bytes32 => bool) public hasClaimed;

    // Daily limits: user => day => points claimed
    mapping(address => mapping(uint256 => uint256)) public dailyClaimed;
    uint256 public constant MAX_DAILY_POINTS = 200;

    // ── Events ───────────────────────────────────────────────────────────────
    event RewardClaimed(
        address indexed user,
        uint256 points,
        uint256 usdcAmount,
        bytes32 claimId,
        uint256 timestamp
    );
    event TreasuryFunded(address indexed funder, uint256 amount, uint256 timestamp);
    event ConversionRateUpdated(uint256 oldRate, uint256 newRate);
    event Paused(address by);
    event Unpaused(address by);

    // ── Errors ────────────────────────────────────────────────────────────────
    error NotOwner();
    error ContractPaused();
    error AlreadyClaimed(bytes32 claimId);
    error InsufficientPoints(uint256 provided, uint256 minimum);
    error InsufficientTreasury(uint256 available, uint256 required);
    error DailyLimitExceeded(uint256 claimed, uint256 limit);
    error ZeroPoints();
    error TransferFailed();

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address _usdcToken) {
        owner = msg.sender;
        usdcToken = _usdcToken;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
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
     * @param points Number of points to redeem (minimum 100)
     * @param claimId Unique off-chain claim ID to prevent double-claims
     */
    function claimRewards(uint256 points, bytes32 claimId) external whenNotPaused returns (uint256 usdcAmount) {
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

    function fundTreasury(uint256 amount) external {
        // Anyone can fund the treasury by sending USDC
        // Caller must approve this contract first
        emit TreasuryFunded(msg.sender, amount, block.timestamp);
    }

    function setConversionRate(uint256 newRate) external onlyOwner {
        emit ConversionRateUpdated(usdcPerThousandPoints, newRate);
        usdcPerThousandPoints = newRate;
    }

    function pauseClaims() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpauseClaims() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }
}
