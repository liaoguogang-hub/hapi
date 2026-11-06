package app.hapi.protocol.wire

import kotlinx.serialization.Serializable

/**
 * Paging envelope of `GET /api/sessions/:id/messages` (`MessagesResponse.page`
 * in `shared/src/apiTypes.ts`; semantics in
 * `docs/api/client-contract/pagination.md`). Every cursor is a `(seq, at)`
 * pair — both halves always travel together.
 */
@Serializable
data class MessagesPage(
    /** `'latest' | 'before' | 'after'`. */
    val direction: String,
    val limit: Int,
    /** Server's current epoch; mismatch on `after` ⇒ [reset] latest page. */
    val epoch: Long,
    /** `true` ⇒ discard the local window, this page replaces it. */
    val reset: Boolean,
    val nextBeforeSeq: Long? = null,
    val nextBeforeAt: Long? = null,
    val nextAfterSeq: Long? = null,
    val nextAfterAt: Long? = null,
    val snapshotHeadSeq: Long? = null,
    val snapshotHeadAt: Long? = null,
    val hasMore: Boolean,
    val readThroughRevision: Long? = null,
)
/** `GET /api/sessions/:id/messages` — messages in ascending display order. */
@Serializable
data class MessagesResponse(
    val messages: List<DecryptedMessage>,
    val page: MessagesPage,
)

/** `GET /api/sessions`. */
@Serializable
data class SessionsResponse(
    val sessions: List<SessionSummary>,
)

/** `GET /api/sessions/:id`. */
@Serializable
data class SessionResponse(
    val session: Session,
)

/** `GET /api/machines`. */
@Serializable
data class MachinesResponse(
    val machines: List<Machine>,
)

/** `POST /api/machines/:id/restart-runner` — hub ack (`{message}`). */
@Serializable
data class RestartRunnerResponse(
    val message: String,
)

/** `POST /api/auth` success body (`AuthResponse`, `shared/src/apiTypes.ts`). */
@Serializable
data class AuthResponse(
    /** The 4-hour JWT — `Authorization: Bearer` on every `/api` request. */
    val token: String,
    val user: AuthUser,
)

@Serializable
data class AuthUser(
    val id: Long,
    val username: String? = null,
    val firstName: String? = null,
    val lastName: String? = null,
)

/**
 * `GET /health` (no auth; `hub/src/web/server.ts`). [capabilities] keys are
 * additive — unknown ones must be ignored, hence the raw-`Boolean?` shape.
 */
@Serializable
data class HubHealthResponse(
    val status: String,
    val protocolVersion: Int,
    val capabilities: HubCapabilities? = null,
)

@Serializable
data class HubCapabilities(
    val workGraph: Boolean? = null,
    val titleSuggestion: Boolean? = null,
)

/**
 * `POST /api/sessions/:id/resume` — `{type: 'success', sessionId}`. The
 * returned [sessionId] **may differ** from the id the call was made on (fresh
 * spawn superseding the old row); callers must migrate drafts + navigation.
 */
@Serializable
data class ResumeSessionResponse(
    val sessionId: String,
)

/**
 * `POST /api/sessions/:id/reopen` (`ReopenSessionResponseSchema`). Same
 * superseding-[sessionId] caveat as [ResumeSessionResponse].
 */
@Serializable
data class ReopenSessionResponse(
    val ok: Boolean = true,
    val sessionId: String,
    val resumed: Boolean,
    /** `'acp' | 'stream-json'` (cursor only). */
    val cursorSessionProtocol: String? = null,
)

/**
 * `DELETE /api/sessions/:id/messages/:messageId`
 * (`CancelMessageResponseSchema` — discriminated on [status]):
 * `'cancelled'` carries [localId]; `'invoked'` (too late) carries [message].
 */
@Serializable
data class CancelMessageResponse(
    val status: String,
    val localId: String? = null,
    val message: DecryptedMessage? = null,
)

@Serializable
data class RetryIndeterminateMessageResponse(
    val status: String,
    val localId: String? = null,
    val message: DecryptedMessage? = null,
)

/**
 * `POST /api/sessions/:id/messages/:messageId/steer`
 * (`SteerQueuedMessageResponseSchema` — discriminated on [status]):
 * `'steered'` → [localId]; `'invoked'` → [message]; `'failed'` → [error] + [localId].
 */
@Serializable
data class SteerQueuedMessageResponse(
    val status: String,
    val localId: String? = null,
    val message: DecryptedMessage? = null,
    val error: String? = null,
)

