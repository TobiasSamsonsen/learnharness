import WebSocket from "ws";
const [expr] = process.argv.slice(2);
const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = list.find((p) => p.type === "page") ?? list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
ws.on("message", (m) => { const d = JSON.parse(m); if (d.id === 1) { console.log(JSON.stringify(d.result?.result?.value ?? d.result ?? d).slice(0, 1500)); process.exit(0); } });
setTimeout(() => process.exit(2), 15000);
