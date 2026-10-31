// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/*
 * MeshPortTokenRouter — gasless "Bring Funds" for EURC and cirBTC (any CCTPx
 * chain → Arc), the CCTPx counterpart of MeshPortBridgeRouter (USDC / CCTP).
 *
 * The user signs ONE off-chain authorization for `value` = amount + fee of
 * the token. MeshPort's relayer submits it here, paying the source-chain gas
 * AND Circle's CCTPx fee (native currency, sent as msg.value), and in that
 * one transaction the router:
 *   1. pulls `value` of the token from the user
 *   2. sends `fee` (in the token) to MeshPort's fee wallet - that is how the
 *      relayer's gas and Circle's fee are paid back
 *   3. sends the rest with Circle's CrossChainTokenService to `recipient` on
 *      the destination domain; Circle's forwarder delivers it there.
 * If any step fails the whole transaction reverts and nothing moves. The
 * router never keeps the user's tokens, allowances or native currency.
 *
 * Two ways to authorize the pull, whichever the token supports:
 *   · bridgeWithAuthorization - EIP-3009 ReceiveWithAuthorization (EURC, like
 *     USDC). The authorization's nonce IS bridgeNonce(params), exactly as in
 *     MeshPortBridgeRouter: any changed parameter gives a nonce the user
 *     didn't sign, and the token rejects it. `to == msg.sender` means it can
 *     only be used through this router.
 *   · bridgeWithPermit - EIP-2612 permit for the router plus the user's own
 *     EIP-712 signature over bridgeNonce(params), checked here. The permit
 *     alone can't be used for anything else: the router only ever pulls
 *     through this function, which needs the bridge signature too, and each
 *     bridge nonce works once.
 *
 * WHAT THE RELAYER CAN'T CHANGE
 * Token, token id, destination, recipient, fee, finality and salt are all in
 * bridgeNonce. The only unsigned inputs are Circle's signed fee quote and
 * msg.value: both concern Circle's fee, which the relayer pays - a bad quote
 * or too little value makes Circle's service revert, it can't touch the
 * user's tokens. Refunds of Circle's fee (if any) go to the relayer.
 *
 * SAME ADDRESS ON EVERY CHAIN: constructor args are Circle's CCTPx service
 * (one address on every EVM testnet) and MeshPort's fee wallet.
 *
 * No owner, no admin, no upgrade, no pause. Compiled for EVM "paris".
 */

interface IERC20Like {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

interface IERC3009 {
    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, uint8 v, bytes32 r, bytes32 s
    ) external;
}

interface IERC2612 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

interface ICrossChainTokenService {
    struct QuoteClaim {
        bytes signedQuote;
        address payable refundAddress;
    }
    function crossChainTransfer(
        bytes32 tokenId, uint256 amount, uint32 destinationDomain, bytes calldata destinationAddress,
        bytes32 destinationCaller, uint32 minFinalityThreshold, QuoteClaim calldata claim,
        bool autoExecuteHookData, bytes calldata hookData
    ) external payable;
    function resolveTokenManager(bytes32 tokenId) external view returns (address);
}

