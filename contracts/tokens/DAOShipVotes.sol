// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title DAOShipVotes
 * @notice Abstract contract for timestamp-based voting power with delegation
 * @dev Extends ERC20 with vote tracking via checkpoints
 *      Uses timestamps instead of block numbers for Quai Network compatibility
 *      Based on OpenZeppelin's ERC20Votes but adapted for timestamps
 */
abstract contract DAOShipVotes is ERC20 {
    /**
     * @dev Checkpoint for historical balance tracking
     * @param timestamp The timestamp when this checkpoint was created (uint40, fits in 1 slot with uint216 votes)
     * @param votes The voting power at this timestamp
     *
     * Gap 8: uint40 timestamp extends overflow to year ~36,812 (vs uint32's year 2106).
     * uint40 + uint216 = 256 bits, preserving the single-storage-slot packing.
     * uint216 supports up to ~1.05e65 voting power — sufficient for any realistic token supply.
     */
    struct Checkpoint {
        uint40 timestamp;
        uint216 votes;
    }

    /// @notice Delegation mapping: account => delegate
    mapping(address => address) private _delegates;

    /// @notice Checkpoints mapping: account => checkpoint array
    mapping(address => Checkpoint[]) private _checkpoints;

    /// @notice Total supply checkpoints for quorum calculations
    Checkpoint[] private _totalSupplyCheckpoints;

    error TimepointOverflow();
    error InvalidDelegatee();

    /**
     * @notice Emitted when an account changes their delegate
     * @param delegator The account delegating
     * @param fromDelegate Previous delegate (address(0) if none)
     * @param toDelegate New delegate
     */
    event DelegateChanged(
        address indexed delegator,
        address indexed fromDelegate,
        address indexed toDelegate
    );

    /**
     * @notice Emitted when a delegate's voting power changes
     * @param delegate The delegate whose voting power changed
     * @param previousBalance Previous voting power
     * @param newBalance New voting power
     */
    event DelegateVotesChanged(
        address indexed delegate,
        uint256 previousBalance,
        uint256 newBalance
    );

    /**
     * @notice Get the current delegate for an account
     * @param account The account to query
     * @return The current delegate (or address(0) if not delegated)
     */
    function delegates(address account) public view returns (address) {
        return _delegates[account];
    }

    /**
     * @notice Get the current voting power for an account
     * @param account The account to query
     * @return Current voting power
     */
    function getCurrentVotes(address account) external view returns (uint256) {
        uint256 pos = _checkpoints[account].length;
        return pos == 0 ? 0 : _checkpoints[account][pos - 1].votes;
    }

    /**
     * @notice Get the voting power for an account at a specific timestamp
     * @param account The account to query
     * @param timepoint The timestamp to query (must be in the past)
     * @return Voting power at the given timestamp
     */
    function getPriorVotes(address account, uint256 timepoint) public view returns (uint256) {
        if (timepoint > type(uint40).max) revert TimepointOverflow();
        require(timepoint < block.timestamp, "DAOShipVotes: not yet determined");
        return _checkpointsLookup(_checkpoints[account], uint40(timepoint));
    }

    /**
     * @notice Alias for getPriorVotes (matches ERC20Votes naming)
     * @param account The account to query
     * @param timepoint The timestamp to query
     * @return Voting power at the given timestamp
     */
    function getPastVotes(address account, uint256 timepoint) external view returns (uint256) {
        return getPriorVotes(account, timepoint);
    }

    /**
     * @notice Get total voting supply at a specific timestamp
     * @param timepoint The timestamp to query (must be in the past)
     * @return Total voting supply at the given timestamp
     */
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256) {
        if (timepoint > type(uint40).max) revert TimepointOverflow();
        require(timepoint < block.timestamp, "DAOShipVotes: not yet determined");
        return _checkpointsLookup(_totalSupplyCheckpoints, uint40(timepoint));
    }

    /**
     * @notice Delegate voting power to another address
     * @dev Delegating to address(0) is blocked — it would zero the account's checkpoint,
     *      causing all subsequent transfers and burns to revert with arithmetic underflow.
     *      To "undelegate", delegate to self: delegate(msg.sender).
     * @param delegatee The address to delegate to (use msg.sender to self-delegate)
     */
    function delegate(address delegatee) public virtual {
        if (delegatee == address(0)) revert InvalidDelegatee();
        _delegate(msg.sender, delegatee);
    }

    /**
     * @notice Internal delegation function
     * @param delegator The account delegating
     * @param delegatee The new delegate
     */
    function _delegate(address delegator, address delegatee) internal virtual {
        address currentDelegate = _delegates[delegator];
        uint256 delegatorBalance = balanceOf(delegator);
        _delegates[delegator] = delegatee;

        emit DelegateChanged(delegator, currentDelegate, delegatee);

        _moveVotingPower(currentDelegate, delegatee, delegatorBalance);
    }

    /**
     * @notice Hook called after token transfers
     * @dev Updates checkpoints for voting power
     */
    function _update(address from, address to, uint256 amount) internal virtual override {
        // Auto-delegate on first receipt after a clean entry.
        // Fires when _delegates[to] is address(0) — meaning either the account has never
        // held tokens, or they fully exited and their delegation was cleared on burn.
        // This ensures every member (including re-joining members) starts with self-delegation
        // and can vote immediately without any additional action.
        // Check BEFORE super._update() to use pre-transfer delegation state.
        if (to != address(0) && _delegates[to] == address(0) && amount > 0) {
            _delegates[to] = to;
            emit DelegateChanged(to, address(0), to);
        }

        super._update(from, to, amount);

        // Update voting power
        if (from != to) {
            if (from != address(0)) {
                address fromDelegate = _delegates[from];
                if (fromDelegate == address(0)) {
                    // If no delegation, tokens are self-delegated
                    _moveVotingPower(from, address(0), amount);
                } else {
                    _moveVotingPower(fromDelegate, address(0), amount);
                }
            }
            if (to != address(0)) {
                address toDelegate = _delegates[to];
                if (toDelegate == address(0)) {
                    // If no delegation, tokens are self-delegated
                    _moveVotingPower(address(0), to, amount);
                } else {
                    _moveVotingPower(address(0), toDelegate, amount);
                }
            }
        }

        // Update total supply checkpoint (C-2 fix)
        // Differentiate mint, burn, and transfer to maintain accurate total supply history
        if (from == address(0)) {
            // Mint: increase total supply
            _writeCheckpoint(_totalSupplyCheckpoints, _add, amount);
        } else if (to == address(0)) {
            // Burn: decrease total supply
            _writeCheckpoint(_totalSupplyCheckpoints, _subtract, amount);

            // Clear delegation on full exit so that re-joining triggers fresh auto-delegation.
            // Without this, a member who delegated to someone else, ragequit, and rejoined
            // would silently have their new votes flow to the old delegate — with no indication
            // this was happening. Partial burns (balance > 0) leave delegation intact.
            if (balanceOf(from) == 0) {
                address oldDelegate = _delegates[from];
                delete _delegates[from];
                if (oldDelegate != address(0)) {
                    emit DelegateChanged(from, oldDelegate, address(0));
                }
            }
        }
        // Transfer (from != 0 && to != 0): no change to total supply, no checkpoint update
    }

    /**
     * @notice Move voting power between delegates
     * @param src Source delegate (address(0) to decrease)
     * @param dst Destination delegate (address(0) to increase)
     * @param amount Amount of voting power to move
     */
    function _moveVotingPower(address src, address dst, uint256 amount) private {
        if (src != dst && amount > 0) {
            if (src != address(0)) {
                uint256 oldWeight = _writeCheckpoint(_checkpoints[src], _subtract, amount);
                emit DelegateVotesChanged(src, oldWeight, oldWeight - amount);
            }

            if (dst != address(0)) {
                uint256 oldWeight = _writeCheckpoint(_checkpoints[dst], _add, amount);
                emit DelegateVotesChanged(dst, oldWeight, oldWeight + amount);
            }
        }
    }

    /**
     * @notice Write a new checkpoint for an account
     * @param ckpts Checkpoint array to write to
     * @param op Operation to perform (add or subtract)
     * @param delta Amount to add or subtract
     * @return oldWeight The previous weight before this checkpoint
     */
    function _writeCheckpoint(
        Checkpoint[] storage ckpts,
        function(uint256, uint256) view returns (uint256) op,
        uint256 delta
    ) private returns (uint256 oldWeight) {
        uint256 pos = ckpts.length;
        uint40 currentTime = uint40(block.timestamp);

        oldWeight = pos == 0 ? 0 : ckpts[pos - 1].votes;
        uint256 newWeight = op(oldWeight, delta);

        if (pos > 0 && ckpts[pos - 1].timestamp == currentTime) {
            // Update existing checkpoint if same timestamp
            ckpts[pos - 1].votes = _safeCastTo216(newWeight);
        } else {
            // Create new checkpoint
            ckpts.push(
                Checkpoint({timestamp: currentTime, votes: _safeCastTo216(newWeight)})
            );
        }
    }

    /**
     * @notice Lookup a value in a checkpoint array at a given timestamp
     * @param ckpts Checkpoint array to search
     * @param timepoint Timestamp to query
     * @return The value at the given timestamp
     */
    function _checkpointsLookup(Checkpoint[] storage ckpts, uint40 timepoint)
        private
        view
        returns (uint256)
    {
        uint256 length = ckpts.length;
        if (length == 0) {
            return 0;
        }

        // Check most recent checkpoint
        if (ckpts[length - 1].timestamp <= timepoint) {
            return ckpts[length - 1].votes;
        }

        // Check oldest checkpoint
        if (ckpts[0].timestamp > timepoint) {
            return 0;
        }

        // Binary search
        uint256 low = 0;
        uint256 high = length;

        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (ckpts[mid].timestamp > timepoint) {
                high = mid;
            } else {
                low = mid + 1;
            }
        }

        return ckpts[low - 1].votes;
    }

    /**
     * @notice Addition operation for checkpoint updates
     */
    function _add(uint256 a, uint256 b) private pure returns (uint256) {
        return a + b;
    }

    /**
     * @notice Subtraction operation for checkpoint updates
     */
    function _subtract(uint256 a, uint256 b) private pure returns (uint256) {
        return a - b;
    }

    /**
     * @notice Safe cast uint256 to uint216
     * @param value Value to cast
     * @return Casted value
     */
    function _safeCastTo216(uint256 value) private pure returns (uint216) {
        require(value <= type(uint216).max, "DAOShipVotes: value exceeds 216 bits");
        return uint216(value);
    }
}
