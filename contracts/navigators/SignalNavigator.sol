// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../core/DAOShip.sol";
import "../interfaces/INavigator.sol";

/**
 * @title SignalNavigator
 * @notice Non-executing, share-weighted governance polls ("temperature checks").
 * @dev NO PERMISSION navigator. This contract never calls a mutating function on
 *      DAOShip — it only reads delegation-aware voting power via
 *      `daoShip.getPriorVotes()` and records votes in its own storage. A bug here
 *      cannot mint, burn, pause, or alter governance: the worst case is a mis-tallied
 *      poll, and polls are non-binding by design. No ReentrancyGuard or pause is
 *      needed because there are no value transfers and no untrusted external calls.
 *
 * Snapshot model — power is measured at POLL START, not poll creation:
 * - Each poll stores `snapshotTimestamp = votingStarts - 1`.
 * - Votes can only be cast once `block.timestamp >= votingStarts`, so the snapshot
 *   is always strictly in the past at vote time and `getPriorVotes` never reverts on
 *   its `timepoint < block.timestamp` guard. No keeper / "activation" tx is required;
 *   the snapshot point is simply defined as start-time and resolved lazily on vote.
 * - Consequence: shares acquired (or delegations received) AFTER voting opens carry
 *   no weight, but anything settled BEFORE start counts — giving scheduled polls a
 *   lead window to organize delegation.
 *
 * Scheduling:
 * - `createPoll(..., startTime, duration)`: `startTime == 0` opens immediately;
 *   otherwise `block.timestamp <= startTime <= block.timestamp + maxStartDelay`.
 * - `maxStartDelay == 0` forbids scheduling (immediate-only polls).
 *
 * Two distinct snapshots, by design:
 * - Creation gating measures the creator's power at `now - 1` (you must hold shares
 *   to open a poll today).
 * - The poll's voting snapshot is at `votingStarts - 1`.
 */