/**
 * `POST /api/sessions/:id/messages/queued-state` — resyncs optimistic sends
 * after reconnect (`QueuedStateResponse`, `shared/src/apiTypes.ts`).
 */
@Serializable
data class QueuedStateResponse(
    val queuedLocalIds: List<String>,
    val invokedLocalMessages: List<InvokedLocalMessage>,
    val indeterminateLocalIds: List<String> = emptyList(),
)

@Serializable
data class InvokedLocalMessage(
    val localId: String,
    val invokedAt: Long,
)

/**
 * `POST /api/machines/:id/spawn` — discriminated on [type], **not** HTTP
 * status: a failed spawn is still HTTP 200 with `type: 'error'` + [message].
 */
@Serializable
data class SpawnResponse(
    /** `'success' | 'error'`. */
    val type: String,
    val sessionId: String? = null,
    val message: String? = null,
    /** `agent_unavailable | runner_upgrade_required | outside_workspace_roots`. */
    val code: String? = null,
    val agent: String? = null,
)

/** `GET /api/sessions/:id/slash-commands` (RPC-wrapped: check [success]). */
@Serializable
data class SlashCommandsResponse(
    val success: Boolean,
    val commands: List<SlashCommand>? = null,
    val error: String? = null,
)

@Serializable
data class SlashCommand(
    val name: String,
    val description: String? = null,
    /** `'builtin' | 'user' | 'plugin' | 'project'`. */
    val source: String,
    val content: String? = null,
    val pluginName: String? = null,
)

/** `GET /api/sessions/:id/skills` (RPC-wrapped: check [success]). */
@Serializable
data class SkillsResponse(
    val success: Boolean,
    val skills: List<SkillSummary>? = null,
    val error: String? = null,
)

@Serializable
data class SkillSummary(
    val name: String,
    val description: String? = null,
)

/** `POST /api/machines/:id/list-directory` (RPC-wrapped: check [success]). */
@Serializable
data class MachineListDirectoryResponse(
    val success: Boolean,
    val entries: List<MachineDirectoryEntry>? = null,
    val error: String? = null,
)

/** `DirectoryEntry & {isGitRepo?}` (`shared/src/apiTypes.ts`). */
@Serializable
data class MachineDirectoryEntry(
    val name: String,
    /** `'file' | 'directory' | 'other'`. */
    val type: String,
    val size: Long? = null,
    /** Epoch ms (fs mtime — may arrive fractional; see [LenientEpochMs]). */
    @Serializable(with = LenientEpochMs::class)
    val modified: Long? = null,
    val isGitRepo: Boolean? = null,
)

/** `POST /api/machines/:id/paths/exists`. */
@Serializable
data class MachinePathsExistsResponse(
    val exists: Map<String, Boolean>,
    val outsideWorkspaceRoots: List<String>? = null,
)

/** `GET /api/machines/:id/agent-availability`. */
@Serializable
data class AgentAvailabilityResponse(
    val agents: List<AgentAvailabilityEntry>,
)

@Serializable
data class AgentAvailabilityEntry(
    val agent: String,
    val available: Boolean,
    /** `not_found | invalid_configuration`. */
    val reason: String? = null,
)

/**
 * `GET /api/machines/:id/codex-models` (also the session-level twin) —
 * RPC-wrapped: check [success]. A runner that does not expose the machine RPC
 * answers 503 `{success:false, code:'rpc_target_missing'}` (surfaces as
 * [app.hapi.data.api] ApiError, not this body). Added for B-M3d (new-session
 * codex model picker); `CodexModelsResponse` in `shared/src/apiTypes.ts`.
 */
@Serializable
data class CodexModelsResponse(
    val success: Boolean,
    val models: List<CodexModelSummary>? = null,
    val error: String? = null,
)

/** `CodexModelSummary` (`shared/src/apiTypes.ts`). */
@Serializable
data class CodexModelSummary(
    val id: String,
    val displayName: String,
    val isDefault: Boolean,
    val defaultReasoningEffort: String? = null,
    val defaultServiceTier: String? = null,
    val supportedReasoningEfforts: List<String>? = null,
    /** Service tier ids advertised for this model in the current auth/plan context (e.g. `fast`). */
    val serviceTiers: List<String>? = null,
)

