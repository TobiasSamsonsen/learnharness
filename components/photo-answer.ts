/**
 * A photo answer (M17), client side: a picked or taken photo of handwritten work becomes a SketchPayload with one raster
 * page (producer "photo"). The image is decoded with its EXIF rotation applied, scaled to fit PHOTO_MAX_EDGE, re-encoded as
 * JPEG and sent as base64. The server checks the same limits again (core/sketch.ts).
 */
import { newSketchId, type SketchPayload } from "@/src/core";

export const PHOTO_MAX_EDGE = 2000;
export const PHOTO_MIN_EDGE = 600;
export const PHOTO_JPEG_QUALITY = 0.85;

/** Scales (width, height) down so the long edge is at most `max`, keeping the proportions. Never enlarges; each side >= 1. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
	const long = Math.max(width, height);
	const scale = long > max ? max / long : 1;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/** A photo the app cannot use; the message is shown to the owner as it is. */
export class PhotoError extends Error {}

export interface PreparedPhoto {
	payload: SketchPayload;
	/** A blob: URL of the JPEG, for the preview; release it with releasePhoto. */
	previewUrl: string;
}

/** Decodes, scales and re-encodes a photo into a sketch payload. Throws PhotoError when it is not a usable picture. */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
	} catch {
		throw new PhotoError("That file is not a picture I can read.");
	}
	try {
		if (Math.max(bitmap.width, bitmap.height) < PHOTO_MIN_EDGE) {
			throw new PhotoError("The photo is too small to read handwriting in. Take it closer.");
		}
		const { width, height } = fitWithin(bitmap.width, bitmap.height, PHOTO_MAX_EDGE);
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new PhotoError("The photo could not be prepared.");
		ctx.drawImage(bitmap, 0, 0, width, height);

		const blob = await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob((b) => (b ? resolve(b) : reject(new PhotoError("The photo could not be prepared."))), "image/jpeg", PHOTO_JPEG_QUALITY),
		);
		const data = await blobToBase64(blob);
		const payload: SketchPayload = {
			id: newSketchId(),
			producer: "photo",
			strokes: [],
			photo: { mimeType: "image/jpeg", width, height, data },
		};
		return { payload, previewUrl: URL.createObjectURL(blob) };
	} finally {
		bitmap.close();
	}
}

/** Frees the preview of a prepared photo (or nothing, for null). */
export function releasePhoto(p: PreparedPhoto | null): void {
	if (p) URL.revokeObjectURL(p.previewUrl);
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = typeof reader.result === "string" ? reader.result : "";
			const comma = result.indexOf(",");
			if (comma < 0) reject(new PhotoError("The photo could not be prepared."));
			else resolve(result.slice(comma + 1));
		};
		reader.onerror = () => reject(new PhotoError("The photo could not be prepared."));
		reader.readAsDataURL(blob);
	});
}
