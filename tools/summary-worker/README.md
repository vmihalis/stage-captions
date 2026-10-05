# Optional local meeting summaries

This worker summarizes a complete Stage meeting through the owner's existing OMP OpenAI Codex sign-in. It runs as a separate process on that owner's Mac. It is not a server endpoint or a shared team credential service, and opening Stage does not generate a summary.

The integration uses the public OMP 18.6.1 SDK. It never reads, copies, returns or logs credential values itself. OMP's supported discovery and request flow own credential handling, account policies and any refresh needed for a requested summary. Each teammate would need their own local setup; a team-wide service requires a separate product/auth decision.

## Local setup

The package is pinned by `package-lock.json`. Bun 1.3.14 or newer is required by this SDK; Node runs the dependency-free tests only. On an Apple Silicon Mac:

```sh
cd tools/summary-worker
npm ci --omit=optional --ignore-scripts --no-audit --no-fund
npm test
```

The Darwin arm64 native binding is explicitly pinned so optional voice/ONNX dependencies can be omitted. This package currently targets Apple Silicon Macs. Do not remove `--omit=optional` merely to enable transcript summaries. An interrupted installation should be repaired with `npm ci`; metadata-only checks can miss partially extracted packages.

For this checkout, a dedicated Bun 1.3.14 binary is available at `work/summary-runtime/bun`. It was extracted from the official `@oven/bun-darwin-aarch64@1.3.14` npm package after checking its SHA-512 integrity. Its provenance is recorded alongside it. This ignored local runtime does not replace global Bun or OMP.

Configure these environment variables before launching the Electron preview, using absolute paths for the first two:

```sh
export STAGE_SUMMARY_RUNTIME="/absolute/path/to/stage-captions-streaming/work/summary-runtime/bun"
export STAGE_SUMMARY_WORKER="/absolute/path/to/stage-captions-streaming/tools/summary-worker/src/cli.mjs"
export STAGE_SUMMARY_MODEL="gpt-6-sol"
```

`gpt-6-sol` is a balanced starting choice. The exact provider is always `openai-codex`; request JSON cannot choose a provider, model, executable, path or credential. An exact model ID is required, and there is no automatic model fallback.

Check the real dependency imports and configuration without opening the auth store or making a model request:

```sh
"$STAGE_SUMMARY_RUNTIME" "$STAGE_SUMMARY_WORKER" --check
```

Successful readiness returns `{ "ok": true, "available": true, "provider": "openai-codex", "model": "gpt-6-sol", "authenticationChecked": false }`. Readiness does not establish subscription entitlement, remaining quota or generation quality.

## Process contract

Launch the absolute Bun executable with the absolute `src/cli.mjs` argument, without a shell. Write one JSON meeting export to stdin and close stdin. The worker writes exactly one JSON line to stdout and exits. Treat an abnormal process exit, invalid JSON or an invalid result as a recoverable failure. Discard stderr. The native bridge passes only `HOME`, a fixed system `PATH`, `LANG`, optional `TMPDIR`, and `STAGE_SUMMARY_MODEL`; it does not forward API-key or auth environment variables.

Input is the complete server export `{ meeting, entries, bookmarks }` with no additional fields. Both source and translation entries are required. `meeting.entryCount` and `meeting.bookmarkCount` must match the array lengths; entry sequences must be consecutive from 1, IDs unique, and bookmark entry IDs belong to this meeting. Finalized whitespace-only entries are preserved. A wholly blank transcript returns `NO_TRANSCRIPT`.

Success:

```json
{
  "ok": true,
  "summary": {
    "overview": [{ "text": "A supported meeting fact.", "evidenceEntryIds": ["entry-uuid"] }],
    "decisions": [],
    "actions": [{ "text": "An explicit commitment.", "assignee": null, "dueDate": null, "evidenceEntryIds": ["entry-uuid"] }],
    "openQuestions": []
  },
  "meta": {
    "provider": "openai-codex",
    "model": "gpt-6-sol",
    "entryCount": 24,
    "chunkCount": 1,
    "modelRequests": 1,
    "reductionRounds": 0,
    "generatedAt": 1791158400000,
    "inputDigest": "sha256-of-the-validated-export"
  }
}
```

