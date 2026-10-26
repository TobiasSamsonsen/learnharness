import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, COOKIE_MAX_AGE_S, accessDecision } from "./src/server/access-gate.ts";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";

const FORBIDDEN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LearnHarness</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Not paired</h1><p>This server asks for an access token. Open the pairing URL the start script printed.</p>`;

/** Every API method, including SSE and spending/settings routes, needs the
 * Electron capability when the desktop shell runs the server. No public
 * callback or worker bypass: internal jobs call server functions, and any
 * legitimate self-HTTP request must carry the private capability.
 *
 * With LH_ACCESS_TOKEN set (headless, Android plan M6) pages and API both
 * need the paired cookie, and Host/Origin are checked; see access-gate.ts. */
export function proxy(request: NextRequest) {
	const { pathname, search } = request.nextUrl;
	if ((pathname === "/api" || pathname.startsWith("/api/")) && !desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	const decision = accessDecision({
		method: request.method,
		pathname,
		search,
		host: request.headers.get("host"),
		origin: request.headers.get("origin"),
		cookieHeader: request.headers.get("cookie"),
	});
	if (decision.kind === "pair") {
		// back to the address the browser used (its Host passed the allow-list), not the server's own bind address
		const target = new URL(decision.location, `${request.nextUrl.protocol}//${request.headers.get("host")}`);
		const response = NextResponse.redirect(target, { status: 303, headers: { "Cache-Control": "no-store" } });
		response.cookies.set({ name: ACCESS_COOKIE, value: decision.token, httpOnly: true, sameSite: "strict", path: "/", maxAge: COOKIE_MAX_AGE_S });
		return response;
	}
	if (decision.kind === "deny") {
		if (decision.surface === "api") {
			return NextResponse.json({ error: decision.reason }, { status: 403, headers: { "Cache-Control": "no-store" } });
		}
		return new NextResponse(FORBIDDEN_PAGE, { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
	}
	return NextResponse.next();
}

/** Everything but the build's own static assets: pages need the gate too. */
export const config = { matcher: "/((?!_next/static|_next/image|favicon.ico).*)" };
