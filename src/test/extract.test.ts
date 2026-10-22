import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXTRACT_PRESETS } from '../lib/field-schema.ts';
import { CLAIRIC_MODEL, handleExtract } from '../pages/api/extract.ts';

type RecordedCall = { model: string; input: any };

const sampleImageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const sampleDataUrl = `data:image/jpeg;base64,${Buffer.from(sampleImageBytes).toString('base64')}`;

function recorder(result: unknown = {}) {
	const calls: RecordedCall[] = [];
	const runAI = async (model: string, input: unknown) => {
		calls.push({ model, input });
		if (result instanceof Error) throw result;
		return result;
	};
	return { calls, runAI };
}

function post(body: BodyInit, contentType: string, query = '') {
	const request = new Request(`http://localhost/api/extract${query}`, {
		method: 'POST',
		headers: { 'content-type': contentType },
		body,
	});
	return { request, url: new URL(request.url) };
}

const cannedAnswer = {
	model: 'clairic',
	answers: {
		people_count: { type: 'estimate', value: 1, mean: 1.1, median: 1, p10: 1, p90: 2, p_below: 0, p_above: 0 },
		visible_text: { type: 'text', p_null: 0.9, guess: 'CLOUDFLARE', confidence: 0.4, value: null },
	},
	truncated: false,
	usage: { state_tokens: 8, image_tokens: 260, schema_tokens: 300, input_tokens: 570, output_tokens: 0, passes: 1 },
};

