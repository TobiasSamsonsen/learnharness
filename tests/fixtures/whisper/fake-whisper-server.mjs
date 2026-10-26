/**
 * A stand-in for whisper.cpp's `whisper-server` (Android plan M4 tests):
 * the same flags (-m, --host, --port, -t), GET / answers once "loaded",
 * POST /inference takes a multipart form and answers { text }. Each request
 * is appended to FAKE_WHISPER_LOG as one JSON line (what the engine sent);
 * the reply text is FAKE_WHISPER_TEXT, or the received prompt when it is
 * "<prompt>" (the echo a real model produces on an unclear clip).
 */
import * as fs from "node:fs";
import * as http from "node:http";

const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const port = Number(flag("--port"));
const log = process.env.FAKE_WHISPER_LOG;
if (log) fs.appendFileSync(log, `${JSON.stringify({ started: { model: flag("-m"), host: flag("--host"), threads: flag("-t") ?? null } })}\n`);

function field(body, name) {
	const m = new RegExp(`name="${name}"\r\n\r\n([^\r]*)\r\n`).exec(body);
	return m ? m[1] : null;
}

http
	.createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/inference") {
			res.writeHead(200, { "Content-Type": "text/html" }).end("<html>whisper</html>");
			return;
		}
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks);
			const body = raw.toString("utf8");
			const prompt = field(body, "prompt");
			if (log) {
				fs.appendFileSync(
					log,
					`${JSON.stringify({ language: field(body, "language"), temperature: field(body, "temperature"), format: field(body, "response_format"), prompt, riff: body.includes("RIFF") && body.includes("WAVEfmt ") })}\n`,
				);
			}
			const reply = process.env.FAKE_WHISPER_TEXT === "<prompt>" ? (prompt ?? "") : (process.env.FAKE_WHISPER_TEXT ?? " hello world [BLANK_AUDIO]");
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: reply }));
		});
	})
	.listen(port, "127.0.0.1");

// Killing a .cmd shim on Windows leaves this process behind (and its pipes keep the test run alive): leave with the parent.
const parent = process.ppid;
setInterval(() => {
	try {
		process.kill(parent, 0);
	} catch {
		process.exit(0);
	}
}, 500);
