// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/*
 * MeshPortRouter — gasless "Bring Funds" to Arc for USDC, EURC and cirBTC in
 * ONE transaction, with MeshPort's fee taken inside that same transaction.
 * One contract, one address on every chain (CREATE2).
 *
 * The user signs ONE off-chain authorization for `value` = amount + fee.
 * Anyone — normally MeshPort's relayer, which pays the source-chain gas —
 * submits it here, and in that one transaction the router pulls `value`,
 * sends `fee` to MeshPort's fee wallet, and sends the rest to the recipient
 * on the destination chain:
 *
 *   USDC   bridgeWithAuthorization       Circle CCTP V2: depositForBurn(WithHook)
 *          (EIP-3009)                    on TokenMessengerV2; Circle's fee comes
 *                                        out of the burn on mint (maxFee).
 *   EURC / tokenBridgeWithAuthorization  Circle CCTPx: crossChainTransfer on the
 *   cirBTC (EIP-3009)                    CrossChainTokenService. Circle's fee is
 *          tokenBridgeWithPermit         native currency, paid by the submitter
 *          (EIP-2612 + bridge signature) as msg.value; MeshPort's fee (in the
 *                                        token) pays it back.
 *
 * If any step fails the whole transaction reverts and nothing moves. The
 * router never keeps the user's tokens, allowances or native currency.
 *
 * WHY THE SUBMITTER CAN'T CHANGE ANYTHING
 * Every parameter (token, destination, recipient, fees, finality, hook data /
 * token id, salt) goes into a nonce - bridgeNonce / tokenBridgeNonce - that
 * includes this chain and this router. On the EIP-3009 paths that hash IS the
 * authorization's nonce, so any changed parameter gives a nonce the user
 * didn't sign and the token rejects it; EIP-3009 also requires `to ==
 * msg.sender`, so the authorization only works through this router. On the
 * permit path the user signs the same hash (BridgePermit, this router's
 * EIP-712 domain), checked here, and each one works once. The token is a
 * signed parameter checked by that token's own EIP-712 domain, so a signature
 * only ever moves the token the user signed for.
 *
 * The only unsigned inputs (CCTPx) are Circle's signed fee quote and
 * msg.value: both concern Circle's fee, which the submitter pays - a bad
 * quote or too little value makes Circle's service revert; it can't touch
 * the user's tokens. Circle's refunds (if any) go to the submitter.
 *
 * SAME ADDRESS ON EVERY CHAIN: the constructor args - Circle's
 * TokenMessengerV2 and CCTPx service (one testnet address each) and MeshPort's
 * fee wallet - are the same everywhere, so CREATE2 lands on one address. On a
 * chain without CCTPx the token functions simply revert.
 *
 * No owner, no admin, no upgrade, no pause: nothing to compromise.
 * Compiled for EVM "paris" (see hardhat.config.cjs).
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

contract MeshPortRouter {
    // ── Typehashes ──────────────────────────────────────────────────────────
    /// USDC: domain separation for the parameter hash used as the EIP-3009 nonce.
    bytes32 public constant BRIDGE_TYPEHASH = keccak256(
        "MeshPortBridge(uint256 chainId,address router,address token,uint32 destinationDomain,bytes32 mintRecipient,uint256 fee,uint256 maxFee,uint32 minFinalityThreshold,bytes32 hookDataHash,bytes32 salt)"
    );
    /// EURC / cirBTC: the same, for CCTPx parameters.
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

    ITokenMessengerV2 public immutable tokenMessenger;
    ICrossChainTokenService public immutable service;
    address public immutable feeRecipient;

    /// Permit path: bridge nonces already used, per user.
    mapping(address => mapping(bytes32 => bool)) public usedNonce;

    // ── Parameters ──────────────────────────────────────────────────────────
    struct Bridge {                   // USDC over CCTP
        address token;                // Circle's USDC on this chain (EIP-3009)
        uint32 destinationDomain;     // e.g. 26 = Arc
        bytes32 mintRecipient;        // recipient on the destination, left-padded
        uint256 fee;                  // MeshPort fee (relayer gas etc.), paid here in USDC
        uint256 maxFee;               // CCTP V2 maxFee (protocol + forwarding), taken from the burn on mint
        uint32 minFinalityThreshold;  // 1000 = fast, 2000 = standard
        bytes hookData;               // empty, or Circle's forwarding hook
        bytes32 salt;                 // makes every authorization unique
    }

    struct TokenBridge {              // EURC / cirBTC over CCTPx
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
        uint8 bv;  bytes32 br;  bytes32 bs;   // BridgePermit(from, value, deadline, tokenBridgeNonce)
    }

    event Bridged(
        address indexed from, bytes32 indexed nonce, uint32 destinationDomain,
        bytes32 mintRecipient, uint256 amount, uint256 fee, uint256 maxFee
    );
    event TokenBridged(
        address indexed from, bytes32 indexed nonce, address indexed token, uint32 destinationDomain,
        address recipient, uint256 amount, uint256 fee
    );

    error ZeroAddress();
    error ZeroToken();
    error ZeroRecipient();
    error FeeTooHigh();
    error MaxFeeTooHigh();
    error Expired();
    error BadSignature();
    error NonceUsed();
    error TransferFailed();
    error ApproveFailed();
    error FundsLeft();

    constructor(address tokenMessenger_, address service_, address feeRecipient_) {
        if (tokenMessenger_ == address(0) || service_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        tokenMessenger = ITokenMessengerV2(tokenMessenger_);
        service = ICrossChainTokenService(service_);
        feeRecipient = feeRecipient_;
    }

    /// Never holds native currency: Circle's CCTPx refunds go to the submitter.
    receive() external payable { revert("MeshPortRouter: no native token accepted"); }

    // ── USDC (CCTP) ─────────────────────────────────────────────────────────

    /// The EIP-3009 nonce the user must sign for these USDC parameters.
    function bridgeNonce(Bridge calldata b) public view returns (bytes32) {
        return keccak256(abi.encode(
            BRIDGE_TYPEHASH, block.chainid, address(this), b.token, b.destinationDomain, b.mintRecipient,
            b.fee, b.maxFee, b.minFinalityThreshold, keccak256(b.hookData), b.salt
        ));
    }

    /// Pull, take the fee and burn — all in this one transaction.
    function bridgeWithAuthorization(Bridge calldata b, Authorization calldata a) external returns (bytes32 nonce) {
        if (b.token == address(0)) revert ZeroToken();
        if (b.mintRecipient == bytes32(0)) revert ZeroRecipient();
        if (b.fee >= a.value) revert FeeTooHigh();
        uint256 amount = a.value - b.fee;
        // CCTP V2 requires maxFee < amount (the fee is taken from the burn on mint).
        if (b.maxFee >= amount) revert MaxFeeTooHigh();

        nonce = bridgeNonce(b);
        IERC20Like usdc = IERC20Like(b.token);

        // 1. Pull amount + fee. Reverts unless `from` signed exactly this nonce/value/window.
        IERC3009(b.token).receiveWithAuthorization(a.from, address(this), a.value, a.validAfter, a.validBefore, nonce, a.v, a.r, a.s);

        // 2. MeshPort's fee, in the same transaction.
        if (b.fee > 0 && !usdc.transfer(feeRecipient, b.fee)) revert TransferFailed();

        // 3. Burn the rest to the recipient on the destination chain (allowance
        //    reset to 0 before and after, so none is ever left behind).
        if (!usdc.approve(address(tokenMessenger), 0)) revert ApproveFailed();
        if (!usdc.approve(address(tokenMessenger), amount)) revert ApproveFailed();
        if (b.hookData.length > 0) {
            tokenMessenger.depositForBurnWithHook(
                amount, b.destinationDomain, b.mintRecipient, b.token, bytes32(0),
                b.maxFee, b.minFinalityThreshold, b.hookData
            );
        } else {
            tokenMessenger.depositForBurn(
                amount, b.destinationDomain, b.mintRecipient, b.token, bytes32(0),
                b.maxFee, b.minFinalityThreshold
            );
        }
        if (!usdc.approve(address(tokenMessenger), 0)) revert ApproveFailed();

        emit Bridged(a.from, nonce, b.destinationDomain, b.mintRecipient, amount, b.fee, b.maxFee);
    }

    // ── Express Bring (USDC, to the owner's OWN Arc wallet) ────────────────
    // Set up once per chain with two of the owner's signatures: USDC's own
    // EIP-2612 permit (the router may pull up to the Express limit) and
    // setBringKey (a key held in MeshPort's wallet frame may ask for Brings
    // until `expiry`). After that each Bring is signed by that key alone -
    // after the owner's passcode, checked in the frame - and the relayer
    // submits it. What the key can do is fixed HERE, whatever it signs:
    //   - only to Arc (domain 26), only to the owner's own address there;
    //   - MeshPort's fee at most 5% + 0.1 USDC of the amount;
    //   - each signed Bring works once, until its deadline.
    // So a leaked key could at most move the owner's USDC to the owner's own
    // Arc wallet. The owner ends it any time with a new setBringKey (key 0),
    // or by lowering USDC's allowance to the router.
    uint32 public constant ARC_DOMAIN = 26;
    bytes32 public constant SET_BRING_KEY_TYPEHASH = keccak256(
        "SetBringKey(address owner,address key,uint64 expiry,uint256 nonce)"
    );
    bytes32 public constant EXPRESS_BRING_TYPEHASH = keccak256(
        "ExpressBring(address owner,address token,uint256 amount,uint256 fee,uint256 maxFee,uint32 minFinalityThreshold,bytes32 hookDataHash,bytes32 salt,uint256 deadline)"
    );

    struct BringKey { address key; uint64 expiry; }
    /// The owner's current Express Bring key on this chain, and the nonce its next setBringKey signs.
    mapping(address => BringKey) public bringKeys;
    mapping(address => uint256) public bringKeyNonces;

    struct ExpressBringArgs {
        address owner;                // whose USDC, and who receives it on Arc
        address token;                // USDC on this chain
        uint256 amount;               // burned to the owner on Arc
        uint256 fee;                  // MeshPort fee (relayer gas etc.), on top of amount
        uint256 maxFee;               // CCTP V2 maxFee, taken from the burn on mint
        uint32 minFinalityThreshold;  // 1000 = fast, 2000 = standard
        bytes hookData;               // empty (relayer mints) or Circle's forwarding hook
        bytes32 salt;                 // makes every Bring unique
        uint256 deadline;             // the key's signature is valid until then
    }

    event BringKeySet(address indexed owner, address indexed key, uint64 expiry);
    event ExpressBridged(address indexed owner, bytes32 indexed digest, uint256 amount, uint256 fee, uint256 maxFee);

    function _typed(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// An EOA's signature (65 bytes, low s), or an ERC-1271 wallet's.
    function _isValidSig(address signer, bytes32 digest, bytes calldata sig) private view returns (bool) {
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) = signer.staticcall(abi.encodeWithSelector(0x1626ba7e, digest, sig));
            return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == 0x1626ba7e;
        }
        if (sig.length != 65) return false;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 sv = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (uint256(sv) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return false;
        address got = ecrecover(digest, v, r, sv);
        return got != address(0) && got == signer;
    }

    /// The digest the owner signs to set (or, key 0, end) their Bring key.
    function setBringKeyDigest(address owner, address key, uint64 expiry) public view returns (bytes32) {
        return _typed(keccak256(abi.encode(SET_BRING_KEY_TYPEHASH, owner, key, expiry, bringKeyNonces[owner])));
    }

    /// Set (or end, with key 0) the owner's Bring key. Anyone may submit the owner's signature.
    function setBringKey(address owner, address key, uint64 expiry, bytes calldata sig) external {
        if (owner == address(0)) revert ZeroAddress();
        if (!_isValidSig(owner, setBringKeyDigest(owner, key, expiry), sig)) revert BadSignature();
        bringKeyNonces[owner]++;
        bringKeys[owner] = BringKey(key, expiry);
        emit BringKeySet(owner, key, expiry);
    }

    /// The digest the Bring key signs for these parameters.
    function expressBringDigest(ExpressBringArgs calldata b) public view returns (bytes32) {
        return _typed(keccak256(abi.encode(
            EXPRESS_BRING_TYPEHASH, b.owner, b.token, b.amount, b.fee, b.maxFee,
            b.minFinalityThreshold, keccak256(b.hookData), b.salt, b.deadline
        )));
    }

    /// A Bring signed by the owner's Bring key: pull (EIP-2612 allowance), fee, burn to the owner on Arc.
    function expressBring(ExpressBringArgs calldata b, bytes calldata keySig) external returns (bytes32 digest) {
        if (b.token == address(0)) revert ZeroToken();
        BringKey memory k = bringKeys[b.owner];
        if (k.key == address(0) || block.timestamp > k.expiry || block.timestamp > b.deadline) revert Expired();
        if (b.fee > b.amount / 20 + 100_000) revert FeeTooHigh();
        if (b.maxFee >= b.amount) revert MaxFeeTooHigh();
        digest = expressBringDigest(b);
        if (usedNonce[b.owner][digest]) revert NonceUsed();
        usedNonce[b.owner][digest] = true;
        if (!_isValidSig(k.key, digest, keySig)) revert BadSignature();

        IERC20Like usdc = IERC20Like(b.token);
        if (!usdc.transferFrom(b.owner, address(this), b.amount + b.fee)) revert TransferFailed();
        if (b.fee > 0 && !usdc.transfer(feeRecipient, b.fee)) revert TransferFailed();
        bytes32 mintRecipient = bytes32(uint256(uint160(b.owner)));
        if (!usdc.approve(address(tokenMessenger), 0)) revert ApproveFailed();
        if (!usdc.approve(address(tokenMessenger), b.amount)) revert ApproveFailed();
        if (b.hookData.length > 0) {
            tokenMessenger.depositForBurnWithHook(b.amount, ARC_DOMAIN, mintRecipient, b.token, bytes32(0), b.maxFee, b.minFinalityThreshold, b.hookData);
        } else {
            tokenMessenger.depositForBurn(b.amount, ARC_DOMAIN, mintRecipient, b.token, bytes32(0), b.maxFee, b.minFinalityThreshold);
        }
        if (!usdc.approve(address(tokenMessenger), 0)) revert ApproveFailed();
        emit ExpressBridged(b.owner, digest, b.amount, b.fee, b.maxFee);
    }

    // ── EURC / cirBTC (CCTPx) ───────────────────────────────────────────────

    /// The nonce for these token parameters (EIP-3009 nonce, or what the bridge signature covers).
    function tokenBridgeNonce(TokenBridge calldata b) public view returns (bytes32) {
        return keccak256(abi.encode(
            TOKEN_BRIDGE_TYPEHASH, block.chainid, address(this), b.token, b.tokenId, b.destinationDomain,
            b.recipient, b.fee, b.minFinalityThreshold, b.salt
        ));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("MeshPortRouter"), keccak256("1"), block.chainid, address(this)));
    }

    /// EIP-3009 path: pull, take the fee and send - one transaction. msg.value = Circle's native fee.
    function tokenBridgeWithAuthorization(TokenBridge calldata b, Authorization calldata a, bytes calldata signedQuote)
        external payable returns (bytes32 nonce)
    {
        _check(b, a.value);
        nonce = tokenBridgeNonce(b);
        uint256 before = IERC20Like(b.token).balanceOf(address(this));
        // Reverts unless `from` signed exactly this nonce / value / window.
        IERC3009(b.token).receiveWithAuthorization(a.from, address(this), a.value, a.validAfter, a.validBefore, nonce, a.v, a.r, a.s);
        _send(b, a.from, a.value, nonce, signedQuote, before);
    }

    /// EIP-2612 path: the permit lets the router pull; the bridge signature fixes what for.
    function tokenBridgeWithPermit(TokenBridge calldata b, Permit calldata p, bytes calldata signedQuote)
        external payable returns (bytes32 nonce)
    {
        _check(b, p.value);
        if (block.timestamp > p.deadline) revert Expired();
        nonce = tokenBridgeNonce(b);
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
