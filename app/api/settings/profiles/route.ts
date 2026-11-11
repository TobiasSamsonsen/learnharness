/**
 * POST /api/settings/profiles — model-profile actions (core/profiles.ts), one
 * atomic record write each (the live `models` + `agent.models` and the
 * `profiles` section move together):
 *
 *   { action: "switch", name }            apply a profile (user or built-in)
 *   { action: "create", name }            new profile from the live models; active
 *   { action: "rename", name, newName }
 *   { action: "delete", name }
 *
 * A profile naming an unavailable provider still applies (owner, Q4): the UI
 * shows the warning, the catalog gate is not applied here.
 */
import { applyProfile, createProfile, deleteProfile, renameProfile } from "@/src/core";
import { readSettingsRecord, writeSettingsRecord } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { action?: unknown; name?: unknown; newName?: unknown } | null;
	if (!body || typeof body.name !== "string") {
		return Response.json({ error: 'Body must be {action, name}' }, { status: 400 });
	}
	const record = readSettingsRecord();
	const result =
		body.action === "switch" ? applyProfile(record, body.name)
		: body.action === "create" ? createProfile(record, body.name)
		: body.action === "delete" ? deleteProfile(record, body.name)
		: body.action === "rename" && typeof body.newName === "string" ? renameProfile(record, body.name, body.newName)
		: null;
	if (!result) return Response.json({ error: "action must be switch, create, rename (with newName) or delete" }, { status: 400 });
	if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
	return Response.json({ settings: writeSettingsRecord(result.record) });
}
