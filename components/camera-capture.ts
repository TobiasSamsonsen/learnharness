/**
 * Taking a photo from the app (M17, docs/android/m17-plan.md): which way the camera opens on this device, and the file a
 * capture becomes. Pure, so the choice is tested without a browser.
 *
 *   input   a file input with `capture="environment"`: the Android shell opens the phone's camera app itself (MainActivity,
 *           PhotoCapture), and a phone browser does the same. Best focus, flash and resolution for paper.
 *   dialog  a webcam dialog (camera-dialog.tsx): the desktop app and a desktop browser.
 *   none    no way to reach a camera: the Camera entry is not shown.
 */

export type CameraRoute = "input" | "dialog" | "none";

export interface CameraEnv {
	/** The Android shell's `window.lhAndroid` bridge exists. */
	androidShell: boolean;
	/** A coarse pointer: a phone or tablet browser, where `capture` opens the camera app. */
	coarsePointer: boolean;
	/** `navigator.mediaDevices.getUserMedia` exists. */
	hasGetUserMedia: boolean;
}

export function cameraRoute(env: CameraEnv): CameraRoute {
	if (env.androidShell || env.coarsePointer) return "input";
	return env.hasGetUserMedia ? "dialog" : "none";
}

/** The environment of this page, or null on the server. */
export function detectCameraEnv(): CameraEnv | null {
	if (typeof window === "undefined") return null;
	let coarse = false;
	try {
		coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
	} catch {
		coarse = false;
	}
	return {
		androidShell: !!(window as unknown as { lhAndroid?: unknown }).lhAndroid,
		coarsePointer: coarse,
		hasGetUserMedia: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function",
	};
}

/** The name a captured photo is stored under (a timestamp: two photos never collide). */
export function photoFileName(nowMs: number): string {
	return `photo-${new Date(nowMs).toISOString().replace(/[:.]/g, "-")}.jpg`;
}

/** The webcam constraints: the back camera when there is one, a good resolution, no sound. */
export const CAMERA_CONSTRAINTS = {
	video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
	audio: false,
} as const;

/** The JPEG quality of a webcam capture (the server re-encodes it anyway). */
export const CAPTURE_JPEG_QUALITY = 0.92;
