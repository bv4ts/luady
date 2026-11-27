export const LIMITS = {
  lastAssistantMessage: 8000,
  promptPreview: 200,
  notificationMessage: 1000,
  stopFailureError: 2000,
  permissionInputPreview: 2000,
  /** One owner-facing chat message: longer ones are split. */
  chatMessageMax: 3500,
  /** The whole last reply of a finished turn (the kit already caps it at lastAssistantMessage); long ones are split. */
  chatFinishedExcerpt: 8000,
  chatErrorExcerpt: 500,
  chatPermissionPreview: 600,
  transcriptChunkMax: 524288,
  execOutputMax: 65536,
  captureLinesMax: 500,
  sendTextMax: 20000,
  hookWaitMaxSeconds: 86400,
  /**
   * One tool step's title (kit → hub → website). Lengths are counted in UTF-16 code units, so a producer in another
   * language (the Python kit) must truncate by UTF-16 length.
   */
  stepTitleMax: 160,
  /**
   * A Claude Code tool name in a step or a permission preview; long enough for `mcp__<server>__<tool>`. Lengths are
   * counted in UTF-16 code units, so a producer in another language (the Python kit) must truncate by UTF-16 length.
   */
  toolNameMax: 128,
  /** To-do items one step event or one session detail may carry. */
  stepTodosMax: 20,
  stepTodoSubjectMax: 200,
  /** Steps the hub keeps (and sends) per session, oldest first. */
  stepRingSize: 40,
  /** The whole structured permission preview after redaction; the kit cuts to fit and sets `truncated`. */
  permissionPreviewMaxBytes: 8192,
  permissionPreviewEditsMax: 20,
  /** A preview's command and each edit's old and new text, in UTF-16 code units. */
  permissionPreviewTextMax: 8192,
  /** A preview's path and cwd, in UTF-16 code units. */
  permissionPreviewPathMax: 1024,
  /** What "Allow always" would allow, as shown to the owner. */
  permissionAlwaysLabelMax: 200,
  noticeTextMax: 8000,
  /** Notice ids one `notice.ack` frame may carry. */
  noticeAckMax: 50,
  /** A notice nobody settled on the website goes to the chat channel after this long. */
  noticeFallbackMs: 600_000,
  /** A website client that sent no presence frame for this long no longer counts as present. */
  presenceStaleMs: 1_800_000,
  /** How long "Updates: chat" stays forced after the owner pressed it. */
  presenceForceMs: 3_600_000,

  // ── The board (board.ts) ──
  /** A card's title. */
  boardTitleMax: 300,
  /** A card's details (Markdown). */
  boardDetailsMax: 8000,
  /** The one-line result of a finished card. */
  boardResultMax: 500,
  /** One line of a card's log. */
  boardEventTextMax: 2000,
  /** A card's project name, and a project name in a body or tool. */
  boardProjectMax: 128,
  /** A card's source reference (`birch:ORC-123`, a meeting id, a note id, a session id). */
  boardSourceRefMax: 160,
  /** Done cards stay on the board this long. */
  boardDoneDays: 14,
  /** Cards one Run or Give to… may carry, and cards `session_start` / `session_send` may link. */
  delegateItemsMax: 12,
  /** The owner's note to Luady on a delegation. */
  delegateNoteMax: 1000,
  /** A mission's last message on the website. */
  missionLastTextMax: 1200,

  // ── Notes (notes.ts) ──
  noteTitleMax: 200,
  noteBodyMax: 20000,
  noteProjectMax: 60,
  /** A note's summary in the list (the full note has all of it). */
  noteListSummaryMax: 600,
  noteListDefault: 50,
  noteListMax: 200,
  /** The note text put in front of an owner message that is about it. */
  aboutTextMax: 6000,
  /** An `about` id (`m:…`, `n:12`, `12`, `birch:ORC-123`). */
  aboutIdMax: 160,

  // ── Knowledge base and library (kb.ts) ──
  kbTitleMax: 120,
  kbBodyMax: 60000,
  kbTagsMax: 8,
  kbTagMax: 30,
  kbSlugMax: 60,
  /** Everything one `kb-put` may carry, and the whole `~/luady-kb/` copy of one server. */
  kbSyncMaxBytes: 2 * 1024 * 1024,
  kbSearchDefault: 10,
  kbSearchMax: 50,
  skillDescriptionMax: 300,
  /** Skills one `skills` verb lists. */
  skillsMax: 300,

  // ── Speech and activity (said.ts, activity.ts) ──
  /** What an agent said, as one speech bubble. */
  saidTextMax: 1200,
  /** Helper types in one activity record. */
  activityHelperTypesMax: 3,

  // ── Jira (jira.ts) ──
  jiraEmailMax: 200,
  jiraTokenMin: 8,
  jiraTokenMax: 600,
  jiraCommentMax: 8000,
  jiraSummaryMax: 255,
  jiraDescriptionMax: 20000,
  jiraLabelsMax: 50,
  jiraLabelMax: 255,
  jiraSearchDefault: 20,
  jiraSearchMax: 50,
  jiraJqlMax: 2000,
  /** How long the hub keeps a fetched board view. */
  jiraBoardCacheMs: 60_000,

  // ── Office extras (extras.ts) ──
  /** Lines in one list of the welcome-back card. */
  recapLinesMax: 12,
  recapTextMax: 200,
  /** A recap reaches back at most this far. */
  recapSinceMaxDays: 7,
  /** How long the fleet wall's graphs reach back (kept in memory). */
  fleetHistoryHours: 24,
  /** Points in one fleet-wall series after thinning. */
  fleetPointsMax: 240,
  winsDaysDefault: 7,
  winsDaysMax: 30,
  /** Links found on one win, and the length of each. */
  winsLinksMax: 5,
  winsLinkMax: 300,
  timelineItemsMax: 400,
  timelineLabelMax: 160,
  scheduleWhenMin: 5,
  scheduleWhenMax: 64,
  scheduleTaskMin: 3,
  scheduleTaskMax: 2000,
  linkLabelMax: 40,
  linkUrlMax: 500,
  /** Links on one office's shelf. */
  linksPerOfficeMax: 12,

  // ── Rooms (rooms.ts) ──
  roomNameMax: 40,
  roomShortMax: 12,
  roomGlobMax: 128,
  /** Project matches one room may carry. */
  roomMatchesMax: 8,

  // ── Hosts (hosts.ts) ──
  hostNameMax: 253,
  /** One line of a host job's log (`host.log`). */
  hostLogLineMax: 500,
  hostSummaryMax: 500,

  // ── Add-ons (addon.ts) ──
  addonDetailMax: 200,
  addonTextMax: 20000,
  addonBrainNotesMax: 4000,
  addonToolsMax: 20,
  addonToolDescriptionMax: 1000,
  /** An add-on tool's JSON Schema, and the JSON of one call's arguments, in bytes. */
  addonToolSchemaMaxBytes: 16 * 1024,
  addonToolArgsMaxBytes: 64 * 1024,
  addonProfileAboutMax: 139,
  addonProfileDescriptionMax: 512,
  /** A channel's longest text: `maxText` is between these. */
  addonMaxTextMin: 100,
  addonMaxTextMax: 20000,
  /** A panel: blocks, and each block's text. */
  addonPanelBlocksMax: 20,
  addonPanelTextMax: 2000,
} as const;
