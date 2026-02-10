// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

import "../interfaces/IAvatar.sol";
import "../interfaces/IBaalToken.sol";
import "../libraries/Enum.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Baal
 * @notice Minimal Viable DAO - Zodiac module for Quai Vault treasury governance
 * @dev MolochDAO V3 (Baal) governance implementation for Quai Network
 *      Uses timestamp-based voting (not block numbers) for compatibility
 *      Acts as Zodiac module on Quai Vault via IAvatar interface
 *
 * Key Features:
 * - Share-weighted voting with delegation
 * - Proposal lifecycle: submit → sponsor → vote → grace → process
 * - Quorum and majority requirements
 * - Shaman extension system (ADMIN, MANAGER, GOVERNOR permissions)
 * - Ragequit: burn shares/loot to claim proportional treasury assets
 * - Pausable tokens for emergency situations
 *
 * Architecture:
 * - Baal owns SharesERC20 (voting) and LootERC20 (non-voting) tokens
 * - Baal is a module on Quai Vault (avatar)
 * - Proposals execute via IAvatar.execTransactionFromModule()
 * - Shamans are authorized external contracts with specific permissions
 */
contract Baal is ReentrancyGuard {
    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Shaman permission: can pause tokens, set governance config
    uint256 public constant ADMIN = 1;

    /// @notice Shaman permission: can mint/burn shares and loot
    uint256 public constant MANAGER = 2;

    /// @notice Shaman permission: can cancel proposals, set governance config
    uint256 public constant GOVERNOR = 4;

    // ═══════════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Quai Vault address (treasury controlled by this Baal)
    address public avatar;

    /// @notice Voting shares token (ERC20Votes with delegation)
    IBaalToken public sharesToken;

    /// @notice Non-voting loot token (basic ERC20)
    IBaalToken public lootToken;

    /// @notice Total number of shares (cached for gas efficiency)
    uint256 public totalShares;

    /// @notice Total amount of loot (cached for gas efficiency)
    uint256 public totalLoot;

    /// @notice Proposal count (also used as proposal ID)
    uint32 public proposalCount;

    /// @notice Latest sponsored proposal ID (for linked list traversal)
    uint32 public latestSponsoredProposalId;

    /// @notice Voting period duration in seconds
    uint32 public votingPeriod;

    /// @notice Grace period duration in seconds (after voting, before processing)
    uint32 public gracePeriod;

    /// @notice ETH required to submit a proposal (anti-spam)
    uint256 public proposalOffering;

    /// @notice Quorum percentage in basis points (e.g., 2000 = 20%)
    uint256 public quorumPercent;

    /// @notice Minimum shares required to sponsor a proposal
    uint256 public sponsorThreshold;

    /// @notice Minimum percentage of total supply that must remain after ragequit (basis points)
    uint256 public minRetentionPercent;

    /// @notice MultiSend library address for batched proposal execution
    address public multisendLibrary;

    /// @notice Trusted forwarder for meta-transactions (EIP-2771)
    address public trustedForwarder;

    /// @notice Whether admin functions are locked (shamans cannot be changed)
    bool public adminLock;

    /// @notice Whether manager functions are locked
    bool public managerLock;

    /// @notice Whether governor functions are locked
    bool public governorLock;

    /// @notice Mapping of shaman addresses to their permission bitmask
    mapping(address => uint256) public shamans;

    /// @notice Mapping of token addresses that are enabled for ragequit
    mapping(address => bool) public guildTokens;

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
     * @param prevProposalId Previous sponsored proposal ID (linked list)
     * @param proposalDataHash Keccak256 hash of proposal data (for verification at processing)
     * @param sponsor Address that sponsored the proposal (address(0) if not sponsored)
     * @param submitter Address that submitted the proposal
     * @param votingStarts Timestamp when voting starts (sponsor time)
     * @param votingEnds Timestamp when voting ends
     * @param graceEnds Timestamp when grace period ends
     * @param expiration Timestamp when proposal expires (0 = no expiration)
     * @param baalGas Gas limit for proposal execution (0 = no limit)
     * @param yesVotes Number of members who voted yes
     * @param noVotes Number of members who voted no
     * @param yesBalance Share-weighted yes votes (used for quorum)
     * @param noBalance Share-weighted no votes
     * @param details IPFS hash or metadata string
     * @param status Boolean flags: [cancelled, processed, passed, actionFailed]
     */
    struct Proposal {
        uint32 id;
        uint32 prevProposalId;
        bytes32 proposalDataHash;
        address sponsor;
        address submitter;
        uint32 votingStarts;
        uint32 votingEnds;
        uint32 graceEnds;
        uint32 expiration;
        uint256 baalGas;
        uint32 yesVotes;
        uint32 noVotes;
        uint256 yesBalance;
        uint256 noBalance;
        string details;
        bool[4] status; // [cancelled, processed, passed, actionFailed]
    }

    /**
     * @notice Proposal state enum (computed from timestamps and flags)
     */
    enum ProposalState {
        Unborn,      // Proposal doesn't exist
        Submitted,   // Submitted but not sponsored
        Voting,      // Voting period active
        Grace,       // Grace period (voting ended, cannot process yet)
        Ready,       // Ready to process
        Processed,   // Processed (passed and executed)
        Cancelled,   // Cancelled by submitter or governor
        Defeated,    // Processed but failed quorum/majority
        Expired      // Expired before processing
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when Baal is initialized
     * @param lootPaused Whether loot token is paused
     * @param sharesPaused Whether shares token is paused
     * @param gracePeriod Grace period duration
     * @param votingPeriod Voting period duration
     * @param proposalOffering ETH required to submit proposal
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
        address[] guildTokens,
        uint256 totalShares,
        uint256 totalLoot
    );

    /**
     * @notice Emitted when a proposal is submitted
     * @param proposal Proposal ID
     * @param proposalDataHash Hash of proposal data
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
        uint256 votingPeriod,
        bytes proposalData,
        uint256 expiration,
        bool selfSponsor,
        uint256 timestamp,
        string details
    );

    /**
     * @notice Emitted when a proposal is sponsored
     * @param member Address that sponsored
     * @param proposal Proposal ID
     * @param votingStarts Timestamp when voting starts
     */
    event SponsorProposal(
        address indexed member,
        uint256 indexed proposal,
        uint256 votingStarts
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
        bool actionFailed
    );

    /**
     * @notice Emitted when a proposal is cancelled
     * @param proposal Proposal ID
     */
    event CancelProposal(uint256 indexed proposal);

    /**
     * @notice Emitted when a member ragequits
     * @param member Address that ragequit
     * @param to Address receiving withdrawn assets
     * @param lootToBurn Amount of loot burned
     * @param sharesToBurn Amount of shares burned
     * @param tokens Tokens withdrawn
     */
    event Ragequit(
        address indexed member,
        address indexed to,
        uint256 lootToBurn,
        uint256 sharesToBurn,
        address[] tokens
    );

    /**
     * @notice Emitted when a shaman is set
     * @param shaman Shaman address
     * @param permission Permission bitmask
     */
    event ShamanSet(address indexed shaman, uint256 permission);

    /**
     * @notice Emitted when governance config is updated
     * @param votingPeriod New voting period
     * @param gracePeriod New grace period
     * @param proposalOffering New proposal offering
     * @param quorumPercent New quorum percentage
     * @param sponsorThreshold New sponsor threshold
     * @param minRetentionPercent New minimum retention percentage
     */
    event GovernanceConfigSet(
        uint32 votingPeriod,
        uint32 gracePeriod,
        uint256 proposalOffering,
        uint256 quorumPercent,
        uint256 sponsorThreshold,
        uint256 minRetentionPercent
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

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Constructor for Baal singleton
     * @dev Constructor is empty for minimal proxy pattern (EIP-1167)
     *      Actual initialization happens via setUp()
     */
    constructor() {}

    // ═══════════════════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Initialize Baal clone with DAO parameters
     * @dev Called by BaalSummoner after clone deployment
     *      Can only be called once (avatar == address(0) check)
     * @param _initializationParams ABI-encoded initialization data:
     *        - address lootToken: LootERC20 address
     *        - address sharesToken: SharesERC20 address
     *        - address avatar: Quai Vault address
     *        - address forwarder: Trusted forwarder for meta-txs (or address(0))
     *        - address multisendLibrary: MultiSend library address
     *        - bytes governanceConfig: Encoded governance params (6 uint256s)
     *        - address[] shamans: Initial shaman addresses
     *        - uint256[] shamanPermissions: Permission bitmasks for shamans
     *        - address[] initMembers: Initial member addresses
     *        - uint256[] initShareAmounts: Initial share amounts
     *        - uint256[] initLootAmounts: Initial loot amounts
     */
    function setUp(bytes memory _initializationParams) external {
        require(avatar == address(0), "Baal: already initialized");

        (
            address _lootToken,
            address _sharesToken,
            address _avatar,
            address _forwarder,
            address _multisendLibrary,
            bytes memory _governanceConfig,
            address[] memory _shamans,
            uint256[] memory _shamanPermissions,
            address[] memory _initMembers,
            uint256[] memory _initShareAmounts,
            uint256[] memory _initLootAmounts
        ) = abi.decode(
            _initializationParams,
            (address, address, address, address, address, bytes, address[], uint256[], address[], uint256[], uint256[])
        );

        // Validate tokens
        require(_lootToken != address(0), "Baal: invalid loot token");
        require(_sharesToken != address(0), "Baal: invalid shares token");
        require(_avatar != address(0), "Baal: invalid avatar");

        // Set core addresses
        lootToken = IBaalToken(_lootToken);
        sharesToken = IBaalToken(_sharesToken);
        avatar = _avatar;
        trustedForwarder = _forwarder;
        multisendLibrary = _multisendLibrary;

        // Decode and set governance config
        (
            uint32 _votingPeriod,
            uint32 _gracePeriod,
            uint256 _proposalOffering,
            uint256 _quorumPercent,
            uint256 _sponsorThreshold,
            uint256 _minRetentionPercent
        ) = abi.decode(_governanceConfig, (uint32, uint32, uint256, uint256, uint256, uint256));

        require(_votingPeriod > 0, "Baal: invalid voting period");
        require(_quorumPercent <= 10000, "Baal: invalid quorum");
        require(_minRetentionPercent <= 10000, "Baal: invalid retention");

        votingPeriod = _votingPeriod;
        gracePeriod = _gracePeriod;
        proposalOffering = _proposalOffering;
        quorumPercent = _quorumPercent;
        sponsorThreshold = _sponsorThreshold;
        minRetentionPercent = _minRetentionPercent;

        // Set initial shamans
        require(_shamans.length == _shamanPermissions.length, "Baal: shaman length mismatch");
        for (uint256 i = 0; i < _shamans.length; i++) {
            if (_shamans[i] != address(0)) {
                shamans[_shamans[i]] = _shamanPermissions[i];
                emit ShamanSet(_shamans[i], _shamanPermissions[i]);
            }
        }

        // Mint initial shares and loot
        require(
            _initMembers.length == _initShareAmounts.length &&
            _initMembers.length == _initLootAmounts.length,
            "Baal: member length mismatch"
        );

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

        // Emit setup complete (no guild tokens yet, must be set via proposal)
        address[] memory emptyTokens = new address[](0);
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
            emptyTokens,
            totalShares,
            totalLoot
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Only allows Baal itself (via proposal execution)
     */
    modifier baalOnly() {
        require(msg.sender == address(this), "Baal: not self");
        _;
    }

    /**
     * @notice Only allows addresses with ADMIN permission
     */
    modifier onlyAdmin() {
        require((shamans[msg.sender] & ADMIN) != 0 || msg.sender == address(this), "Baal: not admin");
        require(!adminLock, "Baal: admin locked");
        _;
    }

    /**
     * @notice Only allows addresses with MANAGER permission
     */
    modifier onlyManager() {
        require((shamans[msg.sender] & MANAGER) != 0 || msg.sender == address(this), "Baal: not manager");
        require(!managerLock, "Baal: manager locked");
        _;
    }

    /**
     * @notice Only allows addresses with GOVERNOR permission
     */
    modifier onlyGovernor() {
        require((shamans[msg.sender] & GOVERNOR) != 0 || msg.sender == address(this), "Baal: not governor");
        require(!governorLock, "Baal: governor locked");
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

        // Proposal was processed
        if (prop.status[1]) {
            // Check if it passed or was defeated
            return prop.status[2] ? ProposalState.Processed : ProposalState.Defeated;
        }

        // Not sponsored yet
        if (prop.sponsor == address(0)) return ProposalState.Submitted;

        // Check expiration
        if (prop.expiration != 0 && block.timestamp > prop.expiration) {
            return ProposalState.Expired;
        }

        // Check current phase based on timestamps
        if (block.timestamp < prop.votingEnds) return ProposalState.Voting;
        if (block.timestamp < prop.graceEnds) return ProposalState.Grace;

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
     * @return Current voting power (shares balance)
     */
    function getCurrentVotes(address account) external view returns (uint256) {
        return sharesToken.balanceOf(account);
    }

    /**
     * @notice Get historical voting power at a specific timestamp
     * @param account Address to query
     * @param timepoint Timestamp to query (must be in past)
     * @return Voting power at the given timestamp
     */
    function getPriorVotes(address account, uint256 timepoint) public view returns (uint256) {
        // SharesERC20 extends BaalVotes which has getPriorVotes
        // We need to call it via low-level call since IBaalToken doesn't expose it
        (bool success, bytes memory data) = address(sharesToken).staticcall(
            abi.encodeWithSignature("getPriorVotes(address,uint256)", account, timepoint)
        );
        require(success, "Baal: getPriorVotes failed");
        return abi.decode(data, (uint256));
    }

    /**
     * @notice Get total supply (shares + loot)
     * @dev totalShares and totalLoot are available as public state variables
     * @return Total supply
     */
    function totalSupply() external view returns (uint256) {
        return sharesToken.totalSupply() + lootToken.totalSupply();
    }

    /**
     * @notice Hash proposal data
     * @param _transactions Proposal data to hash
     * @return bytes32 Keccak256 hash
     */
    function hashOperation(bytes memory _transactions) external pure returns (bytes32) {
        return keccak256(_transactions);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // PROPOSAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Submit a new proposal
     * @param proposalData Encoded proposal data (for MultiSend or single action)
     * @param expiration Expiration timestamp (0 for no expiration)
     * @param baalGas Gas limit for execution (0 for no limit)
     * @param details IPFS hash or metadata string
     * @return proposal Proposal ID
     */
    function submitProposal(
        bytes calldata proposalData,
        uint32 expiration,
        uint256 baalGas,
        string calldata details
    ) external payable nonReentrant returns (uint256 proposal) {
        require(msg.value == proposalOffering, "Baal: incorrect offering");
        require(proposalData.length > 0, "Baal: empty proposal");

        // Check if submitter can auto-sponsor
        bool selfSponsor = sharesToken.balanceOf(msg.sender) >= sponsorThreshold;

        // Increment proposal count
        proposalCount++;
        uint32 id = proposalCount;

        // Create proposal
        proposals[id] = Proposal({
            id: id,
            prevProposalId: 0, // Set during sponsorship
            proposalDataHash: keccak256(proposalData),
            sponsor: address(0), // Set during sponsorship
            submitter: msg.sender,
            votingStarts: 0, // Set during sponsorship
            votingEnds: 0, // Set during sponsorship
            graceEnds: 0, // Set during sponsorship
            expiration: expiration,
            baalGas: baalGas,
            yesVotes: 0,
            noVotes: 0,
            yesBalance: 0,
            noBalance: 0,
            details: details,
            status: [false, false, false, false]
        });

        emit SubmitProposal(
            id,
            proposals[id].proposalDataHash,
            votingPeriod,
            proposalData,
            expiration,
            selfSponsor,
            block.timestamp,
            details
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
        require(sharesToken.balanceOf(msg.sender) >= sponsorThreshold, "Baal: insufficient shares");
        _sponsorProposal(id, msg.sender);
    }

    /**
     * @notice Internal sponsor function
     * @param id Proposal ID
     * @param sponsor Sponsor address
     */
    function _sponsorProposal(uint32 id, address sponsor) internal {
        Proposal storage prop = proposals[id];

        require(prop.id != 0, "Baal: invalid proposal");
        require(prop.sponsor == address(0), "Baal: already sponsored");
        require(state(id) == ProposalState.Submitted, "Baal: not submitted");

        // Check expiration
        if (prop.expiration != 0) {
            require(block.timestamp <= prop.expiration, "Baal: expired");
        }

        // Update proposal
        prop.sponsor = sponsor;
        prop.votingStarts = uint32(block.timestamp);
        prop.votingEnds = uint32(block.timestamp) + votingPeriod;
        prop.graceEnds = uint32(block.timestamp) + votingPeriod + gracePeriod;

        // Update linked list
        prop.prevProposalId = latestSponsoredProposalId;
        latestSponsoredProposalId = id;

        emit SponsorProposal(sponsor, id, prop.votingStarts);
    }

    /**
     * @notice Submit a vote on a proposal
     * @param id Proposal ID
     * @param approved True for yes, false for no
     */
    function submitVote(uint32 id, bool approved) external nonReentrant {
        Proposal storage prop = proposals[id];

        require(state(id) == ProposalState.Voting, "Baal: not voting");
        require(!memberVoted[msg.sender][id], "Baal: already voted");

        // Get voting power at snapshot
        uint256 balance = getPriorVotes(msg.sender, prop.votingStarts);
        require(balance > 0, "Baal: insufficient voting power");

        // Record vote
        memberVoted[msg.sender][id] = true;

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
        Proposal storage prop = proposals[id];

        require(state(id) == ProposalState.Ready, "Baal: not ready");
        require(keccak256(proposalData) == prop.proposalDataHash, "Baal: hash mismatch");

        // Check expiration
        if (prop.expiration != 0) {
            require(block.timestamp <= prop.expiration, "Baal: expired");
        }

        // Mark as processed
        prop.status[1] = true;

        // Check if proposal passed
        bool passed = _didProposalPass(id);
        prop.status[2] = passed;

        bool actionFailed = false;

        // Execute if passed
        if (passed && proposalData.length > 0) {
            // Execute via IAvatar
            bool success;
            if (prop.baalGas > 0) {
                // Execute with gas limit
                try IAvatar(avatar).execTransactionFromModule{gas: prop.baalGas}(
                    multisendLibrary,
                    0,
                    proposalData,
                    Enum.Operation.DelegateCall
                ) returns (bool result) {
                    success = result;
                } catch {
                    success = false;
                }
            } else {
                // Execute without gas limit
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
            }

            actionFailed = !success;
            prop.status[3] = actionFailed;
        }

        emit ProcessProposal(id, passed, actionFailed);
    }

    /**
     * @notice Cancel a proposal
     * @param id Proposal ID
     */
    function cancelProposal(uint32 id) external nonReentrant {
        Proposal storage prop = proposals[id];

        require(prop.id != 0, "Baal: invalid proposal");
        require(!prop.status[0], "Baal: already cancelled");
        require(!prop.status[1], "Baal: already processed");

        // Only submitter or governor can cancel
        require(
            msg.sender == prop.submitter || (shamans[msg.sender] & GOVERNOR) != 0,
            "Baal: not authorized"
        );

        prop.status[0] = true;

        emit CancelProposal(id);
    }

    /**
     * @notice Check if proposal passed quorum and majority
     * @param id Proposal ID
     * @return True if passed, false otherwise
     */
    function _didProposalPass(uint32 id) internal view returns (bool) {
        Proposal storage prop = proposals[id];

        uint256 totalSharesAtVote = sharesToken.totalSupply();

        // Check quorum (yes votes must meet minimum threshold)
        uint256 quorumRequired = (totalSharesAtVote * quorumPercent) / 10000;
        if (prop.yesBalance < quorumRequired) {
            return false;
        }

        // Check majority (yes must exceed no)
        return prop.yesBalance > prop.noBalance;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // SHAMAN FUNCTIONS (MANAGER PERMISSION)
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Mint shares to addresses
     * @param to Addresses to receive shares
     * @param amount Amounts to mint
     */
    function mintShares(address[] calldata to, uint256[] calldata amount) external onlyManager {
        require(to.length == amount.length, "Baal: length mismatch");
        require(to.length > 0, "Baal: empty arrays");

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
        require(to.length == amount.length, "Baal: length mismatch");
        require(to.length > 0, "Baal: empty arrays");

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
        require(from.length == amount.length, "Baal: length mismatch");
        require(from.length > 0, "Baal: empty arrays");

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
        require(from.length == amount.length, "Baal: length mismatch");
        require(from.length > 0, "Baal: empty arrays");

        for (uint256 i = 0; i < from.length; i++) {
            lootToken.burn(from[i], amount[i]);
            totalLoot -= amount[i];
        }

        emit BurnLoot(from, amount);
    }

    /**
     * @notice Set admin config (pause tokens)
     * @param pauseShares Whether to pause shares token
     * @param pauseLoot Whether to pause loot token
     */
    function setAdminConfig(bool pauseShares, bool pauseLoot) external onlyAdmin {
        if (pauseShares) {
            sharesToken.pause();
        } else {
            sharesToken.unpause();
        }

        if (pauseLoot) {
            lootToken.pause();
        } else {
            lootToken.unpause();
        }
    }

    /**
     * @notice Set governance configuration
     * @param _governanceConfig Encoded governance params (6 uint256s)
     */
    function setGovernanceConfig(bytes memory _governanceConfig) external onlyGovernor {
        (
            uint32 _votingPeriod,
            uint32 _gracePeriod,
            uint256 _proposalOffering,
            uint256 _quorumPercent,
            uint256 _sponsorThreshold,
            uint256 _minRetentionPercent
        ) = abi.decode(_governanceConfig, (uint32, uint32, uint256, uint256, uint256, uint256));

        require(_votingPeriod > 0, "Baal: invalid voting period");
        require(_quorumPercent <= 10000, "Baal: invalid quorum");
        require(_minRetentionPercent <= 10000, "Baal: invalid retention");

        votingPeriod = _votingPeriod;
        gracePeriod = _gracePeriod;
        proposalOffering = _proposalOffering;
        quorumPercent = _quorumPercent;
        sponsorThreshold = _sponsorThreshold;
        minRetentionPercent = _minRetentionPercent;

        emit GovernanceConfigSet(
            _votingPeriod,
            _gracePeriod,
            _proposalOffering,
            _quorumPercent,
            _sponsorThreshold,
            _minRetentionPercent
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // BAAL-ONLY FUNCTIONS (VIA PROPOSAL)
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Set shamans (can only be called by Baal via proposal)
     * @param _shamans Shaman addresses
     * @param _permissions Permission bitmasks
     */
    function setShamans(address[] calldata _shamans, uint256[] calldata _permissions) external baalOnly {
        require(_shamans.length == _permissions.length, "Baal: length mismatch");

        for (uint256 i = 0; i < _shamans.length; i++) {
            shamans[_shamans[i]] = _permissions[i];
            emit ShamanSet(_shamans[i], _permissions[i]);
        }
    }

    /**
     * @notice Set guild tokens (enable/disable for ragequit)
     * @param _tokens Token addresses
     * @param _enabled Whether tokens are enabled
     */
    function setGuildTokens(address[] calldata _tokens, bool[] calldata _enabled) external baalOnly {
        require(_tokens.length == _enabled.length, "Baal: length mismatch");

        for (uint256 i = 0; i < _tokens.length; i++) {
            guildTokens[_tokens[i]] = _enabled[i];
        }

        emit SetGuildTokens(_tokens, _enabled);
    }

    /**
     * @notice Lock admin functions permanently
     */
    function lockAdmin() external baalOnly {
        adminLock = true;
        emit LockAdmin(true);
    }

    /**
     * @notice Lock manager functions permanently
     */
    function lockManager() external baalOnly {
        managerLock = true;
        emit LockManager(true);
    }

    /**
     * @notice Lock governor functions permanently
     */
    function lockGovernor() external baalOnly {
        governorLock = true;
        emit LockGovernor(true);
    }

    /**
     * @notice Execute arbitrary call as Baal (via proposal)
     * @param _to Target address
     * @param _value ETH value
     * @param _data Call data
     */
    function executeAsBaal(address _to, uint256 _value, bytes calldata _data) external baalOnly {
        (bool success, ) = _to.call{value: _value}(_data);
        require(success, "Baal: execute failed");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // RAGEQUIT
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Ragequit: burn shares/loot to withdraw proportional treasury assets
     * @param to Address to receive withdrawn assets
     * @param sharesToBurn Amount of shares to burn
     * @param lootToBurn Amount of loot to burn
     * @param tokens Guild tokens to withdraw
     */
    function ragequit(
        address to,
        uint256 sharesToBurn,
        uint256 lootToBurn,
        address[] calldata tokens
    ) external nonReentrant {
        require(to != address(0), "Baal: invalid recipient");

        uint256 totalToBurn = sharesToBurn + lootToBurn;
        require(totalToBurn > 0, "Baal: nothing to burn");

        uint256 currentTotalShares = sharesToken.totalSupply();
        uint256 currentTotalLoot = lootToken.totalSupply();
        uint256 currentTotalSupply = currentTotalShares + currentTotalLoot;

        // Check retention requirement
        uint256 minRetention = (currentTotalSupply * minRetentionPercent) / 10000;
        require(currentTotalSupply - totalToBurn >= minRetention, "Baal: insufficient retention");

        // Validate tokens and check for duplicates
        for (uint256 i = 0; i < tokens.length; i++) {
            require(guildTokens[tokens[i]], "Baal: not guild token");

            // Check for duplicates
            for (uint256 j = i + 1; j < tokens.length; j++) {
                require(tokens[i] != tokens[j], "Baal: duplicate token");
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
        for (uint256 i = 0; i < tokens.length; i++) {
            // Get token balance in treasury
            (bool success, bytes memory data) = tokens[i].staticcall(
                abi.encodeWithSignature("balanceOf(address)", avatar)
            );
            require(success, "Baal: balance query failed");
            uint256 balance = abi.decode(data, (uint256));

            // Calculate fair share
            uint256 fairShare = (balance * totalToBurn) / currentTotalSupply;

            if (fairShare > 0) {
                // Execute withdrawal via IAvatar
                bool execSuccess = IAvatar(avatar).execTransactionFromModule(
                    tokens[i],
                    0,
                    abi.encodeWithSignature("transfer(address,uint256)", to, fairShare),
                    Enum.Operation.Call
                );
                require(execSuccess, "Baal: transfer failed");
            }
        }

        emit Ragequit(msg.sender, to, lootToBurn, sharesToBurn, tokens);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // RECEIVE ETH
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Receive ETH (for proposal offerings)
     */
    receive() external payable {}
}
