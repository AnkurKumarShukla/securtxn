// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface. Deliberately not an import: this contract
/// escrows both the ATS security and ordinary stablecoins, and neither needs
/// anything beyond these two calls.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title PaymentHtlc
 * @notice The settlement leg of a confirmed-payee payout: a hashed timelock
 *         escrow that the payee must claim by revealing a preimage.
 *
 * WHY THIS EXISTS (D41). Everything upstream of this contract answers "is this
 * the right address?". This answers the question that comes after the money
 * moves: "did the payee actually receive it?". A plain transfer cannot answer
 * that — the funds land at an address and nobody signs for them.
 *
 * Here the payee has to transact to be paid, and the claim reveals a secret
 * only they were given. That claim is signed by the payee's key and sits on a
 * public ledger, so it is an acknowledgment of receipt they cannot later
 * repudiate. It is the on-chain twin of the EIP-712 RecipientAcknowledgment,
 * produced as a side effect of getting paid rather than asked for afterwards.
 *
 * AND IF THEY NEVER CLAIM, the money comes back. An unclaimed lock refunds to
 * the payer once the timelock passes — which is the product's whole premise: a
 * misdirected send stops being irrecoverable.
 *
 * SCOPE IS DELIBERATELY SMALL (D41): lock, claim, refund. No partial claims, no
 * multi-hop, no cross-chain. This is not a bridge; it is an escrow with a
 * deadline. Settlement through it is opt-in per payment — a plain transfer
 * stays the default, so a payee who will not or cannot claim still gets paid.
 *
 * Spec: docs/architecture.md 4.5
 */
contract PaymentHtlc {
    enum Status {
        NONE,
        LOCKED,
        CLAIMED,
        REFUNDED
    }

    struct Lock {
        address payer;
        address payee;
        address token;
        uint256 amount;
        bytes32 hashlock;
        uint64 timelock;
        Status status;
        /// Zero until claimed. Afterwards this is the receipt: the secret only
        /// the payee held, published by the payee's own transaction.
        bytes32 preimage;
        /// Commitment to the off-chain payment request. Stored so claim and
        /// refund can name the payment without the caller re-supplying it.
        bytes32 paymentRef;
    }

    mapping(bytes32 => Lock) private _locks;

    /// @dev paymentRef is a commitment to the payment request, never the
    /// payment context itself. Nothing identifying goes on a public ledger
    /// (design principle 2).
    event Locked(
        bytes32 indexed lockId,
        bytes32 indexed paymentRef,
        address indexed payee,
        address payer,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint64 timelock
    );

    event Claimed(bytes32 indexed lockId, bytes32 indexed paymentRef, address indexed payee, bytes32 preimage);

    event Refunded(bytes32 indexed lockId, bytes32 indexed paymentRef, address indexed payer, uint256 amount);

    error AmountIsZero();
    error PayeeIsZero();
    error HashlockIsZero();
    error TimelockNotInFuture();
    error LockAlreadyExists();
    error LockNotFound();
    error LockNotOpen();
    error NotThePayee();
    error PreimageDoesNotMatch();
    error LockExpired();
    error LockNotYetExpired();
    error TokenTransferFailed();

    /**
     * @notice Escrows amount of token against a hash and a deadline.
     * @param paymentRef keccak256 commitment to the off-chain payment request id.
     * @param hashlock keccak256 of a 32-byte secret held by the payee.
     * @param timelock Unix seconds after which the payer may take the funds back.
     * @return lockId Deterministic id, also derivable off-chain via computeLockId.
     *
     * @dev The caller must have approved this contract for amount first. When
     * token is a compliance-gated security, the pull below reverts unless this
     * contract's own address has been granted KYC — the escrow is a holder like
     * any other, and the transfer rules apply to it too.
     */
    function lock(
        bytes32 paymentRef,
        address payee,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint64 timelock
    ) external returns (bytes32 lockId) {
        if (amount == 0) revert AmountIsZero();
        if (payee == address(0)) revert PayeeIsZero();
        if (hashlock == bytes32(0)) revert HashlockIsZero();
        if (timelock <= block.timestamp) revert TimelockNotInFuture();

        lockId = computeLockId(paymentRef, msg.sender, payee, token, amount, hashlock, timelock);
        if (_locks[lockId].status != Status.NONE) revert LockAlreadyExists();

        _locks[lockId] = Lock({
            payer: msg.sender,
            payee: payee,
            token: token,
            amount: amount,
            hashlock: hashlock,
            timelock: timelock,
            status: Status.LOCKED,
            preimage: bytes32(0),
            paymentRef: paymentRef
        });

        emit Locked(lockId, paymentRef, payee, msg.sender, token, amount, hashlock, timelock);

        _pull(token, msg.sender, amount);
    }

    /**
     * @notice Releases an escrow to the payee, who must reveal the secret.
     *
     * @dev Restricted to the payee on purpose. A conventional HTLC lets anyone
     * push the funds along once the preimage is public, but the receipt
     * property here comes from WHO signed the claim. A claim relayed by a third
     * party would move the money and prove nothing about the payee.
     *
     * Claiming closes once the timelock passes, so claim and refund are never
     * both available. Two mutually exclusive outcomes keep the evidence chain
     * unambiguous: a lock was either acknowledged or returned.
     */
    function claim(bytes32 lockId, bytes32 preimage) external {
        Lock storage entry = _locks[lockId];
        if (entry.status == Status.NONE) revert LockNotFound();
        if (entry.status != Status.LOCKED) revert LockNotOpen();
        if (msg.sender != entry.payee) revert NotThePayee();
        if (block.timestamp >= entry.timelock) revert LockExpired();
        if (keccak256(abi.encodePacked(preimage)) != entry.hashlock) revert PreimageDoesNotMatch();

        // Effects before the external call: the status flips first, so a
        // malicious token cannot re-enter and drain a lock that is mid-payout.
        entry.status = Status.CLAIMED;
        entry.preimage = preimage;

        emit Claimed(lockId, entry.paymentRef, entry.payee, preimage);

        _push(entry.token, entry.payee, entry.amount);
    }

    /**
     * @notice Returns an unclaimed escrow to the payer once the deadline passes.
     *
     * @dev Callable by anyone. The funds can only ever go to the recorded payer,
     * so an open caller cannot redirect anything — and the refund therefore does
     * not depend on the payer still being able to transact. Money stuck because
     * one key went quiet is the exact failure this product exists to prevent.
     */
    function refund(bytes32 lockId) external {
        Lock storage entry = _locks[lockId];
        if (entry.status == Status.NONE) revert LockNotFound();
        if (entry.status != Status.LOCKED) revert LockNotOpen();
        if (block.timestamp < entry.timelock) revert LockNotYetExpired();

        entry.status = Status.REFUNDED;

        emit Refunded(lockId, entry.paymentRef, entry.payer, entry.amount);

        _push(entry.token, entry.payer, entry.amount);
    }

    function getLock(bytes32 lockId) external view returns (Lock memory) {
        return _locks[lockId];
    }

    /// @notice The same derivation lock uses, so a client can predict the id
    /// before broadcasting and record it against the payment.
    function computeLockId(
        bytes32 paymentRef,
        address payer,
        address payee,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint64 timelock
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(paymentRef, payer, payee, token, amount, hashlock, timelock));
    }

    /**
     * @dev Accepts both ERC-20 shapes: a true return, or no return data at all.
     * Tokens that return nothing are common enough that assuming a bool would
     * make this contract silently unusable with them.
     */
    function _pull(address token, address from, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeCall(IERC20.transferFrom, (from, address(this), amount))
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }

    function _push(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }
}
