// M11 (docs/android/m11-plan.md): what does GET /api/chats cost as the chat count grows?
// Builds synthetic chats in a throw-away LH_DATA_DIR (never your data) and times chatStore.listChats().
//   npx tsx scripts/bench-list-chats.ts [counts…]        default: 10 50 150 400
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-bench-chats-"));
process.env.LH_DATA_DIR = dir; // before the store is imported: PATHS reads it once
const { chatStore } = await import("../src/store/chats.ts");

const counts = process.argv.slice(2).map(Number).filter((n) => n > 0);
if (counts.length === 0) counts.push(10, 50, 150, 400);

const filler = "Primtall er naturlige tall større enn 1 som bare er delelige med 1 og seg selv. ".repeat(10);
let made = 0;
function grow(to: number): void {
	for (; made < to; made++) {
		const chat = chatStore.createChat(`Bench chat ${made}`);
		const messages = Array.from({ length: 20 }, (_, i) =>
			i % 2 === 0
				? { role: "user" as const, content: `Question ${i} ${filler}`, timestamp: Date.now() + i }
				: { role: "assistant" as const, content: [{ type: "text" as const, text: `Answer ${i} ${filler}` }], timestamp: Date.now() + i },
		);
		// biome-ignore lint: synthetic messages only need the shape the folds read
		chatStore.saveMessages(chat.id, messages as never);
	}
}

for (const n of counts) {
	grow(n);
	const bytes = fs.readdirSync(path.join(dir, "chats")).reduce((a, f) => a + fs.statSync(path.join(dir, "chats", f)).size, 0);
	const times: number[] = [];
	for (let i = 0; i < 15; i++) {
		const t = performance.now();
		chatStore.listChats();
		times.push(performance.now() - t);
	}
	times.sort((a, b) => a - b);
	console.log(`${String(n).padStart(4)} chats  ${(bytes / 1024).toFixed(0).padStart(6)} KB   listChats median ${times[7]!.toFixed(1).padStart(7)} ms   p90 ${times[13]!.toFixed(1).padStart(7)} ms`);
}
fs.rmSync(dir, { recursive: true, force: true });
