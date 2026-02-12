// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title BaalVotes
 * @notice Abstract contract for timestamp-based voting power with delegation
 * @dev Extends ERC20 with vote tracking via checkpoints
 *      Uses timestamps instead of block numbers for Quai Network compatibility
 *      Based on OpenZeppelin's ERC20Votes but adapted for timestamps
 */
abstract contract BaalVotes is ERC20 {
    /**
     * @dev Checkpoint for historical balance tracking
     * @param timestamp The timestamp when this checkpoint was created
     * @param votes The voting power at this timestamp
     */
    struct Checkpoint {
        uint32 timestamp;
        uint224 votes;
    }

    /// @notice Delegation mapping: account => delegate
    mapping(address => address) private _delegates;

    /// @notice Checkpoints mapping: account => checkpoint array
    mapping(address => Checkpoint[]) private _checkpoints;

    /// @notice Total supply checkpoints for quorum calculations
    Checkpoint[] private _totalSupplyCheckpoints;

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
        require(timepoint < block.timestamp, "BaalVotes: not yet determined");
        return _checkpointsLookup(_checkpoints[account], uint32(timepoint));
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
        require(timepoint < block.timestamp, "BaalVotes: not yet determined");
        return _checkpointsLookup(_totalSupplyCheckpoints, uint32(timepoint));
    }

    /**
     * @notice Delegate voting power to another address
     * @param delegatee The address to delegate to (or address(0) to undelegate)
     */
    function delegate(address delegatee) public virtual {
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
        // Auto-delegate on first mint (H-5 fix: race condition protection)
        // Check BEFORE super._update() to get balance before the transfer
        // Check both balance and checkpoints to prevent double-delegation in same block
        if (to != address(0) && balanceOf(to) == 0 && _checkpoints[to].length == 0 && amount > 0) {
            _delegates[to] = to;
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
        uint32 currentTime = uint32(block.timestamp);

        oldWeight = pos == 0 ? 0 : ckpts[pos - 1].votes;
        uint256 newWeight = op(oldWeight, delta);

        if (pos > 0 && ckpts[pos - 1].timestamp == currentTime) {
            // Update existing checkpoint if same timestamp
            ckpts[pos - 1].votes = _safeCastTo224(newWeight);
        } else {
            // Create new checkpoint
            ckpts.push(
                Checkpoint({timestamp: currentTime, votes: _safeCastTo224(newWeight)})
            );
        }
    }

    /**
     * @notice Lookup a value in a checkpoint array at a given timestamp
     * @param ckpts Checkpoint array to search
     * @param timepoint Timestamp to query
     * @return The value at the given timestamp
     */
    function _checkpointsLookup(Checkpoint[] storage ckpts, uint32 timepoint)
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
     * @notice Safe cast uint256 to uint224
     * @param value Value to cast
     * @return Casted value
     */
    function _safeCastTo224(uint256 value) private pure returns (uint224) {
        require(value <= type(uint224).max, "BaalVotes: value exceeds 224 bits");
        return uint224(value);
    }
}
