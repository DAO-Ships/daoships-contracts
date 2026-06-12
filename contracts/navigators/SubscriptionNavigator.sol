// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../core/DAOShip.sol";
import "../interfaces/INavigator.sol";
import "../libraries/Permissions.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SubscriptionNavigator
 * @notice Recurring membership dues. Members pull-pay periodic fees in any of a
 *         governance-set menu of accepted tokens (native QUAI or ERC20) to keep
 *         their membership current; the fee is forwarded straight to the DAO
 *         treasury (the vault / `daoShip.avatar()`). When a member lapses past the
 *         grace window, ANYONE may `collectFee(member)` to strip their shares —
 *         either burned outright or, by default, converted to (non-voting) loot so
 *         the member keeps their economic claim but loses governance weight. The
 *         collector earns a small loot reward, funding a permissionless keeper.
 *
 * @dev MANAGER navigator (permission 2). It calls `burnShares` / `convertSharesToLoot`
 *      (delinquency enforcement) and `mintLoot` (keeper reward). It is NOT a vault
 *      module: `payFee` only moves *member* funds INTO the vault, never vault funds
 *      out — so it needs no `execTransactionFromModule` privilege. Registered the
 *      standard way, via a governance proposal calling `setNavigators([this],[2])`.
 *
 *      Standalone — NOT a BaseNavigator: BaseNavigator's mintCap/perAddressCap are
 *      mint-side and keyed on `msg.sender`, the wrong shape for a per-member
 *      burn/convert navigator where the payer (`payFeeFor`) and the affected member
 *      differ and the dominant operation removes tokens rather than minting them.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MEMBERSHIP MODEL — enrollment, the clock, and collection.
 * ────────────────────────────────────────────────────────────────────────────
 * `paidThrough[member]` is the timestamp through which the member is paid up, and
 * doubles as the enrollment flag (`0` = not enrolled, never collectible):
 *   - isCurrent       : enrolled && now <= paidThrough
 *   - inGracePeriod   : enrolled && paidThrough < now <= paidThrough + grace
 *   - isDelinquent    : enrolled && now > paidThrough + grace   (collectible)
 *
 * A member is brought under the subscription three ways, all of which set the
 * clock — dues are never optional, only un-started:
 *   1. their own first `payFee` (self-enroll, no complimentary period — they paid),
 *   2. governance `enroll`/`enrollBatch` (grants ONE complimentary period before
 *      dues begin, so bolting this navigator onto an existing DAO can never
 *      retroactively mass-eject the roster — every enrollee gets a full period +
 *      grace before they can be collected), or
 *   3. `_initialMembers` passed at construction (same complimentary-period grant).
 * Because governance can compel enrollment, refusing to ever pay is not a
 * free-rider loophole: governance enrolls you, the clock runs, and a keeper
 * collects you if you still don't pay.
 *
 * Catch-up is a DEBT model: paying advances `paidThrough` forward from where it
 * stood, so a lapsed-but-still-enrolled member must cover the missed periods to
 * become current again (it does not silently forgive arrears by restarting at now).
 * Arrears are naturally bounded — once past grace the member is collected, and
 * `collectFee` un-enrolls them (resets `paidThrough` to 0) so any later return
 * starts fresh rather than owing an unbounded historical debt.
 *
 * Pricing is per-token and ORACLE-FREE: governance sets a fixed fee for each
 * accepted token at construction (e.g. 10 USDC OR 10 USDT OR 500 QUAI per period),
 * and the member chooses which to pay in. The accepted-token menu is IMMUTABLE —
 * to change the menu or the prices, deploy a new navigator and re-register it
 * (the suite-wide immutable-config convention; it also means members know the exact
 * deal for the life of the contract and governance cannot raise the fee then
 * mass-collect).
 *
 * KNOWN EDGE — sponsor-threshold floor: `DAOShip.burnShares` and
 * `convertSharesToLoot` both revert (`BurnBreachesSponsorThreshold` /
 * `ConvertBreachesSponsorThreshold`) if removing the member's shares would drop
 * shares' totalSupply below `sponsorThreshold`. So collecting a member who holds a
 * large fraction of all shares can be un-callable in a small DAO; the core revert
 * bubbles up unchanged. This is intentional — governance must not be deadlocked by
 * an automated collection — and is documented rather than worked around.
 */
