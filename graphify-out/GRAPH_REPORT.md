# Graph Report - .  (2026-05-09)

## Corpus Check
- 47 files · ~53,787 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 344 nodes · 513 edges · 31 communities (14 shown, 17 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 12 edges (avg confidence: 0.75)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Diff Rendering Engine|Diff Rendering Engine]]
- [[_COMMUNITY_Sem CLI Core Utilities|Sem CLI Core Utilities]]
- [[_COMMUNITY_Code Review Workflow|Code Review Workflow]]
- [[_COMMUNITY_Model Picker & Favourites|Model Picker & Favourites]]
- [[_COMMUNITY_Leader Key Context Bridge|Leader Key Context Bridge]]
- [[_COMMUNITY_AI Workflow & Skills|AI Workflow & Skills]]
- [[_COMMUNITY_SonarQube Analysis|SonarQube Analysis]]
- [[_COMMUNITY_Sem Eval Benchmarks|Sem Eval Benchmarks]]
- [[_COMMUNITY_Pi-Sem Tools Extension|Pi-Sem Tools Extension]]
- [[_COMMUNITY_Tool Pills UI|Tool Pills UI]]
- [[_COMMUNITY_Desktop Notifications|Desktop Notifications]]
- [[_COMMUNITY_Leader Key Overlay UI|Leader Key Overlay UI]]
- [[_COMMUNITY_SonarQube Extension API|SonarQube Extension API]]
- [[_COMMUNITY_ACLI Jira Skills|ACLI Jira Skills]]
- [[_COMMUNITY_Startup AGENTS Sync|Startup AGENTS Sync]]
- [[_COMMUNITY_Desktop Notify State|Desktop Notify State]]
- [[_COMMUNITY_Review Extension|Review Extension]]
- [[_COMMUNITY_Planning Skills|Planning Skills]]
- [[_COMMUNITY_Overlay Shared Utility|Overlay Shared Utility]]
- [[_COMMUNITY_Thinking Picker|Thinking Picker]]
- [[_COMMUNITY_Sem Eval CLI|Sem Eval CLI]]
- [[_COMMUNITY_Git Prompt|Git Prompt]]
- [[_COMMUNITY_Codebase Analyzer Skill|Codebase Analyzer Skill]]
- [[_COMMUNITY_Codebase Locator Skill|Codebase Locator Skill]]
- [[_COMMUNITY_Pattern Finder Skill|Pattern Finder Skill]]
- [[_COMMUNITY_Iterate Plan Skill|Iterate Plan Skill]]
- [[_COMMUNITY_Notes Locator Skill|Notes Locator Skill]]
- [[_COMMUNITY_PR Description Skill|PR Description Skill]]
- [[_COMMUNITY_Research Codebase Skill|Research Codebase Skill]]
- [[_COMMUNITY_GitHub PR Comments Skill|GitHub PR Comments Skill]]
- [[_COMMUNITY_Debug Session Skill|Debug Session Skill]]

## God Nodes (most connected - your core abstractions)
1. `execute()` - 21 edges
2. `buildEvaluationReport()` - 11 edges
3. `Pi-Sem Extension` - 11 edges
4. `cleanString()` - 10 edges
5. `OverlayFrame` - 10 edges
6. `Leader Key Extension` - 10 edges
7. `renderSplit()` - 9 edges
8. `buildSemReviewGuidance()` - 8 edges
9. `renderUnified()` - 8 edges
10. `LeaderKeyOverlay` - 7 edges

## Surprising Connections (you probably didn't know these)
- `README` --references--> `Leader Key Extension`  [INFERRED]
  README.md → extensions/leader-key/index.ts
- `Skill: Sem (semantic diff)` --references--> `Pi-Sem Extension`  [INFERRED]
  skills/sem/SKILL.md → extensions/pi-sem/index.ts
- `AGENTS.md — AI workflow guide` --rationale_for--> `AGENTS.md Symlink Sync`  [INFERRED]
  agents/AGENTS.md → extensions/index.ts
- `README` --references--> `Pi-Sem Extension`  [INFERRED]
  README.md → extensions/pi-sem/index.ts
- `README` --references--> `Tool Pills Extension`  [INFERRED]
  README.md → extensions/tool-pills/index.ts

## Hyperedges (group relationships)
- **Pi ExtensionAPI Consumers** — leader_key_ext, pisem_ext, tool_pills_ext, desktop_notify_ext, review_ext, sonarqube_ext [EXTRACTED 1.00]
- **Overlay UI Pattern** — shared_overlay_frame, leader_key_overlay, searchable_select, favourite_models [INFERRED 0.85]
- **Jira/Atlassian Workflow Skills** — skill_acli, skill_create_plan, skill_taskwarrior, skill_implement_plan [INFERRED 0.80]

