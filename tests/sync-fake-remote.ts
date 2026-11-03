/**
 * An in-memory stand-in for the GitHub repo, with the surface the sync engine
 * uses (not a test file itself: tests/*.test.ts is what the runner takes).
 */

import { GitHubError, type PushChange, type RepoHead } from "../src/server/sync/github.ts";
import { gitBlobSha } from "../src/server/sync/local.ts";

/** An in-memory repo with the GitHubRepo surface the engine uses. */
export class FakeRemote {
	files = new Map<string, Uint8Array>();
	blobsBySha = new Map<string, Uint8Array>();
	n = 0;
	date = "2026-01-01T00:00:00Z";
	pushes = 0;
	/** Run once, during the next blobs() call (the async window of a round). */
	duringBlobs: (() => void) | null = null;
	/** Fail this many pushes as "the branch moved". */
	failPushes = 0;
	/** What info() reports; the service refuses a public repo. */
	isPrivate = true;
	/** Count of head() calls (a round starts with one). */
	heads = 0;

	async info() {
		return { defaultBranch: "main", private: this.isPrivate };
	}
	async head(): Promise<RepoHead | null> {
		this.heads++;
		return this.n === 0 ? null : { commit: `c${this.n}`, tree: `t${this.n}`, date: this.date };
	}
	async tree() {
		return Object.fromEntries([...this.files].map(([p, b]) => [p, { sha: gitBlobSha(b), size: b.length }]));
	}
	async blob(sha: string) {
		const b = this.blobsBySha.get(sha);
		if (!b) throw new GitHubError("no such blob", "not-found", 404);
		return b;
	}
	async blobs(shas: readonly string[]) {
		this.duringBlobs?.();
		this.duringBlobs = null;
		return Object.fromEntries(await Promise.all([...new Set(shas)].map(async (s) => [s, await this.blob(s)] as const)));
	}
	async push(_branch: string, parent: RepoHead | null, changes: readonly PushChange[]) {
		if (this.failPushes > 0) {
			this.failPushes--;
			throw new GitHubError("not a fast forward", "conflict", 422);
		}
		if ((parent?.commit ?? null) !== (this.n === 0 ? null : `c${this.n}`)) throw new GitHubError("not a fast forward", "conflict", 422);
		for (const c of changes) {
			if (c.content === null) this.files.delete(c.path);
			else {
				this.files.set(c.path, c.content);
				this.blobsBySha.set(gitBlobSha(c.content), c.content);
			}
		}
		this.pushes++;
		this.n++;
		return { commit: `c${this.n}`, tree: `t${this.n}` };
	}
	/** Seed a file as if pushed earlier. */
	put(p: string, content: string) {
		const b = Buffer.from(content);
		this.files.set(p, b);
		this.blobsBySha.set(gitBlobSha(b), b);
	}
	text(p: string): string | null {
		const b = this.files.get(p);
		return b ? Buffer.from(b).toString("utf8") : null;
	}
}
