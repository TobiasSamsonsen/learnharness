"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cameraRoute, detectCameraEnv, type CameraRoute } from "@/components/camera-capture";
import { CameraDialog } from "@/components/camera-dialog";

/**
 * The camera for any dock (M17): the phone's camera app through a capture input, a webcam dialog on desktop. The route is
 * known on the client only (initial "none", so the server render matches); `available` is false until then and where there is
 * no camera. `open()` starts a capture; `node` must be rendered once by the caller (the hidden input and the dialog).
 * Each photo (or each picked file) goes to `onFiles`.
 */
export function useCamera(onFiles: (files: File[]) => void): { available: boolean; open: () => void; node: ReactNode } {
	const inputRef = useRef<HTMLInputElement>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [route, setRoute] = useState<CameraRoute>("none");
	useEffect(() => {
		const env = detectCameraEnv();
		if (env) setRoute(cameraRoute(env));
	}, []);

	const open = () => {
		if (route === "input") inputRef.current?.click();
		else if (route === "dialog") setDialogOpen(true);
	};

	const node = (
		<>
			<input
				ref={inputRef}
				type="file"
				accept="image/*"
				capture="environment"
				className="hidden"
				data-testid="camera-input"
				onChange={(e) => {
					const files = Array.from(e.currentTarget.files ?? []);
					e.currentTarget.value = ""; // the same photo name can come again
					onFiles(files);
				}}
			/>
			{dialogOpen && <CameraDialog onPhoto={(file) => onFiles([file])} onClose={() => setDialogOpen(false)} />}
		</>
	);

	return { available: route !== "none", open, node };
}