contract SignalNavigator is INavigator {

    // ═══════════════════════════════════════════════════════════════════════════
    // Constants
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Navigator type identifier for indexer discovery
    string public constant navigatorType = "SignalNavigator";

    /// @notice Minimum number of options a poll may offer
    uint8 public constant MIN_OPTIONS = 2;

    /// @notice Maximum number of options a poll may offer
    uint8 public constant MAX_OPTIONS = 10;

    /// @notice Upper bound for both the voting window and the scheduling lead time.
    /// @dev Keeps the uint64 timestamp arithmetic (`votingStarts + duration`,
    ///      `block.timestamp + maxStartDelay`) far clear of overflow and rejects
    ///      nonsensical config at deploy time.
    uint64 public constant MAX_WINDOW = 3650 days;

    // ═══════════════════════════════════════════════════════════════════════════
    // Immutables
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Address that deployed this navigator
    address public immutable deployer;

    /// @notice Associated DAOShip DAO (read-only — no permission required)
    DAOShip public immutable daoShip;

    /// @notice Minimum voting power (at creation) required to open a poll
    uint256 public immutable minSharesToCreatePoll;

    /// @notice Minimum voting-window length in seconds
    uint64 public immutable minDuration;

    /// @notice Maximum voting-window length in seconds
    uint64 public immutable maxDuration;

    /// @notice Maximum lead time between creation and `votingStarts` (0 = no scheduling)
    uint64 public immutable maxStartDelay;

    // ═══════════════════════════════════════════════════════════════════════════
    // Storage
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Lifecycle state of a poll (derived from timestamps + cancelled flag)
    enum Status { Pending, Active, Ended, Cancelled }

    struct Poll {
        address creator;
        string question;            // IPFS hash or short text
        uint8 optionCount;          // MIN_OPTIONS..MAX_OPTIONS
        uint64 snapshotTimestamp;   // votingStarts - 1; voting power measured here
        uint64 votingStarts;
        uint64 votingEnds;
        bool cancelled;
        mapping(uint8 => uint256) optionVotes;
        mapping(address => bool) voted;
    }

    /// @notice Number of polls ever created; also the id of the next poll
    uint256 public pollCount;

    /// @dev Public getter omits the nested mappings (returns the scalar fields only)
    mapping(uint256 => Poll) public polls;

    // ═══════════════════════════════════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════════════════════════════════

    event PollCreated(
        uint256 indexed pollId,
        address indexed creator,
        string question,
        uint8 optionCount,
        uint64 snapshotTimestamp,
        uint64 votingStarts,
        uint64 votingEnds
    );
    event Voted(uint256 indexed pollId, address indexed voter, uint8 indexed option, uint256 weight);
    event PollCancelled(uint256 indexed pollId, address indexed caller);

    // ═══════════════════════════════════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidConfig();
    error InsufficientShares();
    error InvalidOptionCount();
    error InvalidDuration();
    error InvalidStartTime();
    error PollDoesNotExist();
    error PollNotStarted();
    error PollHasEnded();
    error PollIsCancelled();
    error AlreadyVoted();
    error InvalidOption();
    error NoVotingPower();
    error NotAuthorized();

    // ═══════════════════════════════════════════════════════════════════════════
    // Constructor
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @param _daoShip DAOShip DAO address (read for voting power and avatar)
     * @param _minSharesToCreatePoll Minimum voting power (at creation) to open a poll (0 = anyone with power)
     * @param _minDuration Minimum voting-window length in seconds (must be > 0)
     * @param _maxDuration Maximum voting-window length in seconds (>= _minDuration)
     * @param _maxStartDelay Maximum scheduling lead time in seconds (0 = immediate-only)
     * @param _name Human-readable name (optional, can be empty)
     * @param _description Human-readable description (optional, can be empty)
     */
    constructor(
        address _daoShip,
        uint256 _minSharesToCreatePoll,
        uint64 _minDuration,
        uint64 _maxDuration,
        uint64 _maxStartDelay,
        string memory _name,
        string memory _description
    ) {
        if (_daoShip == address(0)) revert InvalidConfig();
        if (_minDuration == 0) revert InvalidConfig();
        if (_maxDuration < _minDuration) revert InvalidConfig();
        // Upper bounds: overflow backstop for the uint64 timestamp math, and a sanity gate.
        if (_maxDuration > MAX_WINDOW) revert InvalidConfig();
        if (_maxStartDelay > MAX_WINDOW) revert InvalidConfig();

        deployer = msg.sender;
        daoShip = DAOShip(payable(_daoShip));
        minSharesToCreatePoll = _minSharesToCreatePoll;
        minDuration = _minDuration;
        maxDuration = _maxDuration;
        maxStartDelay = _maxStartDelay;

        emit NavigatorDeployed(_daoShip, msg.sender, navigatorType, _name, _description);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External — write
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Open a new poll
     * @param question IPFS hash or short text describing the poll
     * @param optionCount Number of options (MIN_OPTIONS..MAX_OPTIONS)
     * @param startTime When voting opens (0 = now; else now..now+maxStartDelay)
     * @param duration Voting-window length in seconds (minDuration..maxDuration)
     * @return pollId Id of the newly created poll
     */
    function createPoll(
        string calldata question,
        uint8 optionCount,
        uint64 startTime,
        uint64 duration
    ) external returns (uint256 pollId) {
        if (optionCount < MIN_OPTIONS || optionCount > MAX_OPTIONS) revert InvalidOptionCount();
        if (duration < minDuration || duration > maxDuration) revert InvalidDuration();

        // Resolve voting-open time. startTime == 0 is sugar for "now".
        uint64 votingStarts;
        if (startTime == 0) {
            votingStarts = uint64(block.timestamp);
        } else {
            if (startTime < block.timestamp || startTime > block.timestamp + maxStartDelay) {
                revert InvalidStartTime();
            }
            votingStarts = startTime;
        }

        // Creation gating: creator must hold the threshold of voting power *now*.
        // (The poll's own snapshot is at votingStarts-1, which may be in the future
        // and therefore unqueryable here — so gating uses now-1 instead.)
        if (daoShip.getPriorVotes(msg.sender, block.timestamp - 1) < minSharesToCreatePoll) {
            revert InsufficientShares();
        }

        pollId = pollCount++;
        Poll storage p = polls[pollId];
        p.creator = msg.sender;
        p.question = question;
        p.optionCount = optionCount;
        // votingStarts >= block.timestamp > 0, so `- 1` cannot underflow.
        // NB: for an immediate poll this snapshot excludes holders whose FIRST checkpoint
        // is the creation block — shares acquired in the *same block* read as 0 at
        // votingStarts-1. Schedule the poll (or wait a block) to include same-block mints.
        p.snapshotTimestamp = votingStarts - 1;
        p.votingStarts = votingStarts;
        p.votingEnds = votingStarts + duration;

        emit PollCreated(pollId, msg.sender, question, optionCount, p.snapshotTimestamp, votingStarts, p.votingEnds);
    }

    /**
     * @notice Cast a share-weighted vote
     * @dev Weight is the caller's delegation-aware voting power at the poll snapshot
     *      (`votingStarts - 1`). One vote per address per poll.
     * @param pollId Poll to vote in
     * @param option Option index (0..optionCount-1)
     */
    function vote(uint256 pollId, uint8 option) external {
        Poll storage p = _getPoll(pollId);
        if (p.cancelled) revert PollIsCancelled();
        // Half-open window [votingStarts, votingEnds): start inclusive, end exclusive — exactly
        // matching DAOShip.castVote (`block.timestamp < votingStarts || >= votingEnds` reverts).
        // The window is therefore exactly `duration` seconds; pollStatus() uses the same bounds.
        if (block.timestamp < p.votingStarts) revert PollNotStarted();
        if (block.timestamp >= p.votingEnds) revert PollHasEnded();
        if (option >= p.optionCount) revert InvalidOption();
        if (p.voted[msg.sender]) revert AlreadyVoted();

        uint256 weight = daoShip.getPriorVotes(msg.sender, p.snapshotTimestamp);
        if (weight == 0) revert NoVotingPower();

        p.voted[msg.sender] = true;
        p.optionVotes[option] += weight;

        emit Voted(pollId, msg.sender, option, weight);
    }

    /**
     * @notice Cancel a poll
     * @dev Before voting opens: creator or avatar. After voting opens: avatar only
     *      (so a creator cannot nuke an in-progress poll they are losing). Cannot
     *      cancel a poll that has already ended.
     * @param pollId Poll to cancel
     */
    function cancelPoll(uint256 pollId) external {
        Poll storage p = _getPoll(pollId);
        if (p.cancelled) revert PollIsCancelled();
        // "Ended" is block.timestamp >= votingEnds, consistent with vote()/pollStatus().
        if (block.timestamp >= p.votingEnds) revert PollHasEnded();

        bool isAvatar = msg.sender == daoShip.avatar();
        if (block.timestamp < p.votingStarts) {
            if (msg.sender != p.creator && !isAvatar) revert NotAuthorized();
        } else {
            if (!isAvatar) revert NotAuthorized();
        }

        p.cancelled = true;
        emit PollCancelled(pollId, msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External — views
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Votes accrued to a single option
    function getOptionVotes(uint256 pollId, uint8 option) external view returns (uint256) {
        Poll storage p = _getPoll(pollId);
        if (option >= p.optionCount) revert InvalidOption();
        return p.optionVotes[option];
    }

    /// @notice Full tally as an array indexed by option
    function getResults(uint256 pollId) external view returns (uint256[] memory results) {
        Poll storage p = _getPoll(pollId);
        results = new uint256[](p.optionCount);
        for (uint8 i = 0; i < p.optionCount; i++) {
            results[i] = p.optionVotes[i];
        }
    }

    /// @notice Whether `voter` has already voted in `pollId`
    function hasVoted(uint256 pollId, address voter) external view returns (bool) {
        return _getPoll(pollId).voted[voter];
    }

    /// @notice Lifecycle status of a poll
    function pollStatus(uint256 pollId) external view returns (Status) {
        Poll storage p = _getPoll(pollId);
        if (p.cancelled) return Status.Cancelled;
        if (block.timestamp < p.votingStarts) return Status.Pending;
        if (block.timestamp >= p.votingEnds) return Status.Ended;
        return Status.Active;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Internal
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Resolve a poll storage pointer, reverting on a never-created id
    function _getPoll(uint256 pollId) private view returns (Poll storage) {
        if (pollId >= pollCount) revert PollDoesNotExist();
        return polls[pollId];
    }
}
