"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CameraIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CAMERA_CONSTRAINTS, CAPTURE_JPEG_QUALITY, photoFileName } from "@/components/camera-capture";
import { useBackLayer } from "./back-layers.ts";

/**
 * The webcam dialog (M17, desktop and desktop browsers): a live preview, Capture, then Use photo or Retake. The result is a
 * File (JPEG) handed to `onPhoto`; the camera is released as soon as the dialog closes. The phone does not use this: its
 * file input opens the camera app itself (camera-capture.ts).
 */
export function CameraDialog({ onPhoto, onClose }: { onPhoto: (file: File) => void; onClose: () => void }) {
	const video = useRef<HTMLVideoElement>(null);
	const [state, setState] = useState<"starting" | "live" | "error">("starting");
	const [error, setError] = useState<string | null>(null);
	const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
	useBackLayer(true, onClose);

	useEffect(() => {
		let stream: MediaStream | null = null;
		let cancelled = false;
		navigator.mediaDevices
			.getUserMedia(CAMERA_CONSTRAINTS)
			.then((s) => {
				if (cancelled) {
					s.getTracks().forEach((t) => t.stop());
					return;
				}
				stream = s;
				const el = video.current;
				if (el) {
					el.srcObject = s;
					void el.play().catch(() => {});
				}
				setState("live");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setError(err instanceof Error && err.name === "NotAllowedError" ? "The camera is blocked. Allow it for this app and try again." : "No camera could be opened.");
				setState("error");
			});
		return () => {
			cancelled = true;
			stream?.getTracks().forEach((t) => t.stop());
		};
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);
	// a preview URL is released when it is replaced or the dialog goes
	useEffect(() => () => void (shot && URL.revokeObjectURL(shot.url)), [shot]);

	const capture = () => {
		const el = video.current;
		if (!el || !el.videoWidth) return;
		const canvas = document.createElement("canvas");
		canvas.width = el.videoWidth;
		canvas.height = el.videoHeight;
		canvas.getContext("2d")?.drawImage(el, 0, 0);
		canvas.toBlob(
			(blob) => {
				if (blob) setShot({ blob, url: URL.createObjectURL(blob) });
			},
			"image/jpeg",
			CAPTURE_JPEG_QUALITY,
		);
	};

	if (typeof document === "undefined") return null;
	return createPortal(
		<div data-lh-menu data-testid="camera-dialog" role="dialog" aria-modal="true" aria-label="Take a photo" className="fixed inset-0 z-[70] grid place-items-center bg-black/60 p-4">
			<div className="flex w-full max-w-xl flex-col gap-3 rounded-xl border bg-card p-3 text-card-foreground shadow-xl">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-semibold">Take a photo</h2>
					<button type="button" aria-label="Close" data-testid="camera-close" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
						<XIcon className="size-4" />
					</button>
				</div>
				<div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
					{/* the live view stays mounted (the stream is attached once); the captured photo covers it */}
					<video ref={video} muted playsInline data-testid="camera-video" className="size-full object-contain" />
					{/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL of the photo just taken */}
					{shot && <img src={shot.url} alt="The photo you took" data-testid="camera-shot" className="absolute inset-0 size-full object-contain" />}
					{state === "starting" && <div className="absolute inset-0 grid place-items-center text-xs text-white/70">Opening the camera…</div>}
					{state === "error" && (
						<div data-testid="camera-error" className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-white/80">
							{error}
						</div>
					)}
				</div>
				<div className="flex justify-end gap-2">
					{shot ? (
						<>
							<Button type="button" variant="ghost" data-testid="camera-retake" onClick={() => setShot(null)}>
								<RotateCcwIcon className="size-4" />
								Retake
							</Button>
							<Button
								type="button"
								data-testid="camera-use"
								onClick={() => {
									onPhoto(new File([shot.blob], photoFileName(Date.now()), { type: "image/jpeg" }));
									onClose();
								}}
							>
								Use photo
							</Button>
						</>
					) : (
						<Button type="button" data-testid="camera-capture" disabled={state !== "live"} onClick={capture}>
							<CameraIcon className="size-4" />
							Capture
						</Button>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}
