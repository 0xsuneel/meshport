// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/*
 * MeshPortBridgeRouter — gasless "Bring Funds" (any CCTP chain → Arc) in ONE
 * transaction, with MeshPort's fee taken inside that same transaction.
 *
 * The user signs a single off-chain USDC authorization (EIP-3009
 * ReceiveWithAuthorization) for `value` = amount + fee. Anyone — normally
 * MeshPort's relayer, which pays the source-chain gas — submits it here, and
 * in that one transaction the router:
 *   1. pulls `value` USDC from the user        (USDC.receiveWithAuthorization)
 *   2. sends `fee` to MeshPort's fee wallet    (stays on this chain, no second burn)
 *   3. burns the rest with CCTP V2 to `mintRecipient` on the destination,
 *      optionally with Circle's Forwarding Service hook so Circle mints there.
 * If any step fails the whole transaction reverts and nothing moves. The
 * router never keeps funds or allowances between transactions.
 *
 * WHY THE RELAYER CAN'T CHANGE ANYTHING
 * The authorization's `nonce` is not random: it is bridgeNonce(...) — a hash
 * of this chain, this router and every bridge parameter (destination domain,
 * recipient, fee, CCTP maxFee, finality, hook data, salt). The router
 * recomputes it from the parameters it is given and passes THAT to USDC, so
 * submitting any parameter other than the ones the user signed produces a
 * nonce the signature doesn't cover and USDC rejects it. EIP-3009 also
 * requires `to == msg.sender` for receiveWithAuthorization, so the signed
 * authorization can only ever be used through this router, and each nonce
 * only once.
 *
 * No owner, no admin, no upgrade, no pause: nothing to compromise.
 * Compiled for EVM "paris" (see hardhat.config.cjs).
 */

interface IUSDC3009 {
    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, uint8 v, bytes32 r, bytes32 s
    ) external;
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken,
        bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold
    ) external;
    function depositForBurnWithHook(
        uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken,
        bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes calldata hookData
    ) external;
}

contract MeshPortBridgeRouter {
    /// Domain separation for the parameter hash used as the EIP-3009 nonce.
    bytes32 public constant BRIDGE_TYPEHASH = keccak256(
        "MeshPortBridge(uint256 chainId,address router,uint32 destinationDomain,bytes32 mintRecipient,uint256 fee,uint256 maxFee,uint32 minFinalityThreshold,bytes32 hookDataHash,bytes32 salt)"
    );

    IUSDC3009 public immutable usdc;
    ITokenMessengerV2 public immutable tokenMessenger;
    address public immutable feeRecipient;

    struct Bridge {
        uint32 destinationDomain;     // e.g. 26 = Arc
        bytes32 mintRecipient;        // recipient on the destination, left-padded
        uint256 fee;                  // MeshPort fee (relayer gas etc.), paid here in USDC
        uint256 maxFee;               // CCTP V2 maxFee (protocol + forwarding), taken from the burn on mint
        uint32 minFinalityThreshold;  // 1000 = fast, 2000 = standard
        bytes hookData;               // empty, or Circle's forwarding hook
        bytes32 salt;                 // makes every authorization unique
    }

    struct Authorization {
        address from;
        uint256 value;                // amount + fee
        uint256 validAfter;
        uint256 validBefore;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    event Bridged(
        address indexed from, bytes32 indexed nonce, uint32 destinationDomain,
        bytes32 mintRecipient, uint256 amount, uint256 fee, uint256 maxFee
    );

    error ZeroAddress();
    error FeeTooHigh();
    error MaxFeeTooHigh();
    error ZeroRecipient();
    error TransferFailed();
    error ApproveFailed();

    constructor(address usdc_, address tokenMessenger_, address feeRecipient_) {
        if (usdc_ == address(0) || tokenMessenger_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        usdc = IUSDC3009(usdc_);
        tokenMessenger = ITokenMessengerV2(tokenMessenger_);
        feeRecipient = feeRecipient_;
    }

    /// The EIP-3009 nonce the user must sign for these parameters.
    function bridgeNonce(Bridge calldata b) public view returns (bytes32) {
        return keccak256(abi.encode(
            BRIDGE_TYPEHASH, block.chainid, address(this), b.destinationDomain, b.mintRecipient,
            b.fee, b.maxFee, b.minFinalityThreshold, keccak256(b.hookData), b.salt
        ));
    }

    /// Pull, take the fee and burn — all in this one transaction.
    function bridgeWithAuthorization(Bridge calldata b, Authorization calldata a) external returns (bytes32 nonce) {
        if (b.mintRecipient == bytes32(0)) revert ZeroRecipient();
        if (b.fee >= a.value) revert FeeTooHigh();
        uint256 amount = a.value - b.fee;
        // CCTP V2 requires maxFee < amount (the fee is taken from the burn on mint).
        if (b.maxFee >= amount) revert MaxFeeTooHigh();

        nonce = bridgeNonce(b);

        // 1. Pull amount + fee. Reverts unless `from` signed exactly this nonce/value/window.
        usdc.receiveWithAuthorization(a.from, address(this), a.value, a.validAfter, a.validBefore, nonce, a.v, a.r, a.s);

        // 2. MeshPort's fee, in the same transaction.
        if (b.fee > 0 && !usdc.transfer(feeRecipient, b.fee)) revert TransferFailed();

        // 3. Burn the rest to the recipient on the destination chain.
        if (!usdc.approve(address(tokenMessenger), amount)) revert ApproveFailed();
        if (b.hookData.length > 0) {
            tokenMessenger.depositForBurnWithHook(
                amount, b.destinationDomain, b.mintRecipient, address(usdc), bytes32(0),
                b.maxFee, b.minFinalityThreshold, b.hookData
            );
        } else {
            tokenMessenger.depositForBurn(
                amount, b.destinationDomain, b.mintRecipient, address(usdc), bytes32(0),
                b.maxFee, b.minFinalityThreshold
            );
        }

        emit Bridged(a.from, nonce, b.destinationDomain, b.mintRecipient, amount, b.fee, b.maxFee);
    }
}
