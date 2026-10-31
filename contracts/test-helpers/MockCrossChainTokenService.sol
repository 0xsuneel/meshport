// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @notice Test-only stand-in for Circle's CCTPx CrossChainTokenService: one
 * TokenManager (this contract) per token id, which pulls the amount from the
 * caller during crossChainTransfer, takes msg.value as the native fee (at
 * least `nativeFee`) and records the call. Used by the MeshPortRouter tests.
 */
interface IPull { function transferFrom(address f, address t, uint256 v) external returns (bool); }

contract MockCrossChainTokenService {
    struct QuoteClaim { bytes signedQuote; address payable refundAddress; }
    struct Call {
        bytes32 tokenId; uint256 amount; uint32 destinationDomain; bytes destinationAddress;
        bytes32 destinationCaller; uint32 minFinalityThreshold; bytes signedQuote; address refundAddress;
        bool autoExecuteHookData; bytes hookData; uint256 value; address caller;
    }

    mapping(bytes32 => address) public tokenOf;
    uint256 public nativeFee;
    Call public last;

    function register(bytes32 tokenId, address token) external { tokenOf[tokenId] = token; }
    function setNativeFee(uint256 f) external { nativeFee = f; }

    function resolveTokenManager(bytes32 tokenId) external view returns (address) {
        return tokenOf[tokenId] == address(0) ? address(0) : address(this);
    }

    function crossChainTransfer(
        bytes32 tokenId, uint256 amount, uint32 destinationDomain, bytes calldata destinationAddress,
        bytes32 destinationCaller, uint32 minFinalityThreshold, QuoteClaim calldata claim,
        bool autoExecuteHookData, bytes calldata hookData
    ) external payable {
        require(tokenOf[tokenId] != address(0), "unknown token");
        require(msg.value >= nativeFee, "fee");
        require(claim.signedQuote.length > 0, "quote");
        require(IPull(tokenOf[tokenId]).transferFrom(msg.sender, address(this), amount), "pull");
        last = Call(tokenId, amount, destinationDomain, destinationAddress, destinationCaller, minFinalityThreshold,
            claim.signedQuote, claim.refundAddress, autoExecuteHookData, hookData, msg.value, msg.sender);
    }
}
