/**
 * POST /api/extract-decide — run an Extract + Decide recipe on one frame.
 *
 * Accepts either:
 *   1. `application/json` with `{ image, recipe?, settings? }`
 *   2. Raw `image/*` bytes with `?recipe=<key>` (default: the first recipe).
 *
 * Combines `@cf/cloudflare/clef-flash` (Decide) and `@cf/cloudflare/clairic`
 * (Extract). Recipes, gating, routing, and the result maths live in
 * `src/lib/extract-decide.ts`.
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
import { asRecipeKey, DEFAULT_RECIPE, normalizeSettings, runRecipe, StageError } from '../../lib/extract-decide.ts';

// Server-render on every request (dynamic API endpoint).
export const prerender = false;

export async function handleExtractDecide(
	{ request, url }: { request: Request; url?: URL },
	runAI: AIRunner = defaultRunAI
): Promise<Response> {
	const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
	const resolvedUrl = url ?? new URL(request.url);
	let rawRecipe: unknown = resolvedUrl.searchParams.get('recipe') ?? DEFAULT_RECIPE;
	let rawSettings: unknown = {};
	let image = '';
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
		if (!imageResult.ok) return json({ error: imageResult.error }, { status: 400 });
		image = imageResult.dataUrl;
		bytes = imageResult.bytes;
		if (body.recipe !== undefined) rawRecipe = body.recipe;
		if (body.settings !== undefined) rawSettings = body.settings;
	} else if (contentType.startsWith('image/')) {
		const buffer = await request.arrayBuffer();
		if (buffer.byteLength === 0) return json({ error: 'Image body is empty.' }, { status: 400 });
		bytes = buffer.byteLength;
		image = arrayBufferToDataUrl(buffer, contentType.split(';')[0].trim() || 'image/jpeg');
	} else {
		return json({ error: 'Send an application/json or image/* request body.' }, { status: 415 });
	}

	const recipe = asRecipeKey(rawRecipe);
	if (!recipe) return json({ error: `Unknown recipe "${String(rawRecipe)}".` }, { status: 400 });

	const started = Date.now();
	try {
		const output = await runRecipe(recipe, image, normalizeSettings(rawSettings), runAI);
		return json({ ...output, inferenceMs: Date.now() - started, bytes });
	} catch (error) {
		if (error instanceof StageError) {
			return json({ error: error.message, stage: error.stage, model: error.model, recipe }, { status: 500 });
		}
		const message = error instanceof Error ? error.message : 'Extract + Decide failed.';
		return json({ error: message, recipe }, { status: 500 });
	}
}

export const POST: APIRoute = ({ request, url }) => handleExtractDecide({ request, url });