describe('POST /api/extract', () => {
	it('rejects unsupported Content-Type with HTTP 415 without calling runAI', async () => {
		const { calls, runAI } = recorder();
		const response = await handleExtract(post('hello', 'text/plain'), runAI);
		assert.equal(response.status, 415);
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.deepEqual(await response.json(), { error: 'Send an application/json or image/* request body.' });
		assert.equal(calls.length, 0);
	});

	it('rejects empty raw image bodies and empty JSON images with HTTP 400', async () => {
		const { calls, runAI } = recorder();
		const raw = await handleExtract(post(new Uint8Array(0), 'image/jpeg'), runAI);
		assert.equal(raw.status, 400);
		assert.deepEqual(await raw.json(), { error: 'Image body is empty.' });

		const jsonResponse = await handleExtract(post(JSON.stringify({ image: ' ' }), 'application/json'), runAI);
		assert.equal(jsonResponse.status, 400);
		assert.deepEqual(await jsonResponse.json(), { error: 'Image body is empty.' });
		assert.equal(calls.length, 0);
	});

	it('runs raw image/jpeg against the default scene preset and returns answers and usage', async () => {
		const { calls, runAI } = recorder(cannedAnswer);
		const response = await handleExtract(post(sampleImageBytes, 'image/jpeg'), runAI);
		assert.equal(response.status, 200);

		assert.equal(calls.length, 1);
		assert.equal(calls[0].model, CLAIRIC_MODEL);
		assert.equal(calls[0].input.model, 'clairic');
		assert.equal(calls[0].input.state, EXTRACT_PRESETS.scene.state);
		assert.deepEqual(calls[0].input.images, [sampleDataUrl]);
		assert.deepEqual(calls[0].input.fields, EXTRACT_PRESETS.scene.fields);

		const payload = await response.json();
		assert.equal(payload.model, CLAIRIC_MODEL);
		assert.equal(payload.preset, 'scene');
		assert.deepEqual(payload.answers, cannedAnswer.answers);
		assert.equal(payload.truncated, false);
		assert.deepEqual(payload.usage, { input_tokens: 570, output_tokens: 0, image_tokens: 260, passes: 1 });
		assert.equal(payload.bytes, sampleImageBytes.byteLength);
		assert.equal(typeof payload.inferenceMs, 'number');
	});

	it('selects the site preset from the query string', async () => {
		const { calls, runAI } = recorder(cannedAnswer);
		const response = await handleExtract(post(sampleImageBytes, 'image/jpeg', '?preset=site'), runAI);
		assert.equal((await response.json()).preset, 'site');
		assert.deepEqual(calls[0].input.fields, EXTRACT_PRESETS.site.fields);
		assert.equal(calls[0].input.state, EXTRACT_PRESETS.site.state);
	});

	it('selects every built-in preset by key, and falls back to the default for unknown keys', async () => {
		for (const key of Object.keys(EXTRACT_PRESETS)) {
			const { calls, runAI } = recorder(cannedAnswer);
			const response = await handleExtract(post(sampleImageBytes, 'image/jpeg', `?preset=${key}`), runAI);
			assert.equal((await response.json()).preset, key);
			assert.deepEqual(calls[0].input.fields, EXTRACT_PRESETS[key as keyof typeof EXTRACT_PRESETS].fields);
		}

		const { calls, runAI } = recorder(cannedAnswer);
		const response = await handleExtract(post(sampleImageBytes, 'image/jpeg', '?preset=toString'), runAI);
		assert.equal((await response.json()).preset, 'scene');
		assert.deepEqual(calls[0].input.fields, EXTRACT_PRESETS.scene.fields);
	});

	it('replaces (does not merge) the preset with an inline Field Schema and custom state', async () => {
		const { calls, runAI } = recorder(cannedAnswer);
		const fields = { mug_color: { type: 'text', instructions: '  Color of the mug  ' } };
		const response = await handleExtract(
			post(JSON.stringify({ image: sampleDataUrl, preset: 'custom', state: ' Desk cam ', fields }), 'application/json'),
			runAI
		);
		assert.equal(response.status, 200);
		assert.deepEqual(calls[0].input.fields, { mug_color: { type: 'text', instructions: 'Color of the mug' } });
		assert.equal(calls[0].input.state, 'Desk cam');
		const payload = await response.json();
		assert.equal(payload.preset, 'custom');
		assert.deepEqual(payload.fields, calls[0].input.fields);
	});

	it('reports inline fields under a named preset as that preset’s custom override', async () => {
		const { calls, runAI } = recorder(cannedAnswer);
		const fields = { only: { type: 'number' } };
		const response = await handleExtract(
			post(JSON.stringify({ image: sampleDataUrl, preset: 'site', fields }), 'application/json'),
			runAI
		);
		const payload = await response.json();
		assert.equal(payload.preset, 'site');
		assert.equal(calls[0].input.state, EXTRACT_PRESETS.site.state);
		assert.deepEqual(calls[0].input.fields, fields);
	});

	it('rejects an invalid inline Field Schema with HTTP 400 without calling runAI', async () => {
		const { calls, runAI } = recorder();
		const response = await handleExtract(
			post(JSON.stringify({ image: sampleDataUrl, fields: { n: { type: 'estimate' } } }), 'application/json'),
			runAI
		);
		assert.equal(response.status, 400);
		assert.match((await response.json()).error, /requires both "min" and "max"/);
		assert.equal(calls.length, 0);
	});

	it('rejects malformed JSON and non-object bodies', async () => {
		const { runAI } = recorder();
		const bad = await handleExtract(post('{', 'application/json'), runAI);
		assert.equal(bad.status, 400);
		assert.deepEqual(await bad.json(), { error: 'Invalid JSON request body.' });
		const arr = await handleExtract(post('[]', 'application/json'), runAI);
		assert.equal(arr.status, 400);
		assert.deepEqual(await arr.json(), { error: 'JSON request body must be an object.' });
	});

	it('returns HTTP 500 with the model error when inference fails', async () => {
		const { runAI } = recorder(new Error('AiError: 5006: bad input'));
		const response = await handleExtract(post(sampleImageBytes, 'image/jpeg'), runAI);
		assert.equal(response.status, 500);
		assert.deepEqual(await response.json(), {
			error: 'AiError: 5006: bad input',
			model: CLAIRIC_MODEL,
			preset: 'scene',
		});
	});

	it('tolerates a null or malformed model result', async () => {
		const { runAI } = recorder(null);
		const response = await handleExtract(post(sampleImageBytes, 'image/jpeg'), runAI);
		const payload = await response.json();
		assert.deepEqual(payload.answers, {});
		assert.equal(payload.truncated, false);
		assert.deepEqual(payload.usage, { input_tokens: 0, output_tokens: 0, image_tokens: 0, passes: 0 });
	});
});
