// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title MeshPortNames
 * @notice On-chain registry of MeshPort usernames ("name.arc").
 *         A MeshPort registrar wallet submits every write; user-owned
 *         mutations require an EIP-712 signature from the account so the
 *         registrar cannot act without user consent.
 */
contract MeshPortNames is Ownable2Step, EIP712, Pausable {
    // ─── Types ────────────────────────────────────────────────────────────────

    enum Kind { Personal, Business }

    struct Record {
        address  owner;
        Kind     kind;
        bool     verified;
        uint64   registeredAt;
        string   displayName;
    }

    // ─── EIP-712 type hashes ──────────────────────────────────────────────────

    bytes32 private constant REGISTER_TYPEHASH = keccak256(
        "Register(string name,address account,uint8 kind,string displayName,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant SET_DISPLAY_NAME_TYPEHASH = keccak256(
        "SetDisplayName(string name,string displayName,uint256 nonce,uint256 deadline)"
    );

    // ─── Storage ──────────────────────────────────────────────────────────────

    /// node  → Record
    mapping(bytes32 => Record) private _records;
    /// node  → plain name string
    mapping(bytes32 => string)  private _names;
    /// node  → reserved flag
    mapping(bytes32 => bool)    private _reserved;
    /// account → node (so each wallet can own at most one name)
    mapping(address => bytes32) private _nodeOf;
    /// account → EIP-712 nonce
    mapping(address => uint256) public  nonces;
    /// registrar whitelist
    mapping(address => bool)    public  registrars;

    bool public migrationOpen = true;

    // ─── Errors ───────────────────────────────────────────────────────────────

    error InvalidName();
    error NameTaken();
    error NameReserved();
    error AlreadyHasName();
    error NotRegistrar();
    error DeadlineExpired();
    error BadSignature();
    error MigrationNotOpen();
    error MigrationArityMismatch();
    error NoSuchName();
    error DisplayNameTooLong();
    error NotNameOwner();

    // ─── Events ───────────────────────────────────────────────────────────────

    event NameRegistered(
        bytes32 indexed node,
        string  name,
        address indexed account,
        Kind    kind,
        string  displayName
    );
    event DisplayNameChanged(bytes32 indexed node, string displayName);
    event BusinessStatusChanged(bytes32 indexed node, Kind kind, bool verified);
    event NameRevoked(bytes32 indexed node, string name, address indexed account);
    event RegistrarSet(address indexed registrar, bool enabled);
    event Reserved(bytes32 indexed node, bool reserved);
    event MigrationClosed();

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyRegistrar() {
        if (!registrars[msg.sender]) revert NotRegistrar();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address initialOwner, address initialRegistrar)
        Ownable(initialOwner)
        EIP712("MeshPortNames", "1")
    {
        registrars[initialRegistrar] = true;
        emit RegistrarSet(initialRegistrar, true);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setRegistrar(address registrar, bool enabled) external onlyOwner {
        registrars[registrar] = enabled;
        emit RegistrarSet(registrar, enabled);
    }

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function setReserved(string[] calldata names, bool reserved) external onlyOwner {
        for (uint256 i; i < names.length; ) {
            bytes32 node = _node(names[i]);
            _reserved[node] = reserved;
            emit Reserved(node, reserved);
            unchecked { ++i; }
        }
    }

    function revoke(string calldata name) external onlyOwner {
        bytes32 node = _node(name);
        Record storage rec = _records[node];
        if (rec.owner == address(0)) revert NoSuchName();
        address prev = rec.owner;
        delete _nodeOf[prev];
        delete _records[node];
        delete _names[node];
        emit NameRevoked(node, name, prev);
    }

    // ─── Migration ────────────────────────────────────────────────────────────

    function migrate(
        string[]  calldata names_,
        address[] calldata accounts,
        Kind[]    calldata kinds,
        string[]  calldata displayNames,
        bool[]    calldata verified_
    ) external onlyOwner {
        if (!migrationOpen) revert MigrationNotOpen();
        uint256 len = names_.length;
        if (
            accounts.length != len ||
            kinds.length    != len ||
            displayNames.length != len ||
            verified_.length    != len
        ) revert MigrationArityMismatch();

        for (uint256 i; i < len; ) {
            _register(names_[i], accounts[i], kinds[i], displayNames[i], verified_[i]);
            unchecked { ++i; }
        }
    }

    function closeMigration() external onlyOwner {
        migrationOpen = false;
        emit MigrationClosed();
    }

    // ─── Registration ─────────────────────────────────────────────────────────

    /**
     * @notice Register a name on behalf of `account`.
     *         Requires `account`'s EIP-712 signature so the registrar
     *         cannot act without user consent.
     */
    function register(
        string   calldata name,
        address  account,
        Kind     kind,
        string   calldata displayName,
        uint256  deadline,
        bytes    calldata signature
    ) external onlyRegistrar whenNotPaused {
        if (block.timestamp > deadline) revert DeadlineExpired();
        _verifyRegister(name, account, kind, displayName, deadline, signature);
        _register(name, account, kind, displayName, false);
    }

    /// @dev Split out to avoid stack-too-deep in `register`.
    function _verifyRegister(
        string   calldata name,
        address  account,
        Kind     kind,
        string   calldata displayName,
        uint256  deadline,
        bytes    calldata signature
    ) private {
        uint256 nonce = nonces[account];
        bytes32 digest = hashRegister(name, account, kind, displayName, nonce, deadline);
        if (!SignatureChecker.isValidSignatureNow(account, digest, signature)) revert BadSignature();
        unchecked { nonces[account]++; }
    }

    // ─── Display name ─────────────────────────────────────────────────────────

    /**
     * @notice Update the display name.
     *         If called by the name's owner directly, no signature needed.
     *         If called by a registrar, the owner's EIP-712 signature is required.
     */
    function setDisplayName(
        string   calldata name,
        string   calldata displayName,
        uint256  deadline,
        bytes    calldata signature
    ) external {
        bytes32 node = _node(name);
        Record storage rec = _records[node];
        if (rec.owner == address(0)) revert NoSuchName();
        if (bytes(displayName).length > 64) revert DisplayNameTooLong();

        if (msg.sender == rec.owner) {
            // owner calls directly — no signature needed
        } else if (registrars[msg.sender]) {
            if (block.timestamp > deadline) revert DeadlineExpired();
            bytes32 digest = hashSetDisplayName(name, displayName, nonces[rec.owner], deadline);
            if (!SignatureChecker.isValidSignatureNow(rec.owner, digest, signature)) revert BadSignature();
            unchecked { nonces[rec.owner]++; }
        } else {
            revert NotNameOwner();
        }

        rec.displayName = displayName;
        emit DisplayNameChanged(node, displayName);
    }

    // ─── Business status ──────────────────────────────────────────────────────

    /**
     * @notice Set Kind and verified flag.  Used by MeshPort after its
     *         off-chain merchant review — no user signature needed because
     *         the user already applied through the app.
     */
    function setBusiness(
        string calldata name,
        Kind   kind,
        bool   verified_
    ) external onlyRegistrar {
        bytes32 node = _node(name);
        Record storage rec = _records[node];
        if (rec.owner == address(0)) revert NoSuchName();
        rec.kind     = kind;
        rec.verified = verified_;
        emit BusinessStatusChanged(node, kind, verified_);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function resolve(string calldata name) external view returns (address) {
        return _records[_node(name)].owner;
    }

    function nameOf(address account) external view returns (string memory) {
        return _names[_nodeOf[account]];
    }

    function recordOf(string calldata name) external view returns (Record memory) {
        return _records[_node(name)];
    }

    function isAvailable(string calldata name) external view returns (bool) {
        if (!isValidName(name)) return false;
        bytes32 node = _node(name);
        return !_reserved[node] && _records[node].owner == address(0);
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─── EIP-712 hash helpers ─────────────────────────────────────────────────

    function hashRegister(
        string   calldata name,
        address  account,
        Kind     kind,
        string   calldata displayName,
        uint256  nonce,
        uint256  deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            REGISTER_TYPEHASH,
            keccak256(bytes(name)),
            account,
            uint8(kind),
            keccak256(bytes(displayName)),
            nonce,
            deadline
        )));
    }

    function hashSetDisplayName(
        string  calldata name,
        string  calldata displayName,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            SET_DISPLAY_NAME_TYPEHASH,
            keccak256(bytes(name)),
            keccak256(bytes(displayName)),
            nonce,
            deadline
        )));
    }

    // ─── Name validation ──────────────────────────────────────────────────────

    /**
     * @notice Returns true when `name` is 3-20 bytes, only a-z / 0-9 / underscore.
     */
    function isValidName(string calldata name) public pure returns (bool) {
        bytes memory b = bytes(name);
        uint256 len = b.length;
        if (len < 3 || len > 20) return false;
        for (uint256 i; i < len; ) {
            bytes1 c = b[i];
            bool ok = (c >= 0x61 && c <= 0x7a)   // a-z
                   || (c >= 0x30 && c <= 0x39)    // 0-9
                   || (c == 0x5f);                // _
            if (!ok) return false;
            unchecked { ++i; }
        }
        return true;
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    /// @dev Returns the storage key for a name.
    function _node(string calldata name) internal pure returns (bytes32) {
        return keccak256(bytes(name));
    }

    /// @dev Returns the storage key for a name already stored as memory.
    function _nodeM(string memory name) internal pure returns (bytes32) {
        return keccak256(bytes(name));
    }

    /// @dev Core registration logic shared by `register` and `migrate`.
    function _register(
        string  memory name,
        address account,
        Kind    kind,
        string  memory displayName,
        bool    verified_
    ) internal {
        if (!_isValidNameMemory(name))         revert InvalidName();
        bytes32 node = _nodeM(name);
        if (_reserved[node])                   revert NameReserved();
        if (_records[node].owner != address(0)) revert NameTaken();
        if (_nodeOf[account] != bytes32(0))    revert AlreadyHasName();
        if (bytes(displayName).length > 64)    revert DisplayNameTooLong();

        _records[node] = Record({
            owner:        account,
            kind:         kind,
            verified:     verified_,
            registeredAt: uint64(block.timestamp),
            displayName:  displayName
        });
        _names[node]   = name;
        _nodeOf[account] = node;

        emit NameRegistered(node, name, account, kind, displayName);
    }

    /// @dev Same logic as `isValidName` but operates on a memory string.
    function _isValidNameMemory(string memory name) internal pure returns (bool) {
        bytes memory b = bytes(name);
        uint256 len = b.length;
        if (len < 3 || len > 20) return false;
        for (uint256 i; i < len; ) {
            bytes1 c = b[i];
            bool ok = (c >= 0x61 && c <= 0x7a)
                   || (c >= 0x30 && c <= 0x39)
                   || (c == 0x5f);
            if (!ok) return false;
            unchecked { ++i; }
        }
        return true;
    }
}