contract MeshPortTokenRouter {
    /// Domain separation for the parameter hash (the EIP-3009 nonce / what the bridge signature covers).
    bytes32 public constant TOKEN_BRIDGE_TYPEHASH = keccak256(
        "MeshPortTokenBridge(uint256 chainId,address router,address token,bytes32 tokenId,uint32 destinationDomain,address recipient,uint256 fee,uint32 minFinalityThreshold,bytes32 salt)"
    );
    /// What the user signs (EIP-712, this router's domain) on the permit path.
    bytes32 public constant BRIDGE_PERMIT_TYPEHASH = keccak256(
        "BridgePermit(address from,uint256 value,uint256 deadline,bytes32 nonce)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    ICrossChainTokenService public immutable service;
    address public immutable feeRecipient;

    /// Permit path: bridge nonces already used, per user.
    mapping(address => mapping(bytes32 => bool)) public usedNonce;

    struct TokenBridge {
        address token;                // the token on this chain
        bytes32 tokenId;              // its CCTPx token id (Circle's registry)
        uint32 destinationDomain;     // 26 = Arc
        address recipient;            // receives the token on the destination
        uint256 fee;                  // MeshPort fee, in the token (relayer gas + Circle's fee)
        uint32 minFinalityThreshold;  // 1000 = fast, 2000 = standard
        bytes32 salt;                 // makes every authorization unique
    }

    struct Authorization {            // EIP-3009
        address from;
        uint256 value;                // amount + fee
        uint256 validAfter;
        uint256 validBefore;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Permit {                   // EIP-2612 + the bridge signature
        address from;
        uint256 value;                // amount + fee
        uint256 deadline;
        uint8 v;   bytes32 r;   bytes32 s;    // permit(from, router, value, deadline)
        uint8 bv;  bytes32 br;  bytes32 bs;   // BridgePermit(from, value, deadline, bridgeNonce)
    }

    event TokenBridged(
        address indexed from, bytes32 indexed nonce, address indexed token, uint32 destinationDomain,
        address recipient, uint256 amount, uint256 fee
    );

    error ZeroAddress();
    error ZeroToken();
    error ZeroRecipient();
    error FeeTooHigh();
    error Expired();
    error BadSignature();
    error NonceUsed();
    error TransferFailed();
    error ApproveFailed();
    error FundsLeft();

    constructor(address service_, address feeRecipient_) {
        if (service_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        service = ICrossChainTokenService(service_);
        feeRecipient = feeRecipient_;
    }

    /// The nonce for these parameters (EIP-3009 nonce, or what the bridge signature covers).
    function bridgeNonce(TokenBridge calldata b) public view returns (bytes32) {
        return keccak256(abi.encode(
            TOKEN_BRIDGE_TYPEHASH, block.chainid, address(this), b.token, b.tokenId, b.destinationDomain,
            b.recipient, b.fee, b.minFinalityThreshold, b.salt
        ));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("MeshPortTokenRouter"), keccak256("1"), block.chainid, address(this)));
    }

    /// Never holds native currency: Circle refunds go to the relayer (refundAddress).
    receive() external payable { revert("MeshPortTokenRouter: no native token accepted"); }

    /// EIP-3009 path: pull, take the fee and send - one transaction. msg.value = Circle's native fee.
    function bridgeWithAuthorization(TokenBridge calldata b, Authorization calldata a, bytes calldata signedQuote)
        external payable returns (bytes32 nonce)
    {
        _check(b, a.value);
        nonce = bridgeNonce(b);
        uint256 before = IERC20Like(b.token).balanceOf(address(this));
        // Reverts unless `from` signed exactly this nonce / value / window.
        IERC3009(b.token).receiveWithAuthorization(a.from, address(this), a.value, a.validAfter, a.validBefore, nonce, a.v, a.r, a.s);
        _send(b, a.from, a.value, nonce, signedQuote, before);
    }

    /// EIP-2612 path: the permit lets the router pull; the bridge signature fixes what for.
    function bridgeWithPermit(TokenBridge calldata b, Permit calldata p, bytes calldata signedQuote)
        external payable returns (bytes32 nonce)
    {
        _check(b, p.value);
        if (block.timestamp > p.deadline) revert Expired();
        nonce = bridgeNonce(b);
        if (usedNonce[p.from][nonce]) revert NonceUsed();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(),
            keccak256(abi.encode(BRIDGE_PERMIT_TYPEHASH, p.from, p.value, p.deadline, nonce))));
        address signer = ecrecover(digest, p.bv, p.br, p.bs);
        if (signer == address(0) || signer != p.from) revert BadSignature();
        usedNonce[p.from][nonce] = true;
        // Someone may have submitted the permit already (it's public once
        // broadcast); the allowance is what matters, and transferFrom checks it.
        try IERC2612(b.token).permit(p.from, address(this), p.value, p.deadline, p.v, p.r, p.s) {} catch {}
        uint256 before = IERC20Like(b.token).balanceOf(address(this));
        if (!IERC20Like(b.token).transferFrom(p.from, address(this), p.value)) revert TransferFailed();
        _send(b, p.from, p.value, nonce, signedQuote, before);
    }

    function _check(TokenBridge calldata b, uint256 value) private pure {
        if (b.token == address(0)) revert ZeroToken();
        if (b.recipient == address(0)) revert ZeroRecipient();
        if (b.fee >= value) revert FeeTooHigh();
    }

    function _send(TokenBridge calldata b, address from, uint256 value, bytes32 nonce, bytes calldata signedQuote, uint256 before) private {
        uint256 amount = value - b.fee;
        // MeshPort's fee, in the same transaction.
        if (b.fee > 0 && !IERC20Like(b.token).transfer(feeRecipient, b.fee)) revert TransferFailed();
        _crossChain(b, amount, signedQuote);
        // Everything pulled went out: the fee and the transfer. (Compared with
        // the balance before the pull, so tokens sent here by mistake can't
        // block the router.)
        if (IERC20Like(b.token).balanceOf(address(this)) != before) revert FundsLeft();
        emit TokenBridged(from, nonce, b.token, b.destinationDomain, b.recipient, amount, b.fee);
    }

    /// Circle's TokenManager for the token pulls `amount` during crossChainTransfer; msg.value pays Circle's fee.
    function _crossChain(TokenBridge calldata b, uint256 amount, bytes calldata signedQuote) private {
        IERC20Like token = IERC20Like(b.token);
        address manager = service.resolveTokenManager(b.tokenId);
        if (manager == address(0)) revert ZeroAddress();
        if (!token.approve(manager, 0)) revert ApproveFailed();
        if (!token.approve(manager, amount)) revert ApproveFailed();
        ICrossChainTokenService.QuoteClaim memory claim = ICrossChainTokenService.QuoteClaim(signedQuote, payable(msg.sender));
        service.crossChainTransfer{value: msg.value}(
            b.tokenId, amount, b.destinationDomain, abi.encodePacked(b.recipient), bytes32(0),
            b.minFinalityThreshold, claim, false, ""
        );
        if (!token.approve(manager, 0)) revert ApproveFailed();
    }
}
