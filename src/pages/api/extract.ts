/**
 * POST /api/extract — Structured multimodal extraction endpoint.
 *
 * Accepts either:
 *   1. `application/json` with `{ image, state?, preset?, fields? }`
 *   2. Raw `image/*` bytes (`image/jpeg`, `image/png`, `image/webp`) with an
 *      optional `?preset=<key>` query parameter (any key of `EXTRACT_PRESETS`).
 *
 * Reads, computes, or estimates typed values (`text`, `number`, `date`,
 * `list`, `estimate`, ...) from one captured image against a Field Schema
 * using `@cf/cloudflare/clairic` on Workers AI. The schema rules live in
 * `src/lib/field-schema.ts`, shared with the `/extract` live editor.
 *
 * @see https://developers.cloudflare.com/workers-ai/models/clairic/
 */
import type { APIRoute } from 'astro';
import {
	type AIRunner,
	arrayBufferToDataUrl,
	defaultRunAI,
	isPlainObject,
	json,
	normalizeImageString,
} from '../../lib/api-helpers.ts';
import {
	asExtractPresetKey,
	DEFAULT_EXTRACT_PRESET,
	EXTRACT_PRESETS,
	type ExtractPresetKey,
	normalizeFields,
} from '../../lib/field-schema.ts';

// Server-render on every request (dynamic API endpoint).
export const prerender = false;

export const CLAIRIC_MODEL = '@cf/cloudflare/clairic';
export const CLAIRIC_SELECTOR = 'clairic';

export type ExtractPresetSelection = ExtractPresetKey | 'custom';

function resolveBasePresetKey(value: unknown): ExtractPresetKey {
	return asExtractPresetKey(value) ?? DEFAULT_EXTRACT_PRESET;
}

function resolvePresetKey(value: unknown, hasCustomFields = false): ExtractPresetSelection {
	if (value === 'custom' || (hasCustomFields && !asExtractPresetKey(value))) {
		return 'custom';
	}
	return resolveBasePresetKey(value);
}

/**
 * Handle a multimodal extraction request.
 *
 * Accepts an injectable `runAI` runner (defaulting to the Workers AI binding)
 * so the full HTTP request-to-response contract can be tested offline.
 */
export async function handleExtract(
	{ request, url }: { request: Request; url?: URL },
	runAI: AIRunner = defaultRunAI
): Promise<Response> {
	const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
	const resolvedUrl = url ?? new URL(request.url);
	const queryPreset = resolvedUrl.searchParams.get('preset');

	let presetKey: ExtractPresetSelection = resolveBasePresetKey(queryPreset);
	let state = EXTRACT_PRESETS[resolveBasePresetKey(queryPreset)].state;
	let rawFields: unknown = EXTRACT_PRESETS[resolveBasePresetKey(queryPreset)].fields;
	let imageDataUrl = '';
	let bytes = 0;

	if (contentType.startsWith('application/json')) {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return json({ error: 'Invalid JSON request body.' }, { status: 400 });
		}
		if (!isPlainObject(body)) {
			return json({ error: 'JSON request body must be an object.' }, { status: 400 });
		}

		const imageResult = normalizeImageString(body.image);
		if (!imageResult.ok) {
			return json({ error: imageResult.error }, { status: 400 });
		}
		imageDataUrl = imageResult.dataUrl;
		bytes = imageResult.bytes;

		const requestedPreset = body.preset ?? queryPreset;
		const hasCustomFields = body.fields !== undefined;
		const preset = EXTRACT_PRESETS[resolveBasePresetKey(requestedPreset)];
		presetKey = resolvePresetKey(requestedPreset, hasCustomFields);
		state = typeof body.state === 'string' && body.state.trim() ? body.state.trim() : preset.state;
		// An inline schema replaces the preset; it is never merged with it.
		rawFields = hasCustomFields ? body.fields : preset.fields;
	} else if (contentType.startsWith('image/')) {
		const mediaType = contentType.split(';')[0].trim();
		const imageBuffer = await request.arrayBuffer();
		if (imageBuffer.byteLength === 0) {
			return json({ error: 'Image body is empty.' }, { status: 400 });
		}
		bytes = imageBuffer.byteLength;
		imageDataUrl = arrayBufferToDataUrl(imageBuffer, mediaType || 'image/jpeg');
	} else {
		return json({ error: 'Send an application/json or image/* request body.' }, { status: 415 });
	}

	const validated = normalizeFields(rawFields);
	if (!validated.ok) {
		return json({ error: validated.error }, { status: 400 });
	}

	const started = Date.now();
	try {
		const rawResult = (await runAI(CLAIRIC_MODEL, {
			model: CLAIRIC_SELECTOR,
			state,
			images: [imageDataUrl],
			fields: validated.fields,
		})) as {
			answers?: Record<string, unknown>;
			truncated?: boolean;
			usage?: Record<string, unknown>;
		} | null;

		const inferenceMs = Date.now() - started;
		const answers = rawResult && isPlainObject(rawResult.answers) ? rawResult.answers : {};
		const rawUsage = rawResult && isPlainObject(rawResult.usage) ? rawResult.usage : {};
		const usage = {
			input_tokens: Number(rawUsage.input_tokens ?? 0),
			output_tokens: Number(rawUsage.output_tokens ?? 0),
			image_tokens: Number(rawUsage.image_tokens ?? 0),
			passes: Number(rawUsage.passes ?? 0),
		};

		return json({
			model: CLAIRIC_MODEL,
			preset: presetKey,
			state,
			fields: validated.fields,
			answers,
			truncated: Boolean(rawResult?.truncated),
			usage,
			inferenceMs,
			bytes,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Extraction model inference failed.';
		return json({ error: message, model: CLAIRIC_MODEL, preset: presetKey }, { status: 500 });
	}
}

export const POST: APIRoute = ({ request, url }) => handleExtract({ request, url });
