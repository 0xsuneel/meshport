// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MeshPortNames.sol";

contract MeshPortNamesTest is Test {
    // ── Actors ────────────────────────────────────────────────────────────────
    address owner;
    uint256 ownerKey;

    address registrar;
    uint256 registrarKey;

    address alice;
    uint256 aliceKey;

    address bob;
    uint256 bobKey;

    address stranger;

    MeshPortNames registry;

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        (owner,     ownerKey)     = makeAddrAndKey("owner");
        (registrar, registrarKey) = makeAddrAndKey("registrar");
        (alice,     aliceKey)     = makeAddrAndKey("alice");
        (bob,       bobKey)       = makeAddrAndKey("bob");
        stranger = makeAddr("stranger");

        vm.prank(owner);
        registry = new MeshPortNames(owner, registrar);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    /// Sign the Register digest for `account` using `key`.
    function _signRegister(
        string memory name,
        address account,
        MeshPortNames.Kind kind,
        string memory displayName,
        uint256 nonce,
        uint256 deadline,
        uint256 key
    ) internal view returns (bytes memory) {
        bytes32 digest = registry.hashRegister(name, account, kind, displayName, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Sign the SetDisplayName digest for the name owner using `key`.
    function _signSetDisplayName(
        string memory name,
        string memory displayName,
        uint256 nonce,
        uint256 deadline,
        uint256 key
    ) internal view returns (bytes memory) {
        bytes32 digest = registry.hashSetDisplayName(name, displayName, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Register alice's name with a valid signature; helper used across tests.
    function _registerAlice(string memory name) internal {
        uint256 dl = _deadline();
        bytes memory sig = _signRegister(
            name, alice, MeshPortNames.Kind.Personal, "", registry.nonces(alice), dl, aliceKey
        );
        vm.prank(registrar);
        registry.register(name, alice, MeshPortNames.Kind.Personal, "", dl, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Name validation
    // ═══════════════════════════════════════════════════════════════════════════

    function test_isValidName_happyPath() public view {
        assertTrue(registry.isValidName("alice"));
        assertTrue(registry.isValidName("abc"));                  // min 3
        assertTrue(registry.isValidName("abcdefghij1234567890")); // max 20 chars
        assertTrue(registry.isValidName("user_123"));
        assertTrue(registry.isValidName("sharma_chai_corner"));
    }

    function test_isValidName_tooShort() public view {
        assertFalse(registry.isValidName("ab"));
        assertFalse(registry.isValidName("a"));
        assertFalse(registry.isValidName(""));
    }

    function test_isValidName_tooLong() public view {
        assertFalse(registry.isValidName("abcdefghijklmnopqrstu")); // 21 chars
    }

    function test_isValidName_uppercase() public view {
        assertFalse(registry.isValidName("Alice"));
        assertFalse(registry.isValidName("ALICE"));
    }

    function test_isValidName_dash() public view {
        assertFalse(registry.isValidName("ali-ce"));
    }

    function test_isValidName_space() public view {
        assertFalse(registry.isValidName("ali ce"));
    }

    function test_isValidName_unicode() public view {
        // "caf\xc3\xa9" contains a non-ASCII byte
        assertFalse(registry.isValidName(unicode"café"));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Happy-path registration
    // ═══════════════════════════════════════════════════════════════════════════

    function test_register_happyPath() public {
        uint256 dl = _deadline();
        bytes memory sig = _signRegister(
            "alice", alice, MeshPortNames.Kind.Personal, "Alice A.", registry.nonces(alice), dl, aliceKey
        );

        vm.expectEmit(true, true, false, true);
        emit MeshPortNames.NameRegistered(keccak256("alice"), "alice", alice, MeshPortNames.Kind.Personal, "Alice A.");

        vm.prank(registrar);
        registry.register("alice", alice, MeshPortNames.Kind.Personal, "Alice A.", dl, sig);

        // resolve / nameOf / recordOf
        assertEq(registry.resolve("alice"), alice);
        assertEq(registry.nameOf(alice), "alice");
        MeshPortNames.Record memory rec = registry.recordOf("alice");
        assertEq(rec.owner, alice);
        assertEq(uint8(rec.kind), uint8(MeshPortNames.Kind.Personal));
        assertFalse(rec.verified);
        assertEq(rec.displayName, "Alice A.");
        assertEq(rec.registeredAt, block.timestamp);

        // nonce incremented
        assertEq(registry.nonces(alice), 1);

        // no longer available
        assertFalse(registry.isAvailable("alice"));
    }

    function test_register_gasUsage() public {
        uint256 dl = _deadline();
        bytes memory sig = _signRegister(
            "alice", alice, MeshPortNames.Kind.Personal, "", registry.nonces(alice), dl, aliceKey
        );
        vm.prank(registrar);
        uint256 gasBefore = gasleft();
        registry.register("alice", alice, MeshPortNames.Kind.Personal, "", dl, sig);
        uint256 gasUsed = gasBefore - gasleft();
        // Emit for external capture; test always passes (just measuring)
        emit log_named_uint("gas:register", gasUsed);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Registration reverts
    // ═══════════════════════════════════════════════════════════════════════════

    function test_register_revert_wrongSigner() public {
        uint256 dl = _deadline();
        // Bob signs for Alice — should revert
        bytes memory sig = _signRegister(
            "alice", alice, MeshPortNames.Kind.Personal, "", registry.nonces(alice), dl, bobKey
        );
        vm.prank(registrar);
        vm.expectRevert(MeshPortNames.BadSignature.selector);
        registry.register("alice", alice, MeshPortNames.Kind.Personal, "", dl, sig);
    }

    function test_register_revert_replayedNonce() public {
        uint256 dl = _deadline();
        bytes memory sig = _signRegister(
            "alice", alice, MeshPortNames.Kind.Personal, "", registry.nonces(alice), dl, aliceKey
        );
        vm.prank(registrar);
        registry.register("alice", alice, MeshPortNames.Kind.Personal, "", dl, sig);

        // Try a different name but replay the same sig (nonce is now stale)
        bytes memory sig2 = _signRegister(
            "bob_a", bob, MeshPortNames.Kind.Personal, "", 0 /*stale nonce*/, dl, aliceKey
        );
        vm.prank(registrar);
        vm.expectRevert(MeshPortNames.BadSignature.selector);
        registry.register("bob_a", alice, MeshPortNames.Kind.Personal, "", dl, sig2);
    }

    function test_register_revert_expiredDeadline() public {
        uint256 dl = block.timestamp - 1; // already expired
        bytes memory sig = _signRegister(
            "alice", alice, MeshPortNames.Kind.Personal, "", registry.nonces(alice), dl, aliceKey
        );
        vm.prank(registrar);
        vm.expectRevert(MeshPortNames.DeadlineExpired.selector);
        registry.register("alice", alice, MeshPortNames.Kind.Personal, "", dl, sig);
    }

    function test_register_revert_nonRegistrar() public {
        uint256 dl = _deadline();
        bytes memory sig = _signRegister(
            "alice", alice, MeshPortNames.Kind.Personal, "", 0, dl, aliceKey
        );
        vm.prank(stranger);
        vm.expectRevert(MeshPortNames.NotRegistrar.selector);
        registry.register("alice", alice, MeshPortNames.Kind.Personal, "", dl, sig);
    }

    function test_register_revert_nameTaken() public {
        _registerAlice("alice");

        // Bob tries to claim the same name
        uint256 dl = _deadline();
        bytes memory sig = _signRegister(
            "alice", bob, MeshPortNames.Kind.Personal, "", registry.nonces(bob), dl, bobKey
        );
        vm.prank(registrar);
        vm.expectRevert(MeshPortNames.NameTaken.selector);
        registry.register("alice", bob, MeshPortNames.Kind.Personal, "", dl, sig);
    }

    function test_register_revert_walletAlreadyHasName() public {
        _registerAlice("alice");

        uint256 dl = _deadline();
        bytes memory sig = _signRegister(
            "alice2", alice, MeshPortNames.Kind.Personal, "", registry.nonces(alice), dl, aliceKey
        );
        vm.prank(registrar);
        vm.expectRevert(MeshPortNames.AlreadyHasName.selector);
        registry.register("alice2", alice, MeshPortNames.Kind.Personal, "", dl, sig);
    }

    function test_register_revert_reserved() public {
        string[] memory names_ = new string[](1);
        names_[0] = "admin";
        vm.prank(owner);
        registry.setReserved(names_, true);

        uint256 dl = _deadline();
        bytes memory sig = _signRegister(
            "admin", alice, MeshPortNames.Kind.Personal, "", registry.nonces(alice), dl, aliceKey
        );
        vm.prank(registrar);
        vm.expectRevert(MeshPortNames.NameReserved.selector);
        registry.register("admin", alice, MeshPortNames.Kind.Personal, "", dl, sig);
    }

    function test_register_revert_invalidName() public {
        uint256 dl = _deadline();
        bytes memory sig = _signRegister(
            "Ali_CE", alice, MeshPortNames.Kind.Personal, "", registry.nonces(alice), dl, aliceKey
        );
        vm.prank(registrar);
        vm.expectRevert(MeshPortNames.InvalidName.selector);
        registry.register("Ali_CE", alice, MeshPortNames.Kind.Personal, "", dl, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // setDisplayName
    // ═══════════════════════════════════════════════════════════════════════════

    function test_setDisplayName_byOwnerDirect() public {
        _registerAlice("alice");

        vm.expectEmit(true, false, false, true);
        emit MeshPortNames.DisplayNameChanged(keccak256("alice"), "Alice Wonderland");

        vm.prank(alice);
        registry.setDisplayName("alice", "Alice Wonderland", 0, "");

        assertEq(registry.recordOf("alice").displayName, "Alice Wonderland");
    }

    function test_setDisplayName_byRegistrarWithSignature() public {
        _registerAlice("alice");

        uint256 dl = _deadline();
        bytes memory sig = _signSetDisplayName(
            "alice", "Alice B.", registry.nonces(alice), dl, aliceKey
        );

        vm.prank(registrar);
        registry.setDisplayName("alice", "Alice B.", dl, sig);

        assertEq(registry.recordOf("alice").displayName, "Alice B.");
        assertEq(registry.nonces(alice), 2); // was 1 after register, now 2
    }

    function test_setDisplayName_revert_wrongSigner() public {
        _registerAlice("alice");

        uint256 dl = _deadline();
        bytes memory sig = _signSetDisplayName(
            "alice", "Hacker", registry.nonces(alice), dl, bobKey // bob signs, not alice
        );

        vm.prank(registrar);
        vm.expectRevert(MeshPortNames.BadSignature.selector);
        registry.setDisplayName("alice", "Hacker", dl, sig);
    }

    function test_setDisplayName_revert_stranger() public {
        _registerAlice("alice");

        vm.prank(stranger);
        vm.expectRevert(MeshPortNames.NotNameOwner.selector);
        registry.setDisplayName("alice", "Hacked", 0, "");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // setBusiness
    // ═══════════════════════════════════════════════════════════════════════════

    function test_setBusiness_happyPath() public {
        _registerAlice("alice");

        vm.expectEmit(true, false, false, true);
        emit MeshPortNames.BusinessStatusChanged(
            keccak256("alice"), MeshPortNames.Kind.Business, true
        );

        vm.prank(registrar);
        registry.setBusiness("alice", MeshPortNames.Kind.Business, true);

        MeshPortNames.Record memory rec = registry.recordOf("alice");
        assertEq(uint8(rec.kind), uint8(MeshPortNames.Kind.Business));
        assertTrue(rec.verified);
    }

    function test_setBusiness_unverify() public {
        _registerAlice("alice");
        vm.prank(registrar);
        registry.setBusiness("alice", MeshPortNames.Kind.Business, true);

        vm.prank(registrar);
        registry.setBusiness("alice", MeshPortNames.Kind.Personal, false);

        MeshPortNames.Record memory rec = registry.recordOf("alice");
        assertEq(uint8(rec.kind), uint8(MeshPortNames.Kind.Personal));
        assertFalse(rec.verified);
    }

    function test_setBusiness_revert_nonRegistrar() public {
        _registerAlice("alice");

        vm.prank(stranger);
        vm.expectRevert(MeshPortNames.NotRegistrar.selector);
        registry.setBusiness("alice", MeshPortNames.Kind.Business, true);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Migrate
    // ═══════════════════════════════════════════════════════════════════════════

    function test_migrate_happyPath() public {
        string[]  memory names_   = new string[](2);
        address[] memory accounts = new address[](2);
        MeshPortNames.Kind[] memory kinds = new MeshPortNames.Kind[](2);
        string[]  memory displayNames = new string[](2);
        bool[]    memory verified_  = new bool[](2);

        names_[0] = "sharma";   accounts[0] = alice; kinds[0] = MeshPortNames.Kind.Business;
        displayNames[0] = "Sharma Chai Corner"; verified_[0] = true;

        names_[1] = "bob_user"; accounts[1] = bob;   kinds[1] = MeshPortNames.Kind.Personal;
        displayNames[1] = ""; verified_[1] = false;

        vm.prank(owner);
        registry.migrate(names_, accounts, kinds, displayNames, verified_);

        assertEq(registry.resolve("sharma"),   alice);
        assertEq(registry.resolve("bob_user"), bob);
        assertTrue(registry.recordOf("sharma").verified);
    }

    function test_migrate_revert_afterClose() public {
        vm.prank(owner);
        registry.closeMigration();

        string[]  memory names_   = new string[](1);
        address[] memory accounts = new address[](1);
        MeshPortNames.Kind[] memory kinds = new MeshPortNames.Kind[](1);
        string[]  memory displayNames = new string[](1);
        bool[]    memory verified_  = new bool[](1);
        names_[0] = "alice"; accounts[0] = alice;

        vm.prank(owner);
        vm.expectRevert(MeshPortNames.MigrationNotOpen.selector);
        registry.migrate(names_, accounts, kinds, displayNames, verified_);
    }

    function test_migrate_event_MigrationClosed() public {
        vm.expectEmit(false, false, false, false);
        emit MeshPortNames.MigrationClosed();

        vm.prank(owner);
        registry.closeMigration();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Revoke
    // ═══════════════════════════════════════════════════════════════════════════

    function test_revoke_thenReRegister() public {
        _registerAlice("alice");
        assertEq(registry.resolve("alice"), alice);

        vm.expectEmit(true, true, false, true);
        emit MeshPortNames.NameRevoked(keccak256("alice"), "alice", alice);

        vm.prank(owner);
        registry.revoke("alice");

        // name is free again
        assertTrue(registry.isAvailable("alice"));
        assertEq(registry.resolve("alice"), address(0));
        assertEq(registry.nameOf(alice), "");

        // alice can re-register
        uint256 dl = _deadline();
        bytes memory sig = _signRegister(
            "alice", alice, MeshPortNames.Kind.Personal, "", registry.nonces(alice), dl, aliceKey
        );
        vm.prank(registrar);
        registry.register("alice", alice, MeshPortNames.Kind.Personal, "", dl, sig);
        assertEq(registry.resolve("alice"), alice);
    }

    function test_revoke_revert_nonExistent() public {
        vm.prank(owner);
        vm.expectRevert(MeshPortNames.NoSuchName.selector);
        registry.revoke("nobody");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Pause
    // ═══════════════════════════════════════════════════════════════════════════

    function test_pause_blocksRegister() public {
        vm.prank(owner);
        registry.pause();

        uint256 dl = _deadline();
        bytes memory sig = _signRegister(
            "alice", alice, MeshPortNames.Kind.Personal, "", registry.nonces(alice), dl, aliceKey
        );
        vm.prank(registrar);
        vm.expectRevert(); // Pausable: EnforcedPause
        registry.register("alice", alice, MeshPortNames.Kind.Personal, "", dl, sig);
    }

    function test_unpause_allowsRegister() public {
        vm.startPrank(owner);
        registry.pause();
        registry.unpause();
        vm.stopPrank();

        _registerAlice("alice");
        assertEq(registry.resolve("alice"), alice);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Ownable2Step
    // ═══════════════════════════════════════════════════════════════════════════

    function test_ownable2step_transfer() public {
        assertEq(registry.owner(), owner);

        vm.prank(owner);
        registry.transferOwnership(alice);
        // still the old owner until accepted
        assertEq(registry.owner(), owner);
        assertEq(registry.pendingOwner(), alice);

        vm.prank(alice);
        registry.acceptOwnership();
        assertEq(registry.owner(), alice);
    }

    function test_ownable2step_revert_directAcceptByStranger() public {
        vm.prank(owner);
        registry.transferOwnership(alice);

        vm.prank(stranger);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        registry.acceptOwnership();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // setRegistrar
    // ═══════════════════════════════════════════════════════════════════════════

    function test_setRegistrar_addAndRemove() public {
        assertFalse(registry.registrars(stranger));

        vm.prank(owner);
        registry.setRegistrar(stranger, true);
        assertTrue(registry.registrars(stranger));

        vm.prank(owner);
        registry.setRegistrar(stranger, false);
        assertFalse(registry.registrars(stranger));
    }

    function test_setRegistrar_revert_nonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        registry.setRegistrar(stranger, true);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // isAvailable / setReserved
    // ═══════════════════════════════════════════════════════════════════════════

    function test_isAvailable_reserved() public {
        string[] memory names_ = new string[](1);
        names_[0] = "support";
        vm.prank(owner);
        registry.setReserved(names_, true);

        assertFalse(registry.isAvailable("support"));

        // unreserve
        vm.prank(owner);
        registry.setReserved(names_, false);
        assertTrue(registry.isAvailable("support"));
    }

    function test_isAvailable_invalid() public view {
        assertFalse(registry.isAvailable("AB")); // too short + uppercase
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DOMAIN_SEPARATOR
    // ═══════════════════════════════════════════════════════════════════════════

    function test_domainSeparator_nonZero() public view {
        assertTrue(registry.DOMAIN_SEPARATOR() != bytes32(0));
    }
}