contract SubscriptionNavigator is ReentrancyGuard, INavigator {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════════
    // Constants
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Navigator type identifier for indexer discovery
    string public constant navigatorType = "SubscriptionNavigator";

    /// @dev Sourced from the shared Permissions library — single definition of the
    ///      navigator permission bits, resolved at compile time (no runtime DAO call,
    ///      so it is safe under the predicted-address deployment pattern).
    uint256 private constant _GOVERNOR = Permissions.GOVERNOR;

    /// @dev Basis-points denominator for the collector reward.
    uint256 private constant _BPS_DENOMINATOR = 10_000;

    /// @notice Sentinel `token` value denoting the native coin (QUAI).
    address public constant NATIVE = address(0);

    /// @notice Upper bound on the keeper reward (10%). Caps dilution from collection
    ///         and keeps the reward well below the value of the shares removed.
    uint256 public constant MAX_COLLECTOR_BPS = 1_000;

    /// @notice Minimum / maximum permitted period length (sanity floor + uint64 overflow backstop).
    uint64 public constant MIN_PERIOD = 1 hours;
    uint64 public constant MAX_PERIOD = 3650 days;

    // ═══════════════════════════════════════════════════════════════════════════
    // Immutables (no storage slots — live in code, safe under predicted-address deploy)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Address that deployed this navigator
    address public immutable deployer;

    /// @notice Associated DAOShip DAO. The treasury is `daoShip.avatar()` (the vault).
    DAOShip public immutable daoShip;

    /// @notice Length of one subscription period, in seconds
    uint64 public immutable periodDuration;

    /// @notice Grace window after each deadline before a member becomes delinquent
    uint64 public immutable graceDuration;

    /// @notice Time the subscription becomes active (anchors enrollment/payment)
    uint64 public immutable startTime;

    /// @notice Keeper reward, in basis points of the shares removed at collection
    uint256 public immutable collectorRewardBps;

    /// @notice false = convert delinquent shares to loot (default, non-destructive);
    ///         true = burn delinquent shares outright
    bool public immutable burnOnCollect;

    // ═══════════════════════════════════════════════════════════════════════════
    // Storage
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Fee per period for each accepted token. `0` ⇒ token not accepted.
    ///         Keyed by token address; `NATIVE` (address(0)) is the native-coin entry.
    mapping(address => uint256) public feePerPeriod;

    /// @notice The accepted-token menu, for enumeration by the indexer/frontend.
    address[] public acceptedTokens;

    /// @notice Timestamp through which each member is paid up. `0` ⇒ not enrolled.
    mapping(address => uint256) public paidThrough;

    /// @notice Emergency freeze: blocks payFee, enroll, and collectFee
    bool public paused;

    // ═══════════════════════════════════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════════════════════════════════

    event MemberEnrolled(address indexed member, uint256 paidThrough);
    /// @dev One event per payment. The indexer derives cumulative paid totals by
    ///      SUM over these rows at end-of-range — never an inline running `+=`
    ///      (replay/reorg would double-count).
    event FeePaid(
        address indexed member,
        address indexed payer,
        address indexed token,
        uint256 amount,
        uint256 periods,
        uint256 paidThrough
    );
    /// @dev One event per collection. `sharesRemoved` is the share amount burned or
    ///      converted; `reward` is the loot minted to the collector; `burned` is the
    ///      enforcement mode actually applied.
    event FeeCollected(
        address indexed member,
        address indexed collector,
        uint256 sharesRemoved,
        uint256 reward,
        bool burned
    );
    event StuckTokensRecovered(address indexed token, address indexed to, uint256 amount);
    event Paused(address indexed caller);
    event Unpaused(address indexed caller);

    // ═══════════════════════════════════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidConfig();
    error NotAuthorized();
    error IsPaused();
    error InvalidMember();
    error ZeroPeriods();
    error TokenNotAccepted();
    error DuplicateToken();
    error IncorrectPayment();
    error InsufficientPayment();
    error TransferFailed();
    error AlreadyEnrolled();
    error NotDelinquent();
    error NoSharesToBurn();

    // ═══════════════════════════════════════════════════════════════════════════
    // Constructor
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @param _daoShip DAOShip DAO address (its avatar/vault is the treasury)
     * @param _tokens Accepted payment tokens; `address(0)` = native QUAI, else ERC20.
     *               Parallel to `_feesPerPeriod`; at least one entry; no duplicates.
     * @param _feesPerPeriod Fee per period for each token (each > 0)
     * @param _periodDuration Period length in seconds (MIN_PERIOD..MAX_PERIOD)
     * @param _graceDuration Grace window after each deadline (0..MAX_PERIOD)
     * @param _startTime Activation time (0 = now); may be future- or back-dated by governance
     * @param _collectorRewardBps Keeper reward in bps of shares removed (<= MAX_COLLECTOR_BPS)
     * @param _burnOnCollect false = convert delinquent shares to loot, true = burn them
     * @param _initialMembers Members enrolled at deploy (each granted one complimentary period)
     * @param _name Human-readable name (optional, can be empty)
     * @param _description Human-readable description (optional, can be empty)
     */
    constructor(
        address _daoShip,
        address[] memory _tokens,
        uint256[] memory _feesPerPeriod,
        uint64 _periodDuration,
        uint64 _graceDuration,
        uint64 _startTime,
        uint256 _collectorRewardBps,
        bool _burnOnCollect,
        address[] memory _initialMembers,
        string memory _name,
        string memory _description
    ) {
        if (_daoShip == address(0)) revert InvalidConfig();
        if (_tokens.length == 0 || _tokens.length != _feesPerPeriod.length) revert InvalidConfig();
        if (_periodDuration < MIN_PERIOD || _periodDuration > MAX_PERIOD) revert InvalidConfig();
        if (_graceDuration > MAX_PERIOD) revert InvalidConfig();
        if (_collectorRewardBps > MAX_COLLECTOR_BPS) revert InvalidConfig();

        deployer = msg.sender;
        daoShip = DAOShip(payable(_daoShip));
        periodDuration = _periodDuration;
        graceDuration = _graceDuration;
        collectorRewardBps = _collectorRewardBps;
        burnOnCollect = _burnOnCollect;

        uint64 start = _startTime == 0 ? uint64(block.timestamp) : _startTime;
        startTime = start;

        // Build the immutable accepted-token menu. Each fee must be > 0 (a free
        // subscription is meaningless and would let collection burn for nothing),
        // and duplicates are rejected so `feePerPeriod`/`acceptedTokens` stay 1:1.
        for (uint256 i = 0; i < _tokens.length; i++) {
            address token = _tokens[i];
            uint256 fee = _feesPerPeriod[i];
            if (fee == 0) revert InvalidConfig();
            if (feePerPeriod[token] != 0) revert DuplicateToken();
            feePerPeriod[token] = fee;
            acceptedTokens.push(token);
        }

        // Enroll genesis members with one complimentary period before dues begin.
        // Clamp to the deploy block (== now) exactly like _enrollAnchor / _payFee, so a
        // BACK-DATED startTime cannot make the genesis roster instantly collectible.
        uint256 anchor = _max(block.timestamp, uint256(start)) + periodDuration;
        for (uint256 i = 0; i < _initialMembers.length; i++) {
            address member = _initialMembers[i];
            if (member == address(0)) revert InvalidMember();
            if (paidThrough[member] != 0) revert AlreadyEnrolled();
            paidThrough[member] = anchor;
            emit MemberEnrolled(member, anchor);
        }

        emit NavigatorDeployed(_daoShip, msg.sender, navigatorType, _name, _description);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External — write (members: payment)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Pay your own dues for `periods` periods in `token`
     * @dev Send native value only when `token == NATIVE` (exact `feePerPeriod*periods`);
     *      for an ERC20, approve this contract first and send no value.
     * @param periods Number of periods to pay (> 0)
     * @param token Accepted token to pay in (`NATIVE` for QUAI)
     */
    function payFee(uint256 periods, address token) external payable nonReentrant {
        _payFee(msg.sender, periods, token);
    }

    /**
     * @notice Pay another member's dues (gift / sponsor). The payer funds it.
     * @param member Member whose `paidThrough` advances
     * @param periods Number of periods to pay (> 0)
     * @param token Accepted token to pay in (`NATIVE` for QUAI)
     */
    function payFeeFor(address member, uint256 periods, address token) external payable nonReentrant {
        if (member == address(0)) revert InvalidMember();
        _payFee(member, periods, token);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External — write (permissionless keeper)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Collect a delinquent member: remove all their shares and reward the caller.
     * @dev Permissionless — anyone may call once the member is past grace. Removes the
     *      member's ENTIRE share balance (burned if `burnOnCollect`, else converted to
     *      loot so they keep economic value but lose the vote), mints the collector a
     *      `collectorRewardBps` loot reward, and un-enrolls the member so a later return
     *      starts fresh. CEI: state (un-enroll) is written before the external DAOShip
     *      calls; `nonReentrant` guards re-entry. If removing the shares would breach the
     *      sponsor threshold the DAOShip call reverts and the whole collection rolls back.
     * @param member Delinquent member to collect
     */
    function collectFee(address member) external nonReentrant {
        if (paused) revert IsPaused();
        if (!_isDelinquent(member)) revert NotDelinquent();

        uint256 shares = daoShip.sharesToken().balanceOf(member);
        if (shares == 0) revert NoSharesToBurn();

        uint256 reward = (shares * collectorRewardBps) / _BPS_DENOMINATOR;

        // Effect before interactions: un-enroll so the member is fresh on any return,
        // and so a re-entrant collect cannot double-process. Rolls back if a DAOShip
        // call below reverts (e.g. sponsor-threshold floor).
        delete paidThrough[member];

        if (burnOnCollect) {
            address[] memory from = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            from[0] = member;
            amounts[0] = shares;
            daoShip.burnShares(from, amounts);
        } else {
            daoShip.convertSharesToLoot(member, shares);
        }

        if (reward > 0) {
            address[] memory to = new address[](1);
            uint256[] memory rewardAmounts = new uint256[](1);
            to[0] = msg.sender;
            rewardAmounts[0] = reward;
            daoShip.mintLoot(to, rewardAmounts);
        }

        emit FeeCollected(member, msg.sender, shares, reward, burnOnCollect);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External — write (governance / avatar)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Enroll a member under the subscription (avatar only — via governance)
     * @dev Grants one complimentary period before dues begin (fresh period + grace
     *      before they can be collected). Reverts if already enrolled.
     * @param member Member to enroll (non-zero, not already enrolled)
     */
    function enroll(address member) external {
        if (paused) revert IsPaused();
        if (msg.sender != daoShip.avatar()) revert NotAuthorized();
        if (member == address(0)) revert InvalidMember();
        if (paidThrough[member] != 0) revert AlreadyEnrolled();

        uint256 anchor = _enrollAnchor();
        paidThrough[member] = anchor;
        emit MemberEnrolled(member, anchor);
    }

    /**
     * @notice Enroll many members in one call (avatar only — via governance)
     * @dev Members already enrolled are skipped (no revert, no event) so a batch that
     *      overlaps the existing roster still lands. Each newly-enrolled member gets the
     *      same one complimentary period as {enroll}.
     * @param members Members to enroll (each non-zero)
     */
    function enrollBatch(address[] calldata members) external {
        if (paused) revert IsPaused();
        if (msg.sender != daoShip.avatar()) revert NotAuthorized();

        uint256 anchor = _enrollAnchor();
        for (uint256 i = 0; i < members.length; i++) {
            address member = members[i];
            if (member == address(0)) revert InvalidMember();
            if (paidThrough[member] != 0) continue; // already enrolled — skip
            paidThrough[member] = anchor;
            emit MemberEnrolled(member, anchor);
        }
    }

    /**
     * @notice Recover ERC20 tokens mistakenly sent to this navigator (avatar only)
     * @dev Fees are forwarded straight to the vault and never rest here, so this is a
     *      pure safety valve for direct mis-transfers. Does not touch member accounting.
     * @param token ERC20 to recover
     * @param to Recipient
     * @param amount Amount to recover
     */
    function withdrawStuckTokens(IERC20 token, address to, uint256 amount) external nonReentrant {
        if (msg.sender != daoShip.avatar()) revert NotAuthorized();
        token.safeTransfer(to, amount);
        emit StuckTokensRecovered(address(token), to, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External — write (emergency: governor or avatar)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Freeze payments, enrollment, and collection (GOVERNOR navigator or avatar)
     * @dev The fast emergency brake. While paused, no member can be collected, so a
     *      governance pause also shields members from delinquency enforcement.
     */
    function pause() external {
        if (!_isGovernorOrAvatar(msg.sender)) revert NotAuthorized();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Resume payments, enrollment, and collection (GOVERNOR navigator or avatar)
    function unpause() external {
        if (!_isGovernorOrAvatar(msg.sender)) revert NotAuthorized();
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External — views
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice True if the member is enrolled and paid up to or beyond now
    function isCurrent(address member) external view returns (bool) {
        uint256 pt = paidThrough[member];
        return pt != 0 && block.timestamp <= pt;
    }

    /// @notice The timestamp the member is paid through (their deadline). 0 if not enrolled.
    function nextDeadline(address member) external view returns (uint256) {
        return paidThrough[member];
    }

    /// @notice True if the member has lapsed but is still within the grace window
    function inGracePeriod(address member) external view returns (bool) {
        uint256 pt = paidThrough[member];
        return pt != 0 && block.timestamp > pt && block.timestamp <= pt + graceDuration;
    }

    /// @notice True if the member is past grace and may be collected
    function isDelinquent(address member) external view returns (bool) {
        return _isDelinquent(member);
    }

    /// @notice True if the member is enrolled (has an active subscription clock)
    function isEnrolled(address member) external view returns (bool) {
        return paidThrough[member] != 0;
    }

    /// @notice Total cost to pay `periods` periods in `token`. Reverts if not accepted.
    function quote(uint256 periods, address token) external view returns (uint256) {
        uint256 fee = feePerPeriod[token];
        if (fee == 0) revert TokenNotAccepted();
        return fee * periods;
    }

    /// @notice The full accepted-token menu (NATIVE == address(0) for QUAI)
    function getAcceptedTokens() external view returns (address[] memory) {
        return acceptedTokens;
    }

    /// @notice Number of accepted tokens
    function acceptedTokenCount() external view returns (uint256) {
        return acceptedTokens.length;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Internal
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @dev Shared payment logic for payFee / payFeeFor. Advances the member's
     *      `paidThrough` (debt model) and forwards the fee to the vault. Effects are
     *      written before the transfer; a failed/short transfer reverts the whole call.
     */
    function _payFee(address member, uint256 periods, address token) private {
        if (paused) revert IsPaused();
        if (periods == 0) revert ZeroPeriods();
        uint256 fee = feePerPeriod[token];
        if (fee == 0) revert TokenNotAccepted();

        uint256 amount = fee * periods;

        // Advance the clock (effect). New members anchor at max(now, startTime) with no
        // complimentary period (they are paying); existing members extend forward from
        // where they stood, so arrears must be covered to become current (debt model).
        uint256 base = paidThrough[member];
        if (base == 0) {
            base = _max(block.timestamp, startTime);
        }
        uint256 newPaidThrough = base + periods * periodDuration;
        paidThrough[member] = newPaidThrough;

        // Forward the fee to the treasury (interaction).
        address vault = daoShip.avatar();
        if (token == NATIVE) {
            if (msg.value != amount) revert IncorrectPayment();
            (bool success, ) = vault.call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            if (msg.value != 0) revert IncorrectPayment(); // no stray native on ERC20 path
            // balance-before/after rejects fee-on-transfer shortfalls
            uint256 balanceBefore = IERC20(token).balanceOf(vault);
            IERC20(token).safeTransferFrom(msg.sender, vault, amount);
            uint256 received = IERC20(token).balanceOf(vault) - balanceBefore;
            if (received < amount) revert InsufficientPayment();
        }

        emit FeePaid(member, msg.sender, token, amount, periods, newPaidThrough);
    }

    /// @dev True if the member is enrolled and now past the grace window
    function _isDelinquent(address member) private view returns (bool) {
        uint256 pt = paidThrough[member];
        return pt != 0 && block.timestamp > pt + graceDuration;
    }

    /// @dev Enrollment clock for governance/genesis enrollment: one complimentary
    ///      period from the later of now and startTime, so a fresh enrollee always has
    ///      a full period + grace before any collection.
    function _enrollAnchor() private view returns (uint256) {
        return _max(block.timestamp, startTime) + periodDuration;
    }

    /// @dev True if `account` is a GOVERNOR navigator on the DAO or the DAO avatar
    function _isGovernorOrAvatar(address account) private view returns (bool) {
        return (daoShip.navigators(account) & _GOVERNOR) != 0 || account == daoShip.avatar();
    }

    function _max(uint256 a, uint256 b) private pure returns (uint256) {
        return a >= b ? a : b;
    }
}