/**
 * `GET /api/machines/:id/grok-models?cwd=` (RPC-wrapped: check [success]) —
 * the directory-scoped Grok probe; `GrokModelsResponse` in
 * `shared/src/apiTypes.ts`. This slice consumes only
 * [autoPermissionModeSupported] (the create-form Auto gate); model discovery
 * stays deferred and unknown fields are ignored by [HapiJson].
 */
@Serializable
data class GrokModelsResponse(
    val success: Boolean,
    val availableModels: List<GrokModelSummary>? = null,
    val currentModelId: String? = null,
    /**
     * Nullable on purpose: the server may omit it, and the gate fires only on
     * a literal `false` (web guards with `=== false`).
     */
    val autoPermissionModeSupported: Boolean? = null,
    val error: String? = null,
)

/** `GrokModelSummary` (`shared/src/apiTypes.ts`). */
@Serializable
data class GrokModelSummary(
    val modelId: String,
    val name: String? = null,
)

/**
 * `GET /api/machines/:id/claude-models` (RPC-wrapped: check [success]) — the
 * machine's Claude catalog. `value` is the alias the CLI accepts
 * (`opus`/`sonnet`/`haiku`), while [ClaudeModelSummary.displayName] carries the
 * model actually served behind that alias (a relay may map `opus` to a
 * non-Anthropic model), which is what the picker must show.
 */
@Serializable
data class ClaudeModelsResponse(
    val success: Boolean,
    val availableModels: List<ClaudeModelSummary>? = null,
    val error: String? = null,
)

/** `ClaudeModelSummary`. */
@Serializable
data class ClaudeModelSummary(
    val value: String,
    val displayName: String? = null,
    val effortLevels: List<String>? = null,
)

/**
 * `GET /api/machines/:id/kimi-models?cwd=` (RPC-wrapped: check [success]) —
 * the directory-scoped Kimi catalog. The runner reads the agent's own model
 * list, so ids are opaque strings that must be sent back verbatim.
 */
@Serializable
data class KimiModelsResponse(
    val success: Boolean,
    val availableModels: List<KimiModelSummary>? = null,
    val currentModelId: String? = null,
    val error: String? = null,
)

/**
 * `KimiModelSummary` — [provider] qualifies the label because ids are namespaced
 * (`kimi-code/k3`, `DeepSeek/deepseek-v4-pro`) and bare display names repeat.
 */
@Serializable
data class KimiModelSummary(
    val modelId: String,
    val name: String? = null,
    val provider: String? = null,
)

/**
 * `GET /api/machines/:id/dsh-models` and its session-level twin
 * `/api/sessions/:id/dsh-models` (RPC-wrapped: check [success]) — the
 * DeepSeek Harness catalog. Model ids are opaque JSON tuples
 * (`["deepseek-official","deepseek-v4-pro"]`) that must be sent back verbatim.
 */
@Serializable
data class DshModelsResponse(
    val success: Boolean,
    val availableModels: List<DshModelSummary>? = null,
    val currentModelId: String? = null,
    val error: String? = null,
)

/** `DshModelSummary`. */
@Serializable
data class DshModelSummary(
    val modelId: String,
    val name: String? = null,
)

/** `POST /api/sessions/:id/upload` (RPC-wrapped: check [success]). */
@Serializable
data class UploadFileResponse(
    val success: Boolean,
    /** Pass through as `AttachmentMetadata.path` when sending the message. */
    val path: String? = null,
    val error: String? = null,
)

/** `POST /api/sessions/:id/upload/delete` (RPC-wrapped: check [success]). */
@Serializable
data class DeleteUploadResponse(
    val success: Boolean,
    val error: String? = null,
)

/** `POST /api/voice/transcription` (the one multipart endpoint). */
@Serializable
data class TranscriptionResponse(
    val text: String,
    val language: String? = null,
)

/**
 * `GET /api/voice/transcription/providers` — only providers whose keys are
 * configured on the hub (`listConfiguredTranscriptionProviders`,
 * `shared/src/voice.ts`). Empty ⇒ dictation is unavailable. Added in B-M3ce.
 */
@Serializable
data class TranscriptionProvidersResponse(
    val providers: List<TranscriptionProviderInfo>,
)

/** `TranscriptionProviderInfo` (`shared/src/voice.ts`). */
@Serializable
data class TranscriptionProviderInfo(
    /** `openai | elevenlabs | deepgram | groq | openai-compatible | browser-local`. */
    val id: String,
    val label: String,
    /** Subset of `standard` / `realtime`; native dictation uses `standard`. */
    val modes: List<String>,
)
