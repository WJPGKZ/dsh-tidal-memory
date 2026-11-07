# Contributing

Tidal Memory uses workspace-shared, four-layer memory for DeepSeek Harness rc5. Capture, deterministic classification and consolidation do not call a model. Optional embedding inference is entirely local, with BGE-small CPU and Qwen3/Vulkan packs kept outside plugin code.

## Areas where help is welcome

- Tests and labeled, synthetic benchmarks for local classification and recall.
- Chinese and mixed-language rule coverage, especially false-positive and conflicting-memory cases.
- Local embedding adapters and quality benchmarks. Preserve the model-free edition, explicit lexical fallback, workspace-isolated indexes, and source/time checks. Vectors must never decide whether a memory is true or safe to merge.
- Graph navigation and recall evaluation. Keep L0 and private journals out of ordinary indexes, retain manual decisions across rebuild and backup, and recheck source revisions, eligibility, and forgetting before returning results. Semantic suggestions are not verified facts. Graph-assisted recall stays off by default until the effectiveness, privacy, and performance gates all pass.
- Future memory-organizer adapters. No `MemoryModelProvider` registration or execution interface exists yet. Design it explicitly; adapters must be opt-in, return proposals rather than write directly, and document exactly what data leaves the machine. Host-model extraction and query expansion are deferred, not silently enabled by the reference plan.

New local-rule and tool memories are automatically recallable; human approval is not a normal ingestion prerequisite. Automatic eligibility must not imply verified truth. Preserve provenance, conflict isolation, optional human correction, and protection against tools rewriting user statements. Future adapters must use the same validated store boundary rather than mutate databases directly.

## Privacy requirements

Do not include real conversation histories, private journal entries, credentials, API keys, personal databases, or embedding vectors derived from private data in issues, pull requests, fixtures, or benchmarks. Use synthetic data only. Private journal content must remain outside ordinary retrieval, generated views, and plaintext backups.

New backups exclude L0 records/history and source excerpts, including encrypted backups. Selected L1-L3 memory text is still sensitive. Test the entire snapshot, not just its `records` array; do not silently delete or rewrite old backups to satisfy a retention claim.

## Checks

Run the relevant checks before opening a pull request:

```powershell
pnpm install:host
pnpm test
pnpm test:host
pnpm check
pnpm test:ui
pnpm bench:graph
pnpm bench 10000
```

The repository targets DeepSeek Harness `0.2.1-rc.5` and Node.js 24. Changes involving prompt delivery should distinguish provider registration, session event projection, and actual network delivery; do not claim a request was sent unless the host exposes evidence for it.

Host dependencies are pinned in `tests/host-fixture`, separately from the plugin package. Missing or mismatched dependencies fail the tests instead of skipping. The CI host step exercises the real rc5 agent loop up to a fake transport's received request; it does not call a provider or cover compaction and long-conversation continuity.

The benchmark compares a pinned original 0.1.0 commit with the working tree in separate processes. Its labeled development fixtures include unrelated active tasks and known semantic misses; they are not representative field data. Keep the failing semantic probes, report metric denominators and negative-query counts, and do not claim competitor or general-quality improvements from these fixtures. Local results go to `.preview/benchmark.json`.

With installed local model packs, `scripts/evaluate-graph-semantic.mjs` measures the exact shipped suggestion thresholds; `scripts/evaluate-graph-recall.mjs` compares against the pinned 0.6.1 baseline. Set `TIDAL_GRAPH_SPLIT=challenge` for confirmed-edge hard negatives. That challenge currently fails: a confirmed navigation link can still be irrelevant to the current query. Keep this failure visible rather than replacing it with a favorable fixture or enabling graph recall by default.
