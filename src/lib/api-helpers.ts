/**
 * Shared helpers for Network Edge API routes.
 *
 * Kept free of top-level `cloudflare:workers` runtime imports so route handlers
 * and helpers can be imported and tested offline in Node.js.
 */

/** Signature of an injectable Workers AI runner function. */
export type AIRunner = (model: string, input: unknown) => Promise<unknown>;

/**
 * Default Workers AI runner that lazily resolves the `cloudflare:workers`
 * runtime binding when invoked inside the Worker runtime.
 */
export const defaultRunAI: AIRunner = async (model: string, input: unknown) => {
	const { env } = await import('cloudflare:workers');
	return (env.AI.run as unknown as AIRunner).call(env.AI, model, input);
};

/**
 * Build a JSON `Response` with `no-store` caching defaults for live API routes.
 */
export const json = (body: unknown, init?: ResponseInit) =>
	new Response(JSON.stringify(body), {
		...init,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...init?.headers,
		},
	});

/**
 * Convert an ArrayBuffer to a base64 string in fixed-size chunks.
 *
 * We chunk because `String.fromCharCode(...bytes)` spreads every byte as a
 * function argument; on a full-frame image that can blow the call-stack arg
 * limit. 8 KB chunks stay well under it.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	let binary = '';
	const bytes = new Uint8Array(buffer);
	const chunkSize = 8192;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

/**
 * Encode an ArrayBuffer image into a `data:<contentType>;base64,...` data URL.
 */
export function arrayBufferToDataUrl(buffer: ArrayBuffer, contentType = 'image/jpeg'): string {
	return `data:${contentType};base64,${arrayBufferToBase64(buffer)}`;
}

/** True for non-null, non-array objects (parsed JSON objects). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize an incoming image string (either a `data:image/...;base64,...` data
 * URL or a raw base64 payload) and estimate its decoded byte size.
 */
export function normalizeImageString(rawImage: unknown):
	| { ok: true; dataUrl: string; bytes: number }
	| { ok: false; error: string } {
	if (typeof rawImage !== 'string' || !rawImage.trim()) {
		return { ok: false, error: 'Image body is empty.' };
	}

	const trimmed = rawImage.trim();
	const dataUrlMatch = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(
		trimmed
	);

	if (dataUrlMatch) {
		const mime = dataUrlMatch[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : dataUrlMatch[1].toLowerCase();
		const base64Payload = dataUrlMatch[2].replace(/\s+/g, '');
		const bytes = estimateBase64Bytes(base64Payload);
		if (bytes <= 0) {
			return { ok: false, error: 'Image body is empty.' };
		}
		return {
			ok: true,
			dataUrl: `data:${mime};base64,${base64Payload}`,
			bytes,
		};
	}

	if (trimmed.startsWith('data:')) {
		return {
			ok: false,
			error: 'Image data URL must be base64-encoded image/jpeg, image/png, or image/webp.',
		};
	}

	const compactBase64 = trimmed.replace(/\s+/g, '');
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compactBase64)) {
		return {
			ok: false,
			error: 'Image must be a valid base64 string or data:image/*;base64 data URL.',
		};
	}

	const bytes = estimateBase64Bytes(compactBase64);
	if (bytes <= 0) {
		return { ok: false, error: 'Image body is empty.' };
	}

	return {
		ok: true,
		dataUrl: `data:image/jpeg;base64,${compactBase64}`,
		bytes,
	};
}

function estimateBase64Bytes(base64: string): number {
	if (!base64) return 0;
	const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
