/**
 * POST /api/settings/preset { name: "claude-subscription" } (fork
 * addition) — merge the Claude-subscription preset (src/core/presets.ts)
 * into the settings record: model slots, the planner and demo-builder
 * overrides, extraction batch size, compaction threshold. Everything else
 * in the record is kept. Existing lessons keep the model they were born
 * with; new lessons start on the preset's strong slot.
 */
import { withClaudeSubscriptionPreset } from "@/src/core";
import { claudeCodeAvailable, readSettingsRecord, writeSettingsRecord } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
	if (body?.name !== "claude-subscription") {
		return Response.json({ error: 'Body must be {name: "claude-subscription"}' }, { status: 400 });
	}
	if (!claudeCodeAvailable()) {
		return Response.json({ error: "The Claude Code CLI is not installed — the preset needs it" }, { status: 409 });
	}
	return Response.json({ settings: writeSettingsRecord(withClaudeSubscriptionPreset(readSettingsRecord())) });
}
