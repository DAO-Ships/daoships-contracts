// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../interfaces/IAvatar.sol";
import "../interfaces/IDAOShipToken.sol";
import "../libraries/Enum.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title DAOShip
 * @notice Minimal Viable DAO - Zodiac module for Quai Vault treasury governance
 * @dev DAO governance implementation for Quai Network, inspired by MolochV3 (Baal)
 *      Uses timestamp-based voting (not block numbers) for compatibility
 *      Acts as Zodiac module on Quai Vault via IAvatar interface
 *
 * Key Features:
 * - Share-weighted voting with delegation
 * - Proposal lifecycle: submit → sponsor → vote → grace → process
 * - Quorum and majority requirements
 * - Navigator extension system (ADMIN, MANAGER, GOVERNOR permissions)
 * - Ragequit: burn shares/loot to claim proportional treasury assets
 * - Pausable tokens for emergency situations
 *
 * Architecture:
 * - DAOShip owns SharesERC20 (voting) and LootERC20 (non-voting) tokens
 * - DAOShip is a module on Quai Vault (avatar)
 * - Proposals execute via IAvatar.execTransactionFromModule()
 * - Navigators are authorized external contracts with specific permissions
 */
contract DAOShip is ReentrancyGuard {
    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Navigator permission system uses bit flags for combining permissions
     *
     * Permissions:
     * - ADMIN (1):    Can pause/unpause tokens, set governance config
     * - MANAGER (2):  Can mint/burn shares and loot
     * - GOVERNOR (4): Can cancel proposals, set governance config
     *
     * Combining permissions (bitwise OR):
     * - ADMIN + MANAGER = 3
     * - ADMIN + GOVERNOR = 5
     * - MANAGER + GOVERNOR = 6
     * - ALL PERMISSIONS = 7
     *
     * Checking permissions (bitwise AND):
     * - require((navigators[address] & MANAGER) != 0, "not manager");
     */
    uint256 public constant ADMIN = 1;

    /// @notice Navigator permission: can mint/burn shares and loot
    uint256 public constant MANAGER = 2;

    /// @notice Navigator permission: can cancel proposals, set governance config
    uint256 public constant GOVERNOR = 4;

    /// @notice Maximum valid permission bitmask (ADMIN | MANAGER | GOVERNOR)
    uint256 public constant MAX_PERMISSION = 7;

    /// @notice Minimum voting period in seconds
    uint32 public constant MIN_VOTING_PERIOD = 60;

    /// @notice Maximum voting period in seconds (~1 year)
    /// @dev Prevents uint32 overflow when computing votingEnds/graceEnds in _sponsorProposal.
    ///      votingPeriod + gracePeriod must fit in uint32 when added to block.timestamp.
    uint32 public constant MAX_VOTING_PERIOD = 31_536_000;

    /// @notice Maximum grace period in seconds (~1 year)
    uint32 public constant MAX_GRACE_PERIOD = 31_536_000;

    /// @notice Basis points divisor for percentage calculations (100% = 10000 basis points)
    uint256 public constant BASIS_POINTS_DIVISOR = 10000;

    /// @notice Maximum navigators that can be set in a single call (prevents gas limit DoS)
    uint256 public constant MAX_NAVIGATORS_PER_CALL = 20;

    // ═══════════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Quai Vault address (treasury controlled by this DAOShip)
    address public avatar;

    /// @notice Voting shares token (ERC20Votes with delegation)
    IDAOShipVotingToken public sharesToken;

    /// @notice Non-voting loot token (basic ERC20)
    IDAOShipToken public lootToken;

    /// @notice Proposal count (also used as proposal ID)
    /// @dev Packed with lootToken in slot 3 (bits 160-191)
    uint32 public proposalCount;

    /// @notice Voting period duration in seconds
    /// @dev Packed in slot 3 (bits 224-255)
    uint32 public votingPeriod;

    /// @notice Grace period duration in seconds (after voting, before processing)
    uint32 public gracePeriod;

    /// @notice Total number of shares (cached for gas efficiency)
    uint256 public totalShares;

    /// @notice Total amount of loot (cached for gas efficiency)
    uint256 public totalLoot;

    /// @notice Default expiry window after graceEnds for proposals with no explicit expiration (seconds)
    /// @dev M-7: proposals in Ready state with expiration==0 auto-expire after this window
    ///      If 0, falls back to 2 * (votingPeriod + gracePeriod)
    uint32 public defaultExpiryWindow;

    /// @notice Native tokens (QUAI on Quai Network) required to submit a proposal (anti-spam)
    uint256 public proposalOffering;

    /// @notice Quorum percentage in basis points (e.g., 2000 = 20%)
    uint256 public quorumPercent;

    /// @notice Minimum shares required to sponsor a proposal
    uint256 public sponsorThreshold;

    /// @notice Minimum percentage of total supply that must remain after ragequit (basis points)
    uint256 public minRetentionPercent;

    /// @notice MultiSend library address for batched proposal execution
    address public multisendLibrary;

    /// @notice Whether admin functions are locked (navigators cannot be changed)
    bool public adminLock;

    /// @notice Whether manager functions are locked
    bool public managerLock;

    /// @notice Whether governor functions are locked
    bool public governorLock;

    /// @notice Re-entrancy guard: set to true only during avatar execution in processProposal
    /// @dev H-1: prevents executeAsGovernance from being called outside proposal execution context
    bool private _inProposalExecution;

    /// @notice Mapping of navigator addresses to their permission bitmask
    mapping(address => uint256) public navigators;

    /// @notice Mapping of token addresses that are enabled for ragequit
    mapping(address => bool) public guildTokens;

    /// @notice Enumerable array of registered guild tokens (mirrors the mapping for on-chain queries)
    address[] private _guildTokenList;

    /// @notice Mapping of proposal ID to Proposal struct
    mapping(uint32 => Proposal) public proposals;

    /// @notice Mapping of member address to proposal ID to whether they voted
    mapping(address => mapping(uint32 => bool)) public memberVoted;

    // ═══════════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Proposal state
     * @param id Proposal ID (same as proposalCount at submission)

     * @param proposalDataHash Keccak256 hash of proposal data (for verification at processing)
     * @param sponsor Address that sponsored the proposal (address(0) if not sponsored)
     * @param submitter Address that submitted the proposal
     * @param votingStarts Timestamp when voting starts (sponsor time)
     * @param votingEnds Timestamp when voting ends
     * @param graceEnds Timestamp when grace period ends
     * @param expiration Timestamp when proposal expires (0 = no expiration)
     * @param yesVotes Number of members who voted yes
     * @param noVotes Number of members who voted no
     * @param yesBalance Share-weighted yes votes (used for quorum)
     * @param noBalance Share-weighted no votes
     * @param details IPFS hash or metadata string
     * @param status Boolean flags: [cancelled, processed, passed, actionFailed]
     */
    struct Proposal {
        uint32 id;
        bytes32 proposalDataHash;
        address sponsor;
        address submitter;
        uint40 votingStarts;
        uint40 votingEnds;
        uint40 graceEnds;
        uint40 expiration;
        uint32 yesVotes;
        uint32 noVotes;
        uint256 yesBalance;
        uint256 noBalance;
        uint256 maxTotalSharesAtSponsor; // Total shares snapshot at sponsorship (for quorum)
        uint256 maxTotalSharesAndLootAtVote; // High water mark of total supply during voting (for retention)
        string details;
        bool[4] status; // [cancelled, processed, passed, actionFailed]
    }

    /**
     * @notice Proposal state enum (computed from timestamps and flags)
     * @dev Ordering is significant — external consumers rely on these integer values.
     *      0=Unborn, 1=Submitted, 2=Voting, 3=Cancelled, 4=Grace, 5=Ready,
     *      6=Processed, 7=Defeated, 8=Expired
     */
    enum ProposalState {
        Unborn,      // 0 — Proposal doesn't exist
        Submitted,   // 1 — Submitted but not sponsored
        Voting,      // 2 — Voting period active
        Cancelled,   // 3 — Cancelled by submitter or governor (before processing)
        Grace,       // 4 — Grace period (voting ended, cannot process yet)
        Ready,       // 5 — Ready to process
        Processed,   // 6 — Processed (passed and executed)
        Defeated,    // 7 — Failed quorum/majority (auto-detected or after processProposal)
        Expired      // 8 — Expired before processing
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when DAOShip is initialized
     * @param lootPaused Whether loot token is paused
     * @param sharesPaused Whether shares token is paused
     * @param gracePeriod Grace period duration
     * @param votingPeriod Voting period duration
     * @param proposalOffering Native tokens (QUAI on Quai Network) required to submit proposal
     * @param quorumPercent Quorum percentage (basis points)
     * @param sponsorThreshold Minimum shares to sponsor
     * @param minRetentionPercent Minimum retention after ragequit (basis points)
     * @param name Shares token name
     * @param symbol Shares token symbol
     * @param guildTokens Initial ragequittable tokens
     * @param totalShares Initial total shares
     * @param totalLoot Initial total loot
     */
    event SetupComplete(
        bool lootPaused,
        bool sharesPaused,
        uint32 gracePeriod,
        uint32 votingPeriod,
        uint256 proposalOffering,
        uint256 quorumPercent,
        uint256 sponsorThreshold,
        uint256 minRetentionPercent,
        string name,
        string symbol,
        string lootName,
        string lootSymbol,
        address[] guildTokens,
        uint256 totalShares,
        uint256 totalLoot
    );

    /**
     * @notice Emitted when a proposal is submitted
     * @param proposal Proposal ID
     * @param proposalDataHash Hash of proposal data
     * @param submitter Address that submitted the proposal
     * @param votingPeriod Current voting period setting
     * @param proposalData Raw proposal data (can be large)
     * @param expiration Expiration timestamp (0 if none)
     * @param selfSponsor Whether proposal was auto-sponsored
     * @param timestamp Current block timestamp
     * @param details IPFS hash or metadata
     */
    event SubmitProposal(
        uint256 indexed proposal,
        bytes32 indexed proposalDataHash,
        address indexed submitter,
        uint256 votingPeriod,
        bytes proposalData,
        uint256 expiration,
        bool selfSponsor,
        uint256 timestamp,
        string details,
        uint256 proposalOffering
    );

    /**
     * @notice Emitted when a proposal is sponsored
     * @param member Address that sponsored
     * @param proposal Proposal ID
     * @param votingStarts Timestamp when voting starts
     * @param maxTotalSharesAtSponsor Total shares snapshot for quorum calculation
     * @param maxTotalSharesAndLootAtVote Initial high water mark for retention check
     */
    event SponsorProposal(
        address indexed member,
        uint256 indexed proposal,
        uint256 votingStarts,
        uint256 votingEnds,
        uint256 graceEnds,
        uint256 maxTotalSharesAtSponsor,
        uint256 maxTotalSharesAndLootAtVote
    );

    /**
     * @notice Emitted when a member votes
     * @param member Address that voted
     * @param balance Voting power used (share balance at votingStarts)
     * @param proposal Proposal ID
     * @param approved Whether vote is yes (true) or no (false)
     */
    event SubmitVote(
        address indexed member,
        uint256 balance,
        uint256 indexed proposal,
        bool indexed approved
    );

    /**
     * @notice Emitted when a proposal is processed
     * @param proposal Proposal ID
     * @param passed Whether proposal passed quorum/majority
     * @param actionFailed Whether execution via IAvatar failed
     */
    event ProcessProposal(
        uint256 indexed proposal,
        bool passed,
        bool actionFailed,
        address indexed processor
    );

    /**
     * @notice Emitted when a proposal is cancelled
     * @param proposal Proposal ID
     */
    event CancelProposal(uint256 indexed proposal, address indexed canceller);

    /**
     * @notice Emitted when a member ragequits
     * @param member Address that ragequit
     * @param to Address receiving withdrawn assets
     * @param lootToBurn Amount of loot burned
     * @param sharesToBurn Amount of shares burned
     * @param tokens Tokens withdrawn
     * @param amounts Fair share amount withdrawn per token (parallel array with tokens)
     */
    event Ragequit(
        address indexed member,
        address indexed to,
        uint256 lootToBurn,
        uint256 sharesToBurn,
        address[] tokens,
        uint256[] amounts
    );

    /**
     * @notice Emitted when a navigator is set
     * @param navigator Navigator address
     * @param permission Permission bitmask
     */
    event NavigatorSet(address indexed navigator, uint256 permission);

    /**
     * @notice Emitted when governance config is updated
     * @param votingPeriod New voting period
     * @param gracePeriod New grace period
     * @param proposalOffering New proposal offering
     * @param quorumPercent New quorum percentage
     * @param sponsorThreshold New sponsor threshold
     * @param minRetentionPercent New minimum retention percentage
     * @param defaultExpiryWindow New default expiry window (0 = use 2*(voting+grace) fallback)
     */
    event GovernanceConfigSet(
        uint32 votingPeriod,
        uint32 gracePeriod,
        uint256 proposalOffering,
        uint256 quorumPercent,
        uint256 sponsorThreshold,
        uint256 minRetentionPercent,
        uint32 defaultExpiryWindow
    );

    /**
     * @notice Emitted when guild tokens are set
     * @param tokens Token addresses
     * @param enabled Whether tokens are enabled (true) or disabled (false)
     */
    event SetGuildTokens(address[] tokens, bool[] enabled);

    /**
     * @notice Emitted when shares are minted
     * @param to Addresses receiving shares
     * @param amount Amounts minted
     */
    event MintShares(address[] to, uint256[] amount);

    /**
     * @notice Emitted when loot is minted
     * @param to Addresses receiving loot
     * @param amount Amounts minted
     */
    event MintLoot(address[] to, uint256[] amount);

    /**
     * @notice Emitted when shares are burned
     * @param from Addresses losing shares
     * @param amount Amounts burned
     */
    event BurnShares(address[] from, uint256[] amount);

    /**
     * @notice Emitted when loot is burned
     * @param from Addresses losing loot
     * @param amount Amounts burned
     */
    event BurnLoot(address[] from, uint256[] amount);

    /**
     * @notice Emitted when shares are converted to loot
     * @param from Account whose shares were converted
     * @param amount Amount of shares converted to loot
     */
    event ConvertSharesToLoot(address indexed from, uint256 amount);

    /**
     * @notice Emitted when admin is locked
     */
    event LockAdmin(bool lock);

    /**
     * @notice Emitted when manager is locked
     */
    event LockManager(bool lock);

    /**
     * @notice Emitted when governor is locked
     */
    event LockGovernor(bool lock);

    /// @notice Emitted when admin config (token pause state) is changed
    event AdminConfigSet(bool sharesPaused, bool lootPaused);

    // ═══════════════════════════════════════════════════════════════════════════════
    // CUSTOM ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    error AlreadyInitialized();
    error InvalidAddress();
    error VotingPeriodTooShort();
    error VotingPeriodTooLong();
    error GracePeriodTooLong();
    error InvalidQuorum();
    error InvalidRetention();
    error LengthMismatch();
    error NotGovernance();
    error NotAdmin();
    error NotManager();
    error NotGovernor();
    error NotAuthorized();
    error SelfSponsorNoOffering();
    error IncorrectOffering();
    error ExpirationTooSoon();
    error OfferingTransferFailed();
    error ProposalLimitReached();
    error NotEnabledModule();
    error NotReady();
    error AlreadyProcessed();
    error HashMismatch();
    error Expired();
    error NotVoting();
    error AlreadyVoted();
    error InsufficientVotingPower();
    error InvalidProposal();
    error AlreadyCancelled();
    error NotCancellable();
    error NotGuildToken();
    error TokensNotSorted();
    error InvalidRecipient();
    error NothingToBurn();
    error InsufficientRetention();
    error BalanceQueryFailed();
    error ETHTransferFailed();
    error TokenTransferFailed();
    error EmptyArrays();
    error BurnBreachesSponsorThreshold();
    error ConvertBreachesSponsorThreshold();
    error ZeroAmount();
    error AdminLocked();
    error ManagerLocked();
    error GovernorLocked();
    error TooManyNavigators();
    error InvalidPermission();
    error SponsorThresholdExceedsSupply();
    error CanOnlyTargetSelf();
    error InvalidValue();

    error InsufficientShares();
    error NotSubmitted();
    error AlreadySponsored();

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Constructor for DAOShip singleton
     * @dev Sets avatar to a sentinel value to block setUp() on the singleton.
     *      Clones have zeroed storage so their setUp() call proceeds normally.
     *      Without this guard, the singleton implementation itself could be initialized
     *      and used as a live DAO — a dangerous footgun.
     */
    constructor() {
        // Sentinel: marks this singleton as already-initialized so clones are safe
        avatar = address(0xdead);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Initialize DAOShip clone with DAO parameters
     * @dev Called by DAOShipLauncher after clone deployment
     *      Can only be called once (avatar == address(0) check)
     * @param _initializationParams ABI-encoded initialization data:
     *        - address lootToken: LootERC20 address
     *        - address sharesToken: SharesERC20 address
     *        - address avatar: Quai Vault address
     *        - address multisendLibrary: MultiSend library address
     *        - bytes governanceConfig: Encoded governance params
     *        - address[] navigators: Initial navigator addresses
     *        - uint256[] navigatorPermissions: Permission bitmasks for navigators
     *        - address[] initMembers: Initial member addresses
     *        - uint256[] initShareAmounts: Initial share amounts
     *        - uint256[] initLootAmounts: Initial loot amounts
     *        - address[] guildTokens: Initial ragequittable token addresses
     *        - bool pauseSharesOnLaunch: Pause share transfers after minting
     *        - bool pauseLootOnLaunch: Pause loot transfers after minting
     */
    function setUp(bytes memory _initializationParams) external {
        if (avatar != address(0)) revert AlreadyInitialized();

        (
            address _lootToken,
            address _sharesToken,
            address _avatar,
            address _multisendLibrary,
            bytes memory _governanceConfig,
            address[] memory _navigators,
            uint256[] memory _navigatorPermissions,
            address[] memory _initMembers,
            uint256[] memory _initShareAmounts,
            uint256[] memory _initLootAmounts,
            address[] memory _guildTokens,
            bool _pauseSharesOnLaunch,
            bool _pauseLootOnLaunch
        ) = abi.decode(
            _initializationParams,
            (address, address, address, address, bytes, address[], uint256[], address[], uint256[], uint256[], address[], bool, bool)
        );

        // Validate core addresses
        if (_lootToken == address(0)) revert InvalidAddress();
        if (_sharesToken == address(0)) revert InvalidAddress();
        if (_avatar == address(0)) revert InvalidAddress();
        if (_multisendLibrary == address(0) || _multisendLibrary.code.length == 0) revert InvalidAddress();

        // Set core addresses
        lootToken = IDAOShipToken(_lootToken);
        sharesToken = IDAOShipVotingToken(_sharesToken);
        avatar = _avatar;
        multisendLibrary = _multisendLibrary;

        // Decode and set governance config
        (
            uint32 _votingPeriod,
            uint32 _gracePeriod,
            uint256 _proposalOffering,
            uint256 _quorumPercent,
            uint256 _sponsorThreshold,
            uint256 _minRetentionPercent,
            uint32 _defaultExpiryWindow
        ) = abi.decode(_governanceConfig, (uint32, uint32, uint256, uint256, uint256, uint256, uint32));

        _validateGovernanceConfig(_votingPeriod, _gracePeriod, _quorumPercent, _minRetentionPercent);

        votingPeriod = _votingPeriod;
        gracePeriod = _gracePeriod;
        proposalOffering = _proposalOffering;
        quorumPercent = _quorumPercent;
        sponsorThreshold = _sponsorThreshold;
        minRetentionPercent = _minRetentionPercent;
        defaultExpiryWindow = _defaultExpiryWindow;

        // Set initial navigators
        if (_navigators.length != _navigatorPermissions.length) revert LengthMismatch();
        for (uint256 i = 0; i < _navigators.length; i++) {
            if (_navigators[i] != address(0)) {
                if (_navigatorPermissions[i] > MAX_PERMISSION) revert InvalidPermission();
                navigators[_navigators[i]] = _navigatorPermissions[i];
                emit NavigatorSet(_navigators[i], _navigatorPermissions[i]);
            }
        }

        // Set initial guild tokens (deduplicated)
        for (uint256 i = 0; i < _guildTokens.length; i++) {
            if (!guildTokens[_guildTokens[i]]) {
                guildTokens[_guildTokens[i]] = true;
                _guildTokenList.push(_guildTokens[i]);
            }
        }

        // Mint initial shares and loot
        if (_initMembers.length != _initShareAmounts.length || _initMembers.length != _initLootAmounts.length) revert LengthMismatch();

        for (uint256 i = 0; i < _initMembers.length; i++) {
            if (_initMembers[i] != address(0)) {
                if (_initShareAmounts[i] > 0) {
                    sharesToken.mint(_initMembers[i], _initShareAmounts[i]);
                    totalShares += _initShareAmounts[i];
                }
                if (_initLootAmounts[i] > 0) {
                    lootToken.mint(_initMembers[i], _initLootAmounts[i]);
                    totalLoot += _initLootAmounts[i];
                }
            }
        }

        // Pause tokens if requested (after minting so founding members receive tokens)
        if (_pauseSharesOnLaunch) sharesToken.pause();
        if (_pauseLootOnLaunch) lootToken.pause();

        // Emit setup complete with initial guild tokens
        emit SetupComplete(
            lootToken.paused(),
            sharesToken.paused(),
            gracePeriod,
            votingPeriod,
            proposalOffering,
            quorumPercent,
            sponsorThreshold,
            minRetentionPercent,
            sharesToken.name(),
            sharesToken.symbol(),
            lootToken.name(),
            lootToken.symbol(),
            _guildTokens,
            totalShares,
            totalLoot
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Only allows DAOShip itself (via proposal execution)
     */
    modifier governanceOnly() {
        if (msg.sender != address(this)) revert NotGovernance();
        _;
    }

    /**
     * @notice Only allows addresses with ADMIN permission or governance (address(this))
     * @dev Locks are NOT checked here — they are enforced in setNavigators() only,
     *      matching upstream MolochV3 behavior. Locks prevent NEW navigator assignments
     *      with that permission, not function execution by existing navigators or governance.
     */
    modifier onlyAdmin() {
        if ((navigators[msg.sender] & ADMIN) == 0 && msg.sender != address(this)) revert NotAdmin();
        _;
    }

    /**
     * @notice Only allows addresses with MANAGER permission or governance (address(this))
     * @dev See onlyAdmin NatSpec — locks enforced in setNavigators(), not here.
     */
    modifier onlyManager() {
        if ((navigators[msg.sender] & MANAGER) == 0 && msg.sender != address(this)) revert NotManager();
        _;
    }

    /**
     * @notice Only allows addresses with GOVERNOR permission or governance (address(this))
     * @dev See onlyAdmin NatSpec — locks enforced in setNavigators(), not here.
     */
    modifier onlyGovernor() {
        if ((navigators[msg.sender] & GOVERNOR) == 0 && msg.sender != address(this)) revert NotGovernor();
        _;
    }

    /**
     * @notice Only allows avatar (via proposals) or DAOShip itself (internal calls)
     */
    modifier governanceOrAvatar() {
        if (msg.sender != avatar && msg.sender != address(this)) revert NotAuthorized();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Get the current state of a proposal
     * @param id Proposal ID
     * @return ProposalState enum value
     */
    function state(uint32 id) public view returns (ProposalState) {
        Proposal storage prop = proposals[id];

        // Proposal doesn't exist
        if (prop.id == 0) return ProposalState.Unborn;

        // Proposal was cancelled
        if (prop.status[0]) return ProposalState.Cancelled;

        // Proposal was processed (status[1]=true means processProposal was called)
        if (prop.status[1]) {
            // Check if it passed or was defeated
            return prop.status[2] ? ProposalState.Processed : ProposalState.Defeated;
        }

        // Not sponsored yet
        if (prop.sponsor == address(0)) return ProposalState.Submitted;

        // Check expiration (explicit)
        if (prop.expiration != 0 && block.timestamp > prop.expiration) {
            return ProposalState.Expired;
        }

        // Check current phase based on timestamps
        if (block.timestamp < prop.votingEnds) return ProposalState.Voting;
        if (block.timestamp < prop.graceEnds) return ProposalState.Grace;

        // Past grace period — check auto-defeat before Ready/Expired
        // Auto-defeat: if the proposal cannot possibly pass (failed quorum or majority),
        // surface it as Defeated immediately without requiring processProposal
        if (!_didProposalPass(id)) return ProposalState.Defeated;

        // M-7: Auto-expiry for passing proposals with no explicit expiration that have sat in
        //      Ready state for too long (prevents zombie proposals from remaining processable indefinitely)
        if (prop.expiration == 0) {
            uint256 window = defaultExpiryWindow > 0
                ? uint256(defaultExpiryWindow)
                : 2 * (uint256(votingPeriod) + uint256(gracePeriod));
            if (block.timestamp > prop.graceEnds + window) return ProposalState.Expired;
        }

        // Ready to process
        return ProposalState.Ready;
    }

    /**
     * @notice Get proposal status flags
     * @param id Proposal ID
     * @return status Boolean array [cancelled, processed, passed, actionFailed]
     */
    function getProposalStatus(uint32 id) external view returns (bool[4] memory status) {
        return proposals[id].status;
    }

    /**
     * @notice Get current voting power for an account
     * @param account Address to query
     * @return Current delegation-aware voting power
     */
    function getCurrentVotes(address account) external view returns (uint256) {
        return sharesToken.getCurrentVotes(account);
    }

    /**
     * @notice Get historical voting power at a specific timestamp
     * @param account Address to query
     * @param timepoint Timestamp to query (must be in past)
     * @return Voting power at the given timestamp
     */
    function getPriorVotes(address account, uint256 timepoint) public view returns (uint256) {
        return sharesToken.getPriorVotes(account, timepoint);
    }

    /**
     * @notice Get total supply (shares + loot)
     * @dev totalShares and totalLoot are available as public state variables
     * @return Total supply
     */
    function totalSupply() external view returns (uint256) {
        return totalShares + totalLoot;
    }

    /**
     * @notice Check if an address has ADMIN permission
     * @param account Address to check
     * @return True if account has ADMIN permission
     */
    function isAdmin(address account) external view returns (bool) {
        return (navigators[account] & ADMIN) != 0;
    }

    /**
     * @notice Check if an address has MANAGER permission
     * @param account Address to check
     * @return True if account has MANAGER permission
     */
    function isManager(address account) external view returns (bool) {
        return (navigators[account] & MANAGER) != 0;
    }

    /**
     * @notice Check if an address has GOVERNOR permission
     * @param account Address to check
     * @return True if account has GOVERNOR permission
     */
    function isGovernor(address account) external view returns (bool) {
        return (navigators[account] & GOVERNOR) != 0;
    }

    /**
     * @notice Get all registered guild tokens
     * @dev Enables on-chain enumeration without event replay. Useful for frontends
     *      building ragequit UIs that need to show available tokens.
     * @return Array of registered guild token addresses
     */
    function getGuildTokens() external view returns (address[] memory) {
        return _guildTokenList;
    }

    /**
     * @notice Hash proposal data (ABI-encoded)
     * @dev Returns keccak256(abi.encode(_transactions)) — not keccak256(_transactions).
     *      This matches the encoding used in submitProposal's proposalDataHash field,
     *      allowing callers to verify the hash before passing proposalData to processProposal.
     * @param _transactions Proposal data to hash
     * @return bytes32 Keccak256 hash of ABI-encoded transactions
     */
    function hashOperation(bytes memory _transactions) external pure returns (bytes32) {
        return keccak256(abi.encode(_transactions));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // PROPOSAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Submit a new proposal
     * @param proposalData Encoded proposal data (for MultiSend or single action)
     * @param expiration Expiration timestamp (0 for no expiration)
     * @param details IPFS hash or metadata string
     * @return proposal Proposal ID
     */
    function submitProposal(
        bytes calldata proposalData,
        uint40 expiration,
        string calldata details
    ) external payable nonReentrant returns (uint256 proposal) {
        // H-4 + M-6: Use historical snapshot (block.timestamp - 1) to prevent flash-loan
        //            delegation attacks. Compare against _effectiveSponsorThreshold() to handle
        //            the edge case where sponsorThreshold exceeds current total supply.
        bool selfSponsor = sharesToken.getPriorVotes(msg.sender, block.timestamp - 1) >= _effectiveSponsorThreshold();

        // Self-sponsors (members above threshold) are exempt from the proposal offering —
        // their stake in the DAO serves as implicit spam deterrent.
        // Non-members must pay exactly the required offering.
        if (selfSponsor) {
            if (msg.value != 0) revert SelfSponsorNoOffering();
        } else {
            if (msg.value != proposalOffering) revert IncorrectOffering();
        }

        // Expiration must leave room for the full voting + grace cycle
        if (expiration != 0 && expiration <= block.timestamp + uint256(votingPeriod) + uint256(gracePeriod)) revert ExpirationTooSoon();

        // Send proposal offering to treasury (avatar)
        if (msg.value > 0) {
            (bool success, ) = avatar.call{value: msg.value}("");
            if (!success) revert OfferingTransferFailed();
        }

        // L-2: Explicit overflow guard — uint32 wrapping would silently overwrite proposal 0
        if (proposalCount >= type(uint32).max) revert ProposalLimitReached();

        // Increment proposal count
        proposalCount++;
        uint32 id = proposalCount;

        // Create proposal — write only non-zero fields to avoid paying for zero-writes
        // (sponsor, votingStarts/Ends, graceEnds, yesVotes, noVotes,
        //  yesBalance, noBalance, maxTotalSharesAtSponsor, status are all set later or default to 0/false)
        Proposal storage prop = proposals[id];
        prop.id = id;
        prop.proposalDataHash = keccak256(abi.encode(proposalData));
        prop.submitter = msg.sender;
        if (expiration != 0) prop.expiration = expiration;
        prop.details = details;

        emit SubmitProposal(
            id,
            prop.proposalDataHash,
            msg.sender,
            votingPeriod,
            proposalData,
            expiration,
            selfSponsor,
            block.timestamp,
            details,
            msg.value
        );

        // Auto-sponsor if threshold met
        if (selfSponsor) {
            _sponsorProposal(id, msg.sender);
        }

        return id;
    }

    /**
     * @notice Sponsor a submitted proposal
     * @param id Proposal ID to sponsor
     */
    function sponsorProposal(uint32 id) external nonReentrant {
        // H-4: Use historical snapshot to prevent flash-loan delegation gaming
        if (sharesToken.getPriorVotes(msg.sender, block.timestamp - 1) < _effectiveSponsorThreshold()) revert InsufficientShares();
        _sponsorProposal(id, msg.sender);
    }

    /**
     * @notice Internal sponsor function
     * @param id Proposal ID
     * @param sponsor Sponsor address
     */
    function _sponsorProposal(uint32 id, address sponsor) internal {
        Proposal storage prop = proposals[id];

        if (prop.id == 0) revert InvalidProposal();
        if (prop.sponsor != address(0)) revert AlreadySponsored();
        if (state(id) != ProposalState.Submitted) revert NotSubmitted();

        // Check expiration
        if (prop.expiration != 0) {
            if (block.timestamp > prop.expiration) revert Expired();
        }

        // Update proposal
        prop.sponsor = sponsor;
        prop.votingStarts = uint40(block.timestamp);
        prop.votingEnds = uint40(block.timestamp) + votingPeriod;
        prop.graceEnds = uint40(block.timestamp) + votingPeriod + gracePeriod;

        // Capture total shares snapshot for quorum calculation (C-1 fix)
        prop.maxTotalSharesAtSponsor = sharesToken.totalSupply();
        // Initialize high water mark for retention check — tracks peak total supply during voting
        prop.maxTotalSharesAndLootAtVote = sharesToken.totalSupply() + lootToken.totalSupply();

        emit SponsorProposal(sponsor, id, prop.votingStarts, prop.votingEnds, prop.graceEnds, prop.maxTotalSharesAtSponsor, prop.maxTotalSharesAndLootAtVote);
    }

    /**
     * @notice Submit a vote on a proposal
     * @param id Proposal ID
     * @param approved True for yes, false for no
     */
    function submitVote(uint32 id, bool approved) external nonReentrant {
        _submitVote(id, approved);
    }

    /**
     * @notice Submit votes on multiple proposals in a single transaction
     * @dev Saves ~21K base gas per additional vote (avoids per-transaction overhead).
     *      With parallel execution, multiple proposals can be in Voting state simultaneously.
     * @param ids Proposal IDs to vote on
     * @param approved Vote direction for each proposal (true = yes, false = no)
     */
    function submitVotes(uint32[] calldata ids, bool[] calldata approved) external nonReentrant {
        if (ids.length != approved.length) revert LengthMismatch();
        for (uint256 i = 0; i < ids.length; i++) {
            _submitVote(ids[i], approved[i]);
        }
    }

    /**
     * @notice Internal vote submission logic
     */
    function _submitVote(uint32 id, bool approved) internal {
        Proposal storage prop = proposals[id];

        // Inline voting-state check — avoids full state() computation which includes
        // _didProposalPass and auto-expiry logic irrelevant during active voting.
        if (prop.votingStarts == 0 || prop.status[0] || prop.status[1]) revert NotVoting();
        if (block.timestamp < prop.votingStarts || block.timestamp >= prop.votingEnds) revert NotVoting();
        if (memberVoted[msg.sender][id]) revert AlreadyVoted();

        // Get voting power at snapshot (votingStarts = block.timestamp at sponsor time).
        // getPriorVotes requires timepoint < block.timestamp, so members who receive
        // tokens in the same block as sponsorship cannot vote on that proposal — this
        // prevents same-block manipulation of voting power.
        uint256 balance = getPriorVotes(msg.sender, prop.votingStarts);
        if (balance == 0) revert InsufficientVotingPower();

        // Record vote
        memberVoted[msg.sender][id] = true;

        // Update high water mark — tracks peak total supply during voting for retention check.
        uint256 currentTotalSupply = sharesToken.totalSupply() + lootToken.totalSupply();
        if (currentTotalSupply > prop.maxTotalSharesAndLootAtVote) {
            prop.maxTotalSharesAndLootAtVote = currentTotalSupply;
        }

        if (approved) {
            prop.yesVotes++;
            prop.yesBalance += balance;
        } else {
            prop.noVotes++;
            prop.noBalance += balance;
        }

        emit SubmitVote(msg.sender, balance, id, approved);
    }

    /**
     * @notice Process a proposal (execute if passed)
     * @param id Proposal ID
     * @param proposalData Original proposal data (must match hash)
     */
    function processProposal(uint32 id, bytes calldata proposalData) external nonReentrant {
        // H-2: Fail fast if DAOShip is not an enabled module on the vault.
        // Without this check, proposals silently fail (actionFailed=true) and members
        // may not realize the vault was never configured or DAOShip was removed as a module.
        if (!IAvatar(avatar).isModuleEnabled(address(this))) revert NotEnabledModule();

        Proposal storage prop = proposals[id];

        // Accept both Ready and Defeated states (Defeated proposals can be formally closed)
        ProposalState currentState = state(id);
        if (currentState != ProposalState.Ready && currentState != ProposalState.Defeated) revert NotReady();
        if (prop.status[1]) revert AlreadyProcessed();
        // Defeated proposals can be closed with empty data since they will never execute.
        // This allows formally closing defeated proposals without requiring the original data.
        if (currentState != ProposalState.Defeated) {
            if (keccak256(abi.encode(proposalData)) != prop.proposalDataHash) revert HashMismatch();
        }

        // Check expiration
        if (prop.expiration != 0) {
            if (block.timestamp > prop.expiration) revert Expired();
        }

        // Mark as processed
        prop.status[1] = true;

        // If state() returned Ready, _didProposalPass already confirmed the proposal passed
        // (state() calls _didProposalPass at line 708 and returns Defeated if it fails).
        // Skip the redundant call for Ready proposals.
        bool passed = currentState == ProposalState.Ready;

        // Ragequit-as-veto: if current total supply has fallen below the retention threshold
        // relative to the high water mark during voting, the proposal is defeated regardless of vote.
        // The high water mark captures peak supply during voting — if new members joined (organic
        // growth), the threshold rises, protecting the proposal's legitimacy. If members ragequit
        // during grace, supply drops below the threshold and the proposal is blocked.
        if (passed && minRetentionPercent > 0) {
            uint256 retentionRequired = (prop.maxTotalSharesAndLootAtVote * minRetentionPercent) / BASIS_POINTS_DIVISOR;
            if (sharesToken.totalSupply() + lootToken.totalSupply() < retentionRequired) {
                passed = false;
            }
        }

        prop.status[2] = passed;

        bool actionFailed = false;

        // Execute if passed
        if (passed && proposalData.length > 0) {
            // H-1: Set flag so executeAsGovernance can verify it is being called within a proposal
            _inProposalExecution = true;

            // Execute via IAvatar
            bool success;
            try IAvatar(avatar).execTransactionFromModule(
                multisendLibrary,
                0,
                proposalData,
                Enum.Operation.DelegateCall
            ) returns (bool result) {
                success = result;
            } catch {
                success = false;
            }

            // H-1: Always clear flag after execution, even on failure
            _inProposalExecution = false;

            actionFailed = !success;
            prop.status[3] = actionFailed;
        }

        emit ProcessProposal(id, passed, actionFailed, msg.sender);
    }

    /**
     * @notice Cancel a proposal
     * @param id Proposal ID
     */
    function cancelProposal(uint32 id) external nonReentrant {
        Proposal storage prop = proposals[id];

        if (prop.id == 0) revert InvalidProposal();
        if (prop.status[0]) revert AlreadyCancelled();
        if (prop.status[1]) revert AlreadyProcessed();

        // Only Submitted or Voting proposals can be cancelled
        ProposalState currentState = state(id);
        if (currentState != ProposalState.Submitted && currentState != ProposalState.Voting) revert NotCancellable();

        // H-4: Anyone can cancel a sponsored proposal if the sponsor's votes have fallen
        //      below the effective threshold (prevents a delegated-then-withdrawn sponsor
        //      from keeping an illegitimate proposal alive)
        bool sponsorFellBelow = prop.sponsor != address(0) &&
            sharesToken.getPriorVotes(prop.sponsor, block.timestamp - 1) < _effectiveSponsorThreshold();

        // Only submitter, governor, or anyone if sponsor fell below threshold can cancel
        if (msg.sender != prop.submitter &&
            (navigators[msg.sender] & GOVERNOR) == 0 &&
            !sponsorFellBelow) revert NotAuthorized();

        prop.status[0] = true;

        emit CancelProposal(id, msg.sender);
    }

    /**
     * @notice Check if proposal passed quorum and majority
     * @param id Proposal ID
     * @return True if passed, false otherwise
     */
    function _didProposalPass(uint32 id) internal view returns (bool) {
        Proposal storage prop = proposals[id];

        // Use snapshot from sponsorship time (C-1 fix)
        // This prevents quorum manipulation via post-vote minting/burning
        uint256 totalSharesAtVote = prop.maxTotalSharesAtSponsor;

        // Check quorum (yes votes must meet minimum threshold)
        uint256 quorumRequired = (totalSharesAtVote * quorumPercent) / BASIS_POINTS_DIVISOR;
        if (prop.yesBalance < quorumRequired) {
            return false;
        }

        // Check majority (yes must exceed no)
        return prop.yesBalance > prop.noBalance;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // NAVIGATOR FUNCTIONS (MANAGER PERMISSION)
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Mint shares to addresses
     * @param to Addresses to receive shares
     * @param amount Amounts to mint
     */
    function mintShares(address[] calldata to, uint256[] calldata amount) external onlyManager {
        if (to.length != amount.length) revert LengthMismatch();
        if (to.length == 0) revert EmptyArrays();

        for (uint256 i = 0; i < to.length; i++) {
            sharesToken.mint(to[i], amount[i]);
            totalShares += amount[i];
        }

        emit MintShares(to, amount);
    }

    /**
     * @notice Mint loot to addresses
     * @param to Addresses to receive loot
     * @param amount Amounts to mint
     */
    function mintLoot(address[] calldata to, uint256[] calldata amount) external onlyManager {
        if (to.length != amount.length) revert LengthMismatch();
        if (to.length == 0) revert EmptyArrays();

        for (uint256 i = 0; i < to.length; i++) {
            lootToken.mint(to[i], amount[i]);
            totalLoot += amount[i];
        }

        emit MintLoot(to, amount);
    }

    /**
     * @notice Burn shares from addresses
     * @param from Addresses to burn shares from
     * @param amount Amounts to burn
     */
    function burnShares(address[] calldata from, uint256[] calldata amount) external onlyManager {
        if (from.length != amount.length) revert LengthMismatch();
        if (from.length == 0) revert EmptyArrays();

        // L-1: Prevent burning shares below sponsorThreshold — a zero-share supply would
        //      permanently deadlock governance (no one could ever meet the threshold to sponsor)
        uint256 totalToBurn;
        for (uint256 i = 0; i < amount.length; i++) {
            totalToBurn += amount[i];
        }
        if (sharesToken.totalSupply() < sponsorThreshold + totalToBurn) revert BurnBreachesSponsorThreshold();

        for (uint256 i = 0; i < from.length; i++) {
            sharesToken.burn(from[i], amount[i]);
            totalShares -= amount[i];
        }

        emit BurnShares(from, amount);
    }

    /**
     * @notice Burn loot from addresses
     * @param from Addresses to burn loot from
     * @param amount Amounts to burn
     */
    function burnLoot(address[] calldata from, uint256[] calldata amount) external onlyManager {
        if (from.length != amount.length) revert LengthMismatch();
        if (from.length == 0) revert EmptyArrays();

        for (uint256 i = 0; i < from.length; i++) {
            lootToken.burn(from[i], amount[i]);
            totalLoot -= amount[i];
        }

        emit BurnLoot(from, amount);
    }

    /**
     * @notice Convert shares to loot for a member, preserving economic weight while removing
     *         voting weight. Atomic — no intermediate state where the member holds neither.
     * @dev MANAGER only. The burnShares sponsorThreshold guard applies: if converting `amount`
     *      shares would drop totalSupply below sponsorThreshold, this call reverts.
     * @param from Account whose shares to convert.
     * @param amount Number of shares to convert to loot.
     */
    function convertSharesToLoot(address from, uint256 amount) external onlyManager {
        if (amount == 0) revert ZeroAmount();
        if (sharesToken.totalSupply() < sponsorThreshold + amount) revert ConvertBreachesSponsorThreshold();
        sharesToken.burn(from, amount);
        totalShares -= amount;
        lootToken.mint(from, amount);
        totalLoot += amount;
        emit ConvertSharesToLoot(from, amount);
    }

    /**
     * @notice Set admin config (pause tokens)
     * @param pauseShares Whether to pause shares token
     * @param pauseLoot Whether to pause loot token
     */
    function setAdminConfig(bool pauseShares, bool pauseLoot) external onlyAdmin {
        if (pauseShares && !sharesToken.paused()) {
            sharesToken.pause();
        } else if (!pauseShares && sharesToken.paused()) {
            sharesToken.unpause();
        }

        if (pauseLoot && !lootToken.paused()) {
            lootToken.pause();
        } else if (!pauseLoot && lootToken.paused()) {
            lootToken.unpause();
        }

        emit AdminConfigSet(pauseShares, pauseLoot);
    }

    /**
     * @notice Set governance configuration
     * @param _governanceConfig Encoded governance params (7 values: uint32 votingPeriod,
     *        uint32 gracePeriod, uint256 proposalOffering, uint256 quorumPercent,
     *        uint256 sponsorThreshold, uint256 minRetentionPercent, uint32 defaultExpiryWindow)
     */
    function setGovernanceConfig(bytes calldata _governanceConfig) external onlyGovernor {
        (
            uint32 _votingPeriod,
            uint32 _gracePeriod,
            uint256 _proposalOffering,
            uint256 _quorumPercent,
            uint256 _sponsorThreshold,
            uint256 _minRetentionPercent,
            uint32 _defaultExpiryWindow
        ) = abi.decode(_governanceConfig, (uint32, uint32, uint256, uint256, uint256, uint256, uint32));

        _validateGovernanceConfig(_votingPeriod, _gracePeriod, _quorumPercent, _minRetentionPercent);
        if (_sponsorThreshold > sharesToken.totalSupply()) revert SponsorThresholdExceedsSupply();

        votingPeriod = _votingPeriod;
        gracePeriod = _gracePeriod;
        proposalOffering = _proposalOffering;
        quorumPercent = _quorumPercent;
        sponsorThreshold = _sponsorThreshold;
        minRetentionPercent = _minRetentionPercent;
        defaultExpiryWindow = _defaultExpiryWindow;

        emit GovernanceConfigSet(
            _votingPeriod,
            _gracePeriod,
            _proposalOffering,
            _quorumPercent,
            _sponsorThreshold,
            _minRetentionPercent,
            _defaultExpiryWindow
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // GOVERNANCE-ONLY FUNCTIONS (VIA PROPOSAL)
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Set navigators (can only be called by DAOShip via proposal)
     * @param _navigators Navigator addresses
     * @param _permissions Permission bitmasks
     */
    function setNavigators(address[] calldata _navigators, uint256[] calldata _permissions) external governanceOnly {
        if (_navigators.length != _permissions.length) revert LengthMismatch();
        if (_navigators.length > MAX_NAVIGATORS_PER_CALL) revert TooManyNavigators();

        for (uint256 i = 0; i < _navigators.length; i++) {
            // Only valid permission bits are ADMIN(1), MANAGER(2), GOVERNOR(4) — max 7.
            // Permission 0 is valid (revokes all permissions).
            if (_permissions[i] > MAX_PERMISSION) revert InvalidPermission();
            // Respect lock flags: reject if the permission being granted includes a locked role
            if ((_permissions[i] & ADMIN) != 0 && adminLock) revert AdminLocked();
            if ((_permissions[i] & MANAGER) != 0 && managerLock) revert ManagerLocked();
            if ((_permissions[i] & GOVERNOR) != 0 && governorLock) revert GovernorLocked();
            navigators[_navigators[i]] = _permissions[i];
            emit NavigatorSet(_navigators[i], _permissions[i]);
        }
    }

    /**
     * @notice Set guild tokens (enable/disable for ragequit)
     * @param _tokens Token addresses
     * @param _enabled Whether tokens are enabled
     */
    function setGuildTokens(address[] calldata _tokens, bool[] calldata _enabled) external governanceOnly {
        if (_tokens.length != _enabled.length) revert LengthMismatch();

        for (uint256 i = 0; i < _tokens.length; i++) {
            if (_enabled[i] && !guildTokens[_tokens[i]]) {
                // Adding a new guild token
                guildTokens[_tokens[i]] = true;
                _guildTokenList.push(_tokens[i]);
            } else if (!_enabled[i] && guildTokens[_tokens[i]]) {
                // Removing an existing guild token — swap-and-pop
                guildTokens[_tokens[i]] = false;
                for (uint256 j = 0; j < _guildTokenList.length; j++) {
                    if (_guildTokenList[j] == _tokens[i]) {
                        _guildTokenList[j] = _guildTokenList[_guildTokenList.length - 1];
                        _guildTokenList.pop();
                        break;
                    }
                }
            }
        }

        emit SetGuildTokens(_tokens, _enabled);
    }

    /**
     * @notice Lock admin navigator assignment permanently
     * @dev IRREVERSIBLE — once called, setNavigators cannot grant ADMIN permission to new navigators.
     *      Existing ADMIN navigators retain their powers. Governance proposals can still call
     *      admin functions (setAdminConfig) via executeAsGovernance.
     */
    function lockAdmin() external governanceOnly {
        adminLock = true;
        emit LockAdmin(true);
    }

    /**
     * @notice Lock manager navigator assignment permanently
     * @dev IRREVERSIBLE — once called, setNavigators cannot grant MANAGER permission to new navigators.
     *      Existing MANAGER navigators retain their powers. Governance proposals can still call
     *      manager functions (mintShares, burnShares, etc.) via executeAsGovernance.
     */
    function lockManager() external governanceOnly {
        managerLock = true;
        emit LockManager(true);
    }

    /**
     * @notice Lock governor navigator assignment permanently
     * @dev IRREVERSIBLE — once called, setNavigators cannot grant GOVERNOR permission to new navigators.
     *      Existing GOVERNOR navigators retain their powers. Governance proposals can still call
     *      governor functions (setGovernanceConfig) via executeAsGovernance.
     */
    function lockGovernor() external governanceOnly {
        governorLock = true;
        emit LockGovernor(true);
    }

    /**
     * @notice Execute arbitrary call as DAOShip (via proposal)
     * @dev Can only be called by avatar (via proposal) during active proposal execution.
     *      This enables calling governanceOnly functions via governance proposals.
     *
     *      The self-call (`address(this).call(_data)`) means `msg.sender` inside the
     *      called function becomes `address(this)`, passing all permission modifiers.
     *      However, functions with `nonReentrant` (submitProposal, sponsorProposal,
     *      submitVote, processProposal, ragequit, cancelProposal) are unreachable via
     *      this path because `processProposal` already holds the reentrancy lock.
     *      This is correct — governance should not recursively submit/process proposals.
     *
     *      Reachable functions: setNavigators, setGuildTokens, lockAdmin/Manager/Governor,
     *      mintShares, mintLoot, burnShares, burnLoot, setAdminConfig, setGovernanceConfig,
     *      convertSharesToLoot.
     *
     * @param _to Must be address(this) — only DAOShip's own functions can be called
     * @param _value Must be 0 — DAOShip has no receive() and cannot hold ETH
     * @param _data Encoded function call to execute on DAOShip
     */
    function executeAsGovernance(address _to, uint256 _value, bytes calldata _data) external governanceOrAvatar {
        // H-1: Prevent executeAsGovernance from being called outside of an active proposal execution.
        //      Without this guard, any address whitelisted as avatar could call executeAsGovernance
        //      at any time, bypassing the governance process entirely.
        if (!_inProposalExecution) revert NotAuthorized();
        // _to is validated but not used as the call target — all calls route to address(this).
        // This preserves the upstream ABI signature while ensuring executeAsGovernance can
        // only invoke DAOShip's own functions (the H-1 security fix).
        if (_to != address(this)) revert CanOnlyTargetSelf();
        // DAOShip has no receive()/fallback() and cannot hold ETH — the vault is the treasury.
        // ETH-bearing governance actions should go through proposal execution, not self-calls.
        if (_value != 0) revert InvalidValue();
        (bool success, bytes memory returnData) = address(this).call(_data);
        if (!success) {
            // Bubble up the inner revert reason for debuggability (visible in traces)
            assembly ("memory-safe") {
                revert(add(returnData, 32), mload(returnData))
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // RAGEQUIT
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Ragequit: burn shares/loot to withdraw proportional treasury assets
     * @dev The `to` address receives ETH and ERC20 transfers during the withdrawal loop.
     *      If `to` is a contract, its receive()/fallback() will execute mid-loop. The
     *      nonReentrant guard prevents re-entering ragequit, but does not prevent callbacks
     *      into other DAOShip functions. In practice this is safe because:
     *      - The pre-burn `currentTotalSupply` snapshot is already captured
     *      - Burns are completed before any transfers
     *      - A callback into mintShares/burnShares would require MANAGER permission
     *      For maximum safety, use an EOA or trusted contract as the `to` address.
     * @param to Address to receive withdrawn assets (EOA recommended)
     * @param sharesToBurn Amount of shares to burn
     * @param lootToBurn Amount of loot to burn
     * @param tokens Guild tokens to withdraw (must be sorted ascending, no duplicates)
     */
    function ragequit(
        address to,
        uint256 sharesToBurn,
        uint256 lootToBurn,
        address[] calldata tokens
    ) external nonReentrant {
        // H-2: Fail fast if DAOShip is not an enabled module on the vault.
        // Ragequit transfers assets from the vault via execTransactionFromModule — if DAOShip
        // is not a module, every transfer would revert AFTER shares/loot are already burned,
        // but EVM atomicity protects us. This guard gives a clear error message instead.
        if (!IAvatar(avatar).isModuleEnabled(address(this))) revert NotEnabledModule();
        if (to == address(0)) revert InvalidRecipient();

        uint256 totalToBurn = sharesToBurn + lootToBurn;
        if (totalToBurn == 0) revert NothingToBurn();

        uint256 currentTotalShares = sharesToken.totalSupply();
        uint256 currentTotalLoot = lootToken.totalSupply();
        uint256 currentTotalSupply = currentTotalShares + currentTotalLoot;

        // Check retention requirement
        uint256 minRetention = (currentTotalSupply * minRetentionPercent) / BASIS_POINTS_DIVISOR;
        if (currentTotalSupply - totalToBurn < minRetention) revert InsufficientRetention();

        // Validate tokens: each must be a registered guild token and the array must be
        // sorted in strictly ascending order by address value. Ascending order enforces
        // uniqueness in O(n) (equal addresses would fail the strict > check) and prevents
        // callers from gaming the withdrawal order.
        for (uint256 i = 0; i < tokens.length; i++) {
            if (!guildTokens[tokens[i]]) revert NotGuildToken();
            if (i > 0) {
                if (uint160(tokens[i]) <= uint160(tokens[i - 1])) revert TokensNotSorted();
            }
        }

        // Burn shares and loot
        if (sharesToBurn > 0) {
            sharesToken.burn(msg.sender, sharesToBurn);
            totalShares -= sharesToBurn;
        }

        if (lootToBurn > 0) {
            lootToken.burn(msg.sender, lootToBurn);
            totalLoot -= lootToBurn;
        }

        // Withdraw proportional assets
        // Cache avatar address to save gas (L-2 optimization)
        address avatarCache = avatar;
        uint256[] memory fairShares = new uint256[](tokens.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 balance;

            // Handle ETH (address(0)) vs ERC20 tokens
            if (tokens[i] == address(0)) {
                // ETH balance
                balance = avatarCache.balance;
            } else {
                // ERC20 token balance
                (bool success, bytes memory data) = tokens[i].staticcall(
                    abi.encodeWithSelector(IERC20.balanceOf.selector, avatarCache)
                );
                if (!success) revert BalanceQueryFailed();
                balance = abi.decode(data, (uint256));
            }

            // Calculate fair share
            fairShares[i] = (balance * totalToBurn) / currentTotalSupply;

            if (fairShares[i] > 0) {
                if (tokens[i] == address(0)) {
                    // Transfer ETH via IAvatar
                    bool execSuccess = IAvatar(avatarCache).execTransactionFromModule(
                        to,
                        fairShares[i],
                        "",
                        Enum.Operation.Call
                    );
                    if (!execSuccess) revert ETHTransferFailed();
                } else {
                    // Transfer ERC20 via IAvatar
                    bool execSuccess = IAvatar(avatarCache).execTransactionFromModule(
                        tokens[i],
                        0,
                        abi.encodeWithSelector(IERC20.transfer.selector, to, fairShares[i]),
                        Enum.Operation.Call
                    );
                    if (!execSuccess) revert TokenTransferFailed();
                }
            }
        }

        emit Ragequit(msg.sender, to, lootToBurn, sharesToBurn, tokens, fairShares);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Compute the effective sponsor threshold, capped at total supply
     * @dev L-1: If sponsorThreshold exceeds current total supply (e.g. after burns), using the
     *      raw sponsorThreshold would make it permanently impossible to sponsor proposals.
     *      This function returns the lesser of sponsorThreshold and totalSupply, except when
     *      totalSupply is 0 (returns 0 to avoid deadlock on empty DAOs).
     *
     *      Note: setUp() does not validate sponsorThreshold against supply because shares are
     *      minted after governance config is set. This function handles the mismatch gracefully —
     *      if sponsorThreshold > supply, it caps at supply (meaning only a holder of ALL shares
     *      can sponsor). setGovernanceConfig() (post-init) does validate against current supply.
     * @return Effective threshold to compare against getPriorVotes
     */
    function _effectiveSponsorThreshold() internal view returns (uint256) {
        uint256 supply = sharesToken.totalSupply();
        // When supply drops below threshold (e.g., mass ragequit), cap at supply itself.
        // This means only a member holding ALL remaining shares can sponsor — a stronger
        // defense than the previous fallback to 1 (which let dust holders sponsor).
        if (sponsorThreshold > supply) return supply;
        return sponsorThreshold;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERNAL VALIDATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Validate governance configuration parameters
     * @param _votingPeriod Voting period to validate
     * @param _gracePeriod Grace period to validate
     * @param _quorumPercent Quorum percentage to validate
     * @param _minRetentionPercent Minimum retention percentage to validate
     */
    function _validateGovernanceConfig(
        uint32 _votingPeriod,
        uint32 _gracePeriod,
        uint256 _quorumPercent,
        uint256 _minRetentionPercent
    ) internal pure {
        if (_votingPeriod < MIN_VOTING_PERIOD) revert VotingPeriodTooShort();
        if (_votingPeriod > MAX_VOTING_PERIOD) revert VotingPeriodTooLong();
        if (_gracePeriod > MAX_GRACE_PERIOD) revert GracePeriodTooLong();
        if (_quorumPercent > BASIS_POINTS_DIVISOR) revert InvalidQuorum();
        if (_minRetentionPercent > BASIS_POINTS_DIVISOR) revert InvalidRetention();
    }

}