## Communities (31 total, 17 thin omitted)

### Community 0 - "Diff Rendering Engine"
Cohesion: 0.05
Nodes (49): require, adaptiveWrapRows(), ANSI_CAPTURE_RE, ANSI_PARAM_CAPTURE_RE, ANSI_RE, ansiState(), applyDiffPalette(), autoDeriveBgFromTheme() (+41 more)

### Community 1 - "Sem CLI Core Utilities"
Cohesion: 0.1
Nodes (50): baseSelection(), buildBlameArgs(), buildContextArgs(), buildEntitiesArgs(), buildEvaluationReport(), buildGitDiffArgs(), buildGitNameOnlyArgs(), buildImpactArgs() (+42 more)

### Community 2 - "Code Review Workflow"
Cohesion: 0.09
Nodes (18): applyReviewState(), buildReviewPrompt(), getDefaultBranch(), getLocalBranches(), getMergeBase(), getReviewState(), REVIEW_PRESETS, ReviewSessionState (+10 more)

### Community 3 - "Model Picker & Favourites"
Cohesion: 0.1
Nodes (16): FavouriteModelEntry, loadFavourites(), PickerResult, runFavouriteModels(), ALL_THINKING_LEVELS, getAvailableEnabledModels(), getEnabledModelSet(), getModelsForProvider() (+8 more)

### Community 4 - "Leader Key Context Bridge"
Cohesion: 0.16
Nodes (20): collectLabeledEntries(), emitCommand(), isCommandCtx(), LabeledEntry, registerBridgeCommands(), tryNavigateTree(), trySwitchSession(), buildEntries() (+12 more)

### Community 5 - "AI Workflow & Skills"
Cohesion: 0.13
Nodes (22): AGENTS.md — AI workflow guide, Context Bridge Helpers, collectLabeledEntries, registerBridgeCommands, tryNavigateTree, trySwitchSession, Favourite Models Picker, AGENTS.md Symlink Sync (+14 more)

### Community 6 - "SonarQube Analysis"
Cohesion: 0.1
Nodes (13): analyzeCoverage(), CoverageAnalysis, CoverageMeasure, CoverageResponse, FilterOptions, IssuesAnalysis, IssuesResponse, SEVERITY_ORDER (+5 more)

### Community 7 - "Sem Eval Benchmarks"
Cohesion: 0.1
Nodes (16): gitDiffArgs, gitDiffText, gitFiles, gitNameArgs, gitNamesText, impactArgs, impactResults, impactText (+8 more)

### Community 8 - "Pi-Sem Tools Extension"
Cohesion: 0.12
Nodes (17): Sem Core Utilities, Pi-Sem Extension, pi-sem README, sem_blame tool, sem_context tool, sem_diff tool, sem_entities tool, sem_eval tool (+9 more)

### Community 9 - "Tool Pills UI"
Cohesion: 0.21
Nodes (10): cwd, getText(), origBash, parts, renderCall(), renderResult(), renderTextResult(), t (+2 more)

### Community 10 - "Desktop Notifications"
Cohesion: 0.17
Nodes (10): action, body, entries, execFileAsync, folder, NotifyState, now, parts (+2 more)

### Community 12 - "SonarQube Extension API"
Cohesion: 0.4
Nodes (5): analyzeCoverage, analyzeIssues, detectConfig, SonarQube Extension, generateReport

### Community 13 - "ACLI Jira Skills"
Cohesion: 0.5
Nodes (4): ACLI ADF Reference, ACLI Jira Workitem Commands, ACLI Other Commands, Skill: ACLI (Atlassian CLI)

### Community 15 - "Desktop Notify State"
Cohesion: 0.67
Nodes (3): /notify command, Desktop Notify Extension, NotifyState

## Knowledge Gaps
- **131 isolated node(s):** `source`, `target`, `LabeledEntry`, `FavouriteModelEntry`, `PickerResult` (+126 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `registerDiffTools()` connect `Diff Rendering Engine` to `Tool Pills UI`?**
  _High betweenness centrality (0.091) - this node is a cross-community bridge._
- **Why does `require` connect `Diff Rendering Engine` to `Sem CLI Core Utilities`?**
  _High betweenness centrality (0.091) - this node is a cross-community bridge._
- **Why does `Leader Key Extension` connect `AI Workflow & Skills` to `Pi-Sem Tools Extension`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `Pi-Sem Extension` (e.g. with `README` and `Skill: Sem (semantic diff)`) actually correct?**
  _`Pi-Sem Extension` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `source`, `target`, `LabeledEntry` to the rest of the system?**
  _131 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Diff Rendering Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Sem CLI Core Utilities` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._