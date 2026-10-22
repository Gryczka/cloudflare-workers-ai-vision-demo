/**
 * POST /api/detect — single-frame object detection.
 *
 * Accepts a raw `image/*` request body (a JPEG frame captured in the browser),
 * runs Meta's DETR ResNet-50 object detector on Workers AI, and returns the
 * detected objects as JSON. The browser draws the returned boxes over the live
 * video feed.
 *
 * This route is the server half of the `/` (live detection) view and the fast
 * "person box" track of the `/ppe` view. It is intentionally stateless: every
 * request is one independent inference.
 *
 * @see https://developers.cloudflare.com/workers-ai/models/detr-resnet-50/
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { json } from '../../lib/api-helpers.ts';

// Render this route on every request (server-side). Without this, Astro would
// try to prerender it at build time, which is wrong for a dynamic API endpoint.
export const prerender = false;

/** The Workers AI model that performs object detection for this route. */
const MODEL = '@cf/facebook/detr-resnet-50';

/**
 * One object detected by DETR. Coordinates are in pixels relative to the image
 * that was sent (here, the 640x360 capture buffer), with the origin top-left.
 */
type Detection = {
	/** Confidence in the range 0..1. The browser filters on this. */
	score: number;
	/** COCO class label, e.g. "person", "car", "dog". */
	label: string;
	/** Axis-aligned bounding box in source-image pixels. */
	box: {
		xmin: number;
		ymin: number;
		xmax: number;
		ymax: number;
	};
};

/**
 * Handle a detection request.
 *
 * Expects the request body to be the raw bytes of an image (Content-Type
 * `image/jpeg`, `image/png`, ...). Returns `{ detections, inferenceMs, bytes,
 * model }` on success, or `{ error }` with a 4xx status on bad input.
 */
export const POST: APIRoute = async ({ request }) => {
	const contentType = request.headers.get('content-type') ?? '';

	// Guard: this endpoint only understands raw image bodies, not multipart
	// form-data or JSON. 415 = Unsupported Media Type.
	if (!contentType.startsWith('image/')) {
		return json({ error: 'Send a raw image/* request body.' }, { status: 415 });
	}

	const image = await request.arrayBuffer();

	if (image.byteLength === 0) {
		return json({ error: 'Image body is empty.' }, { status: 400 });
	}

	const started = Date.now();
	// Workers AI expects the image as an array of byte values (0..255). DETR
	// returns the array of detections directly.
	const detections = (await env.AI.run(MODEL, {
		image: [...new Uint8Array(image)],
	})) as Detection[];

	// `inferenceMs` and `bytes` are surfaced in the UI's live metrics panel.
	return json({
		detections,
		inferenceMs: Date.now() - started,
		bytes: image.byteLength,
		model: MODEL,
	});
};