The UUID and digest values above are placeholders. `entryCount` counts **all** exported entries, including translations. `generatedAt` is an integer Unix timestamp in milliseconds. Every item must cite 1–32 entry IDs in its supplied evidence; actions use `null` for an unstated assignee/date. There are at most 32 items per array, 600 characters per item, and 8,192 UTF-8 bytes in the summary. The host validates the result again before saving it.

Failure is `{ "ok": false, "error": { "code": "AUTH_UNAVAILABLE", "message": "...", "recoverable": true } }`. Codes are `INVALID_REQUEST`, `INPUT_TOO_LARGE`, `NO_TRANSCRIPT`, `INCOMPLETE_TRANSCRIPT`, `RUNTIME_UNAVAILABLE`, `SDK_UNAVAILABLE`, `MODEL_NOT_CONFIGURED`, `MODEL_UNAVAILABLE`, `AUTH_UNAVAILABLE`, `CONTEXT_UNSUPPORTED`, `INVALID_SUMMARY`, `SUMMARY_TOO_LARGE`, `GENERATION_FAILED`, `TIMED_OUT`, and `CANCELLED`. Messages are fixed local strings; underlying SDK/provider errors are never returned. A failed chunk prevents publication of any partial result.

## Transcript and request boundaries

The transcript, meeting title, bookmarks and intermediate summaries are untrusted data in a JSON user message. A fixed system prompt defines the task and prohibits following instructions found in that data. All tool names are restricted to an empty set; MCP, LSP, IRC, extensions, skills, project context, prompt templates, workspace trees, memories, autolearning, telemetry export, retries, model fallback, compaction, cache warming and websocket prewarming are disabled. Every model turn receives a new in-memory session in a neutral temporary directory. The worker does not save transcripts, responses or session history to disk.

The worker accepts at most 32 MiB and 100,000 entries; the native bridge applies a stricter 20 MB input limit. Every accepted caption and bookmark is included in a bounded map/reduce pass. Oversized text is split losslessly at Unicode codepoint boundaries. Each complete prompt is capped at 48,000 UTF-8 bytes, or a lower bound derived from the catalog context window with 12,288 tokens reserved for output/framing plus the system prompt. UTF-8 bytes provide a conservative input bound for the selected Codex text models. Intermediate summaries are validated and merged recursively rather than silently dropping later captions. This ensures input coverage, not perfect model recall: evidence IDs establish that cited entries exist, not that a claim is semantically correct.

Each model turn has a two-minute timeout; the entire process has a ten-minute deadline. Large meetings may fail within that deadline and remain available as complete transcripts. The SDK provider controls output-token support; the 8 KiB response limit is enforced on the returned summary, not presented as a guaranteed billing cap.

## Verification in this checkout

The dedicated Bun 1.3.14 runtime, pinned SDK imports and isolated settings were verified. The runtime and installed dependencies occupy approximately 450 MB of file contents after removing installer caches; global Bun remains 1.3.1. A separate public `discoverAuthStorage` / `ModelRegistry.hasConfiguredAuth` probe found configured OpenAI Codex auth with zero attempted fetches while network fetches were blocked. It reported these exact chat model IDs: `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol`, and `gpt-daybreak-blue-latest`, each with an effective 272,000-token context window. That probe returned only model metadata and configured-auth booleans, never credential values.

Fourteen dependency-free tests cover completeness, Unicode chunking, scoped citations, bounded multi-round merging, whitespace preservation, sanitized errors, SDK isolation options, cancellation and late-initialization timeout handling. **No live model request has been run.**

Primary integration references: [OMP SDK at v18.6.1](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/sdk.md), [OMP system-prompt customization](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/system-prompt-customization.md), [OpenAI authentication](https://learn.chatgpt.com/docs/auth), and [OpenAI's separate sign-in integration for open-source/local apps](https://developers.openai.com/siwc/token-sharing-open-source).
