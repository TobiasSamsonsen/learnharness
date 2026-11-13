/**
 * THE SERVER-SIDE SURFACE — the only src module (besides the core barrel)
 * that app/ may import. Route handlers and server components come through
 * here; nothing under app/ touches src/store or src/agent directly.
 */

export { healthBody } from "./health.ts";
export * from "./chat-handler.ts";
export * from "./events-stream.ts";
export * from "./chats.ts";
export * from "./graph.ts";
export * from "./source-organization.ts";
export * from "./source-deletion.ts";
export { NotesImportError } from "../agent/subagents/extraction.ts";
export { convertPdf } from "../agent/subagents/pdf-ops.ts";
export { joinPages } from "../agent/subagents/pdf-markdown.ts";
export * from "./commit-positions.ts";
export * from "./jobs.ts";
export { prepareSubmissionImages, prepareSubmissionImageChannels } from "./submission-images.ts";
export * from "./stores.ts";
export { refreshWorkerRequestAdmission } from "../agent/worker-request-admission.ts";
export { readRenderSettings, writeRenderSettings } from "../store/render-settings.ts";
// The settings record + prompt overrides (settings-storage wave, 2026-09-19).
// The *Record aliases keep the app/api/settings routes explicit about which
// seam they touch (the raw record, not the chat-section convenience view).
export {
	readSettings as readSettingsRecord,
	writeSettings as writeSettingsRecord,
	settingsStore,
} from "../store/settings.ts";
export { promptOverrides } from "../store/prompt-overrides.ts";
export { themeStore } from "../store/themes.ts";
export { readThemeBoot, type ThemeBoot } from "./theme-boot.ts";
export { isValidSegmentPath } from "../core/prompt-segments.ts";
// The canonical segment discovery/resolution lives in the agent layer
// (composition is an agent concern); the barrel re-exports it for the
// routes — server→agent is the lawful direction (chat-handler precedent).
export { effectivePromptSegments, allSegmentPaths, readPromptOverride } from "../agent/prompt-segments.ts";

// The auth/keys composition (auth-keys wave, 2026-09-19): the curated
// key catalog + the env-reflecting store behind GET/PUT/DELETE /api/keys.
// Importing this module runs the idempotent boot fill-gap — every consumer
// keeps its plain process.env reads (that seam is the point).
export * from "./keys.ts";
export * from "./search.ts";
export { authStore } from "../store/auth.ts";
export * from "./settings-body.ts";
export { fileAccessConfigurationError } from "./file-access.ts";
export * from "./turn-liveness.ts";
export * from "./turn-runs.ts";
export * from "./dismissal-park.ts";
export * from "./clarify.ts";
export * from "./compaction.ts";
export { sideChats, createSideChatService, type SideChatService, type SideChatDeps, type SideStreamEvent } from "./side-chat.ts";
export { runPiTurn, piTurnResponse, type PiTurnHandle, type PiTurnSpec } from "./pi/ui-stream.ts";
export * from "./observability.ts";
export { abortPluginWorkerActivity } from "./plugin-worker-activity.ts";
export * from "./model-catalog.ts";
export { claudeCodeAvailable } from "./claude-code-config.ts";
export { claudePlanUsage } from "../agent/claude-code/plan-usage.ts";
export { localSttStatuses, prepareLocalStt, sttPieceLimits, transcribeLocal } from "./stt-local.ts";
export { vocabularyForChat } from "./stt-vocabulary.ts";
export { dismissUpstreamVersion, launchClaudeUpdate, upstreamStatus } from "./upstream.ts";
export { readSketchPage, readSketchStrokes, sniffImageMime } from "./sketches.ts";
// GitHub sync (fork addition, 2026-11-02): status, the manual round, the boot-time loop.
export { previewReplaceFromRepo, replaceDeviceFromRepo, runSyncNow, startSyncLoop, syncStatus, SYNC_TOKEN_KEY } from "./sync-service.ts";
export { parseRepo } from "./sync/service.ts";
// Is the server doing work? (the Android app rests an unused server on this)
export { serverBusy, type BusyReport } from "./busy.ts";
export { addLinkMaterial, addUploadedMaterial, listMaterials, removeMaterial } from "./materials.ts";
// Courses (fork addition — docs/courses.md).
export {
	approveCourse,
	courseDrafting,
	courseWeighing,
	courseView,
	lessonResult,
	createCourse,
	createCourseSession,
	courseSessionSkillNames,
	deleteCourse,
	listCourseSummaries,
	renameCourse,
	setCourseLanguage,
	setCourseNote,
	setCoursePace,
	setCourseExamDate,
	setCourseSkillWeights,
	parseExamDateField,
	parseWeightsField,
	startCourseWeighing,
	todayCourses,
	graphSkillLayer,
	startCourseDraft,
} from "./courses.ts";
export { subscriptionControlsResponse, subscriptionBrowserResponse } from "./web-subscription-http.ts";
export { sessionCost } from "./pricing.ts";
export { initializePlugins, getPluginHost, getPluginAgentContributions, getPluginQuestionTypeResolver, pluginTransport } from "./plugins.ts";
export { createPluginDocumentRoute } from "./plugin-transport.ts";
export { pluginProblemAvailabilityOf, type ProblemTypeResolver } from "./plugin-problems.ts";
export { pluginQuestionAvailabilityOf, reconcilePluginQuestionCompatibility, preparePluginQuestionDismissal, type QuestionTypeResolver } from "./plugin-questions.ts";
export { claudeCodeInstallationResponse } from "./claude-code.ts";
// The custom endpoint module (registers into piModels() + probes for models).
// No import side effects; the boot sync lives in stores.ts.
export * from "./custom-provider.ts";
export { customProviderGet, customProviderMutation } from "./custom-provider-http.ts";
// The learner profile (fork addition, 2026-11-11): birth snapshot, stats and the on-demand Adapt pass.
export { digestChats, learnerSnapshot } from "./learner-profile.ts";
// "Grade again" on an ungraded concluded problem (fork addition, 2026-11-13).
export { regradeConcludedProblem } from "./practice-grade.ts";
// One hint on the pending lesson question (fork addition, 2026-11-13).
export { handleHintRequest } from "./hint.ts";
export { learnerStats, runAdapt, type AdaptOutcome } from "./learner-adapt.ts";
