import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handlePPE } from '../pages/api/ppe.ts';

type RecordedCall = {
	model: string;
	input: unknown;
};

const sampleImageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const sampleImageBase64 = Buffer.from(sampleImageBytes).toString('base64');

describe('POST /api/ppe', () => {
	it('rejects unsupported Content-Type with HTTP 415 without calling runAI', async () => {
		const calls: RecordedCall[] = [];
		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return {};
		};

		const request = new Request('http://localhost/api/ppe', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ hello: 'world' }),
		});

		const response = await handlePPE({ request, url: new URL(request.url) }, runAI);

		assert.equal(response.status, 415);
		assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.deepEqual(await response.json(), { error: 'Send a raw image/* request body.' });
		assert.equal(calls.length, 0);
	});

	it('rejects empty image bodies with HTTP 400 without calling runAI', async () => {
		const calls: RecordedCall[] = [];
		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return {};
		};

		const request = new Request('http://localhost/api/ppe', {
			method: 'POST',
			headers: { 'content-type': 'image/jpeg' },
			body: new Uint8Array(0),
		});

		const response = await handlePPE({ request, url: new URL(request.url) }, runAI);

		assert.equal(response.status, 400);
		assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.deepEqual(await response.json(), { error: 'Image body is empty.' });
		assert.equal(calls.length, 0);
	});

	it('defaults to llama and hardhat, passes chat messages and data URL, and normalizes the assessment', async () => {
		const calls: RecordedCall[] = [];
		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return {
				response:
					'```json\n{"person_count": 2, "persons": [{"wearing_target": true, "location": "center"}, {"wearing_hardhat": false, "location": "left"}]}\n```',
			};
		};

		const request = new Request('http://localhost/api/ppe?model=unknown&target=unknown', {
			method: 'POST',
			headers: { 'content-type': 'image/jpeg' },
			body: sampleImageBytes,
		});

		const response = await handlePPE({ request }, runAI);

		assert.equal(response.status, 200);
		assert.equal(response.headers.get('cache-control'), 'no-store');

		const body = (await response.json()) as Record<string, unknown>;
		assert.equal(body.model, '@cf/meta/llama-3.2-11b-vision-instruct');
		assert.equal(body.modelKey, 'llama');
		assert.equal(body.targetKey, 'hardhat');
		assert.equal(body.target, 'hardhat');
		assert.equal(body.bytes, sampleImageBytes.byteLength);
		assert.equal(typeof body.inferenceMs, 'number');
		assert.deepEqual(body.assessment, {
			person_count: 2,
			persons: [
				{ wearing_target: true, location: 'center' },
				{ wearing_target: false, location: 'left' },
			],
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0].model, '@cf/meta/llama-3.2-11b-vision-instruct');
		const input = calls[0].input as {
			messages: Array<{ role: string; content: string }>;
			image: string;
		};
		assert.equal(input.image, `data:image/jpeg;base64,${sampleImageBase64}`);
		assert.equal(input.messages.length, 2);
		assert.equal(input.messages[0].role, 'system');
		assert.match(input.messages[1].content, /a hardhat or safety helmet/);
	});

	it('auto-accepts the llama license agreement once and retries the original request', async () => {
		const calls: RecordedCall[] = [];
		let attempt = 0;
		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			attempt += 1;
			if (attempt === 1) {
				throw new Error('Prior to using this model, you must agree to the acceptable use policy and license.');
			}
			if (attempt === 2) {
				return { response: 'Thank you for agreeing.' };
			}
			return {
				response: '{"person_count":1,"persons":[{"wearing_target":true,"location":"foreground"}]}',
			};
		};

		const request = new Request('http://localhost/api/ppe?model=llama&target=hardhat', {
			method: 'POST',
			headers: { 'content-type': 'image/jpeg' },
			body: sampleImageBytes,
		});

		const response = await handlePPE({ request }, runAI);

		assert.equal(response.status, 200);
		const body = (await response.json()) as Record<string, unknown>;
		assert.deepEqual(body.assessment, {
			person_count: 1,
			persons: [{ wearing_target: true, location: 'foreground' }],
		});

		assert.equal(calls.length, 3);
		assert.equal(calls[0].model, '@cf/meta/llama-3.2-11b-vision-instruct');
		assert.deepEqual(calls[1], {
			model: '@cf/meta/llama-3.2-11b-vision-instruct',
			input: { prompt: 'agree' },
		});
		assert.deepEqual(calls[2], calls[0]);
	});

	it('invokes llava with byte-array image, combined prompt, and max_tokens, and extracts description', async () => {
		const calls: RecordedCall[] = [];
		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return {
				description: '{"person_count":1,"persons":[{"wearing_target":false,"location":"right"}]}',
			};
		};

		const request = new Request('http://localhost/api/ppe?model=llava&target=baseball-cap', {
			method: 'POST',
			headers: { 'content-type': 'image/png' },
			body: sampleImageBytes,
		});

		const response = await handlePPE({ request }, runAI);

		assert.equal(response.status, 200);
		const body = (await response.json()) as Record<string, unknown>;
		assert.equal(body.model, '@cf/llava-hf/llava-1.5-7b-hf');
		assert.equal(body.modelKey, 'llava');
		assert.equal(body.targetKey, 'baseball-cap');
		assert.equal(body.target, 'baseball cap');
		assert.deepEqual(body.assessment, {
			person_count: 1,
			persons: [{ wearing_target: false, location: 'right' }],
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0].model, '@cf/llava-hf/llava-1.5-7b-hf');
		const input = calls[0].input as {
			image: number[];
			prompt: string;
			max_tokens: number;
		};
		assert.deepEqual(input.image, [...sampleImageBytes]);
		assert.equal(input.max_tokens, 512);
		assert.match(input.prompt, /a baseball cap/);
	});

	it('invokes gemma with chat messages and data URL, and extracts OpenAI-style choices content', async () => {
		const calls: RecordedCall[] = [];
		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return {
				choices: [
					{
						message: {
							content: '{"person_count":0,"persons":[]}',
						},
					},
				],
			};
		};

		const request = new Request('http://localhost/api/ppe?model=gemma&target=baseball-cap', {
			method: 'POST',
			headers: { 'content-type': 'image/jpeg' },
			body: sampleImageBytes,
		});

		const response = await handlePPE({ request }, runAI);

		assert.equal(response.status, 200);
		const body = (await response.json()) as Record<string, unknown>;
		assert.equal(body.model, '@cf/google/gemma-4-26b-a4b-it');
		assert.equal(body.modelKey, 'gemma');
		assert.equal(body.targetKey, 'baseball-cap');
		assert.equal(body.target, 'baseball cap');
		assert.equal(body.raw, '{"person_count":0,"persons":[]}');
		assert.deepEqual(body.assessment, {
			person_count: 0,
			persons: [],
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0].model, '@cf/google/gemma-4-26b-a4b-it');
		const input = calls[0].input as {
			messages: Array<{ role: string; content: string }>;
			image: string;
		};
		assert.equal(input.image, `data:image/jpeg;base64,${sampleImageBase64}`);
		assert.equal(input.messages.length, 2);
		assert.match(input.messages[1].content, /a baseball cap/);
	});

	it('handles large multi-chunk images and surfaces non-license upstream errors as HTTP 500', async () => {
		const largeBytes = new Uint8Array(20000);
		for (let i = 0; i < largeBytes.length; i += 1) {
			largeBytes[i] = i % 251;
		}
		const expectedDataUrl = `data:image/jpeg;base64,${Buffer.from(largeBytes).toString('base64')}`;

		let seenImage = '';
		const runAI = async (_model: string, input: unknown) => {
			seenImage = (input as { image: string }).image;
			throw new Error('Upstream Workers AI timeout');
		};

		const request = new Request('http://localhost/api/ppe?model=llama&target=hardhat', {
			method: 'POST',
			headers: { 'content-type': 'image/jpeg' },
			body: largeBytes,
		});

		const response = await handlePPE({ request }, runAI);

		assert.equal(seenImage, expectedDataUrl);
		assert.equal(response.status, 500);
		assert.deepEqual(await response.json(), {
			error: 'Upstream Workers AI timeout',
			model: '@cf/meta/llama-3.2-11b-vision-instruct',
			modelKey: 'llama',
			targetKey: 'hardhat',
		});
	});

	it('invokes clef-flash for hardhat compliance and synthesizes a zero-person assessment', async () => {
		const calls: RecordedCall[] = [];
		const clefResponse = {
			model: 'clef-flash',
			answers: {
				person_count: {
					type: 'choice',
					choice: '0',
					confidence: 0.99,
					probabilities: { '0': 0.99, '1': 0.01, '2': 0, '3+': 0 },
				},
				all_wearing_target: { type: 'noul', noul: 0.02 },
				any_wearing_target: { type: 'noul', noul: 0.01 },
				primary_location: {
					type: 'choice',
					choice: 'none',
					confidence: 0.99,
					probabilities: { left: 0, center: 0, right: 0, background: 0, none: 0.99 },
				},
			},
			usage: { input_tokens: 245, output_tokens: 0 },
		};

		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return clefResponse;
		};

		const request = new Request('http://localhost/api/ppe?model=clef-flash&target=hardhat', {
			method: 'POST',
			headers: { 'content-type': 'image/jpeg' },
			body: sampleImageBytes,
		});

		const response = await handlePPE({ request }, runAI);

		assert.equal(response.status, 200);
		assert.equal(response.headers.get('cache-control'), 'no-store');
		const body = (await response.json()) as Record<string, unknown>;
		assert.equal(body.model, '@cf/cloudflare/clef-flash');
		assert.equal(body.modelKey, 'clef-flash');
		assert.equal(body.targetKey, 'hardhat');
		assert.equal(body.target, 'hardhat');
		assert.equal(body.bytes, sampleImageBytes.byteLength);
		assert.deepEqual(body.assessment, {
			person_count: 0,
			persons: [],
		});
		assert.deepEqual(JSON.parse(String(body.raw)), {
			answers: clefResponse.answers,
			usage: clefResponse.usage,
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0].model, '@cf/cloudflare/clef-flash');
		const input = calls[0].input as {
			model: string;
			state: string;
			images: string[];
			questions: Record<string, { type: string; instructions: string; criteria?: unknown }>;
		};
		assert.equal(input.model, 'clef-flash');
		assert.deepEqual(input.images, [`data:image/jpeg;base64,${sampleImageBase64}`]);
		assert.match(input.state, /hardhat compliance/);
		assert.equal(input.questions.person_count.type, 'choice');
		assert.equal(input.questions.all_wearing_target.type, 'noul');
		assert.match(input.questions.all_wearing_target.instructions, /a hardhat or safety helmet/);
		assert.equal(input.questions.any_wearing_target.type, 'noul');
		assert.equal(input.questions.primary_location.type, 'choice');
	});

	it('synthesizes compliant and non-compliant assessments from clef-flash answers across hardhat and baseball-cap targets', async () => {
		const scenarios = [
			{
				name: 'single compliant person wearing hardhat',
				target: 'hardhat',
				expectedTargetLabel: 'hardhat',
				expectedTargetPhrase: /a hardhat or safety helmet/,
				answers: {
					person_count: { type: 'choice', choice: '1', confidence: 0.96 },
					all_wearing_target: { type: 'noul', noul: 0.91 },
					any_wearing_target: { type: 'noul', noul: 0.94 },
					primary_location: { type: 'choice', choice: 'left', confidence: 0.88 },
				},
				expectedAssessment: {
					person_count: 1,
					persons: [{ wearing_target: true, location: 'left foreground' }],
				},
			},
			{
				name: 'two people with one missing baseball cap (partial compliance)',
				target: 'baseball-cap',
				expectedTargetLabel: 'baseball cap',
				expectedTargetPhrase: /a baseball cap/,
				answers: {
					person_count: { type: 'choice', choice: '2', confidence: 0.9 },
					all_wearing_target: { type: 'noul', noul: 0.12 },
					any_wearing_target: { type: 'noul', noul: 0.84 },
					primary_location: { type: 'choice', choice: 'center', confidence: 0.8 },
				},
				expectedAssessment: {
					person_count: 2,
					persons: [
						{ wearing_target: true, location: 'center foreground' },
						{ wearing_target: false, location: 'person 2' },
					],
				},
			},
			{
				name: 'three or more people all missing baseball cap',
				target: 'baseball-cap',
				expectedTargetLabel: 'baseball cap',
				expectedTargetPhrase: /a baseball cap/,
				answers: {
					person_count: { type: 'choice', choice: '3+', confidence: 0.85 },
					all_wearing_target: { type: 'noul', noul: 0.04 },
					any_wearing_target: { type: 'noul', noul: 0.08 },
					primary_location: { type: 'choice', choice: 'right', confidence: 0.77 },
				},
				expectedAssessment: {
					person_count: 3,
					persons: [
						{ wearing_target: false, location: 'right foreground' },
						{ wearing_target: false, location: 'person 2' },
						{ wearing_target: false, location: 'person 3' },
					],
				},
			},
		];

		for (const scenario of scenarios) {
			const calls: RecordedCall[] = [];
			const usage = { input_tokens: 312, output_tokens: 0 };
			const runAI = async (model: string, input: unknown) => {
				calls.push({ model, input });
				return {
					model: 'clef-flash',
					answers: scenario.answers,
					usage,
				};
			};

			const request = new Request(
				`http://localhost/api/ppe?model=clef-flash&target=${scenario.target}`,
				{
					method: 'POST',
					headers: { 'content-type': 'image/webp' },
					body: sampleImageBytes,
				}
			);

			const response = await handlePPE({ request }, runAI);
			assert.equal(response.status, 200, scenario.name);

			const body = (await response.json()) as Record<string, unknown>;
			assert.equal(body.model, '@cf/cloudflare/clef-flash', scenario.name);
			assert.equal(body.modelKey, 'clef-flash', scenario.name);
			assert.equal(body.targetKey, scenario.target, scenario.name);
			assert.equal(body.target, scenario.expectedTargetLabel, scenario.name);
			assert.deepEqual(body.assessment, scenario.expectedAssessment, scenario.name);
			assert.equal(
				body.raw,
				JSON.stringify({ answers: scenario.answers, usage }, null, 2),
				scenario.name
			);

			assert.equal(calls.length, 1, scenario.name);
			const input = calls[0].input as {
				model: string;
				state: string;
				images: string[];
				questions: Record<string, { instructions: string }>;
			};
			assert.equal(input.model, 'clef-flash', scenario.name);
			assert.deepEqual(
				input.images,
				[`data:image/webp;base64,${sampleImageBase64}`],
				scenario.name
			);
			assert.match(
				input.questions.all_wearing_target.instructions,
				scenario.expectedTargetPhrase,
				scenario.name
			);
		}
	});

	it('surfaces upstream clef-flash errors as HTTP 500 with clef model metadata', async () => {
		const runAI = async () => {
			throw new Error('Clef Flash worker capacity exceeded');
		};

		const request = new Request('http://localhost/api/ppe?model=clef-flash&target=baseball-cap', {
			method: 'POST',
			headers: { 'content-type': 'image/jpeg' },
			body: sampleImageBytes,
		});

		const response = await handlePPE({ request }, runAI);

		assert.equal(response.status, 500);
		assert.deepEqual(await response.json(), {
			error: 'Clef Flash worker capacity exceeded',
			model: '@cf/cloudflare/clef-flash',
			modelKey: 'clef-flash',
			targetKey: 'baseball-cap',
		});
	});
});
