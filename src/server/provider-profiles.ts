import { duplicateActiveProfile } from "../core/profiles.ts";
import { readSettings, writeSettings } from "../store/settings.ts";

/** Duplicate the active profile under `label` if no profile with that name exists yet (keeps active unchanged). */
export function ensureProviderProfile(label: string): void {
	const next = duplicateActiveProfile(readSettings(), label);
	if (next) writeSettings(next);
}
