import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleDecide, PRESETS } from '../pages/api/decide.ts';

type RecordedCall = {
	model: string;
	input: unknown;
};

const sampleImageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const sampleImageBase64 = Buffer.from(sampleImageBytes).toString('base64');
const sampleDataUrl = `data:image/jpeg;base64,${sampleImageBase64}`;

describe('POST /api/decide', () => {
	it('rejects unsupported Content-Type with HTTP 415 without calling runAI', async () => {
		const calls: RecordedCall[] = [];
		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return {};
		};

		const request = new Request('http://localhost/api/decide', {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: 'hello',
		});

		const response = await handleDecide({ request, url: new URL(request.url) }, runAI);

		assert.equal(response.status, 415);
		assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.deepEqual(await response.json(), {
			error: 'Send an application/json or image/* request body.',
		});
		assert.equal(calls.length, 0);
	});

	it('rejects empty raw image/* bodies with HTTP 400 without calling runAI', async () => {
		const calls: RecordedCall[] = [];
		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return {};
		};

		const request = new Request('http://localhost/api/decide', {
			method: 'POST',
			headers: { 'content-type': 'image/jpeg' },
			body: new Uint8Array(0),
		});

		const response = await handleDecide({ request, url: new URL(request.url) }, runAI);

		assert.equal(response.status, 400);
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.deepEqual(await response.json(), { error: 'Image body is empty.' });
		assert.equal(calls.length, 0);
	});

	it('rejects empty or missing image in application/json bodies with HTTP 400 without calling runAI', async () => {
		const calls: RecordedCall[] = [];
		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return {};
		};

		const request = new Request('http://localhost/api/decide', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ image: '   ', preset: 'webcam' }),
		});

		const response = await handleDecide({ request, url: new URL(request.url) }, runAI);

		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: 'Image body is empty.' });
		assert.equal(calls.length, 0);
	});

	it('accepts raw image/jpeg with default webcam preset, normalizes null choice criteria, and returns answers and usage', async () => {
		const calls: RecordedCall[] = [];
		const mockAnswers = {
			gesture: {
				type: 'choice',
				choice: 'thumbs_up',
				probabilities: {
					thumbs_up: 0.82,
					peace_sign: 0.05,
					waving: 0.04,
					pointing: 0.03,
					none: 0.06,
				},
				confidence: 0.78,
			},
			vibe: {
				type: 'choice',
				choice: 'locked_in',
				probabilities: {
					locked_in: 0.74,
					talking: 0.1,
					on_phone: 0.04,
					celebrating: 0.08,
					away: 0.04,
				},
				confidence: 0.69,
			},
			holding_drink: {
				type: 'noul',
				noul: 0.12,
			},
		};
		const mockUsage = { input_tokens: 312, output_tokens: 0 };

		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return {
				model: 'clef-flash',
				answers: mockAnswers,
				usage: mockUsage,
			};
		};

		const request = new Request('http://localhost/api/decide', {
			method: 'POST',
			headers: { 'content-type': 'image/jpeg' },
			body: sampleImageBytes,
		});

		const response = await handleDecide({ request }, runAI);

		assert.equal(response.status, 200);
		assert.equal(response.headers.get('cache-control'), 'no-store');

		const body = (await response.json()) as Record<string, unknown>;
		assert.equal(body.model, '@cf/cloudflare/clef-flash');
		assert.equal(body.preset, 'webcam');
		assert.equal(body.state, 'Live webcam frame from a browser session.');
		assert.equal(body.bytes, sampleImageBytes.byteLength);
		assert.equal(typeof body.inferenceMs, 'number');
		assert.deepEqual(body.answers, mockAnswers);
		assert.deepEqual(body.usage, mockUsage);

		const expectedQuestions = {
			gesture: {
				type: 'choice',
				instructions: 'Hand gesture?',
				criteria: {
					thumbs_up: 'thumbs up',
					peace_sign: 'peace sign',
					waving: 'waving',
					pointing: 'pointing',
					none: 'none',
				},
			},
			vibe: {
				type: 'choice',
				instructions: 'What is the person doing?',
				criteria: {
					locked_in: 'working at the screen',
					talking: 'talking',
					on_phone: 'on phone',
					celebrating: 'celebrating',
					away: 'no person visible',
				},
			},
			holding_drink: {
				type: 'noul',
				instructions: 'Holding a cup or drink?',
				criteria: {
					true: 'yes',
					false: 'no',
				},
			},
		};
		assert.deepEqual(body.questions, expectedQuestions);

		assert.equal(calls.length, 1);
		assert.equal(calls[0].model, '@cf/cloudflare/clef-flash');
		assert.deepEqual(calls[0].input, {
			model: 'clef-flash',
			state: 'Live webcam frame from a browser session.',
			images: [sampleDataUrl],
			questions: expectedQuestions,
		});
	});

	it('accepts raw image/png with ?preset=safety and evaluates noul, choice, and score questions', async () => {
		const calls: RecordedCall[] = [];
		const mockAnswers = {
			person_visible: { type: 'noul', noul: 0.96 },
			headwear: {
				type: 'choice',
				choice: 'bare_head',
				probabilities: {
					hardhat: 0.04,
					baseball_cap: 0.08,
					other_headwear: 0.05,
					bare_head: 0.81,
					no_person: 0.02,
				},
				confidence: 0.77,
			},
			high_visibility_vest: { type: 'noul', noul: 0.88 },
			scene_risk: {
				type: 'score',
				score: 1.92,
				legend: {
					'0': 'Clear (no people or fully compliant)',
					'1': 'Low (minor or ambiguous PPE gap)',
					'2': 'Medium (person missing required headwear)',
					'3': 'High (multiple PPE violations or active hazard)',
				},
				probabilities: { '0': 0.02, '1': 0.12, '2': 0.78, '3': 0.08 },
				confidence: 0.73,
			},
		};

		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return {
				model: 'clef-flash',
				answers: mockAnswers,
				usage: { input_tokens: 410, output_tokens: 0 },
			};
		};

		const request = new Request('http://localhost/api/decide?preset=safety', {
			method: 'POST',
			headers: { 'content-type': 'image/png' },
			body: sampleImageBytes,
		});

		const response = await handleDecide({ request }, runAI);

		assert.equal(response.status, 200);
		const body = (await response.json()) as Record<string, unknown>;
		assert.equal(body.model, '@cf/cloudflare/clef-flash');
		assert.equal(body.preset, 'safety');
		assert.equal(body.state, PRESETS.safety.state);
		assert.deepEqual(body.answers, mockAnswers);
		assert.deepEqual(body.usage, { input_tokens: 410, output_tokens: 0 });

		assert.equal(calls.length, 1);
		assert.equal(calls[0].model, '@cf/cloudflare/clef-flash');
		const input = calls[0].input as {
			model: string;
			state: string;
			images: string[];
			questions: Record<string, unknown>;
		};
		assert.equal(input.model, 'clef-flash');
		assert.deepEqual(input.images, [`data:image/png;base64,${sampleImageBase64}`]);
		assert.deepEqual(Object.keys(input.questions), [
			'person_visible',
			'headwear',
			'high_visibility_vest',
			'visible_hazard',
			'scene_risk',
		]);
	});

	it('accepts application/json with image, state, preset, and normalizes null choice criteria descriptions', async () => {
		const calls: RecordedCall[] = [];
		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return {
				model: 'clef-flash',
				answers: {
					posture: {
						type: 'choice',
						choice: 'standing_up',
						probabilities: { standing_up: 0.7, sitting_down: 0.3 },
						confidence: 0.4,
					},
				},
				usage: { input_tokens: 256, output_tokens: 0 },
			};
		};

		const request = new Request('http://localhost/api/decide', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				image: sampleImageBase64,
				state: 'Custom operator check.',
				preset: 'safety',
				questions: {
					posture: {
						type: 'choice',
						instructions: 'What posture is the person in?',
						criteria: {
							standing_up: null,
							sitting_down: '',
						},
					},
				},
			}),
		});

		const response = await handleDecide({ request }, runAI);

		assert.equal(response.status, 200);
		const body = (await response.json()) as Record<string, unknown>;
		assert.equal(body.model, '@cf/cloudflare/clef-flash');
		assert.equal(body.preset, 'safety');
		assert.equal(body.state, 'Custom operator check.');
		assert.equal(body.bytes, sampleImageBytes.byteLength);
		assert.deepEqual(body.questions, {
			posture: {
				type: 'choice',
				instructions: 'What posture is the person in?',
				criteria: {
					standing_up: 'standing up',
					sitting_down: 'sitting down',
				},
			},
		});

		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], {
			model: '@cf/cloudflare/clef-flash',
			input: {
				model: 'clef-flash',
				state: 'Custom operator check.',
				images: [sampleDataUrl],
				questions: {
					posture: {
						type: 'choice',
						instructions: 'What posture is the person in?',
						criteria: {
							standing_up: 'standing up',
							sitting_down: 'sitting down',
						},
					},
				},
			},
		});
	});

	it('falls back to the selected preset questions when application/json omits questions', async () => {
		const calls: RecordedCall[] = [];
		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return {
				model: 'clef-flash',
				answers: {},
				usage: { input_tokens: 280, output_tokens: 0 },
			};
		};

		const request = new Request('http://localhost/api/decide', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				image: sampleDataUrl,
				preset: 'safety',
			}),
		});

		const response = await handleDecide({ request }, runAI);

		assert.equal(response.status, 200);
		const body = (await response.json()) as Record<string, unknown>;
		assert.equal(body.preset, 'safety');
		assert.equal(body.state, PRESETS.safety.state);
		assert.equal(calls.length, 1);
		const input = calls[0].input as { questions: Record<string, unknown> };
		assert.deepEqual(Object.keys(input.questions), [
			'person_visible',
			'headwear',
			'high_visibility_vest',
			'visible_hazard',
			'scene_risk',
		]);
	});

	it('accepts application/json with custom noul, choice, and score questions and forwards validated payload to runAI', async () => {
		const calls: RecordedCall[] = [];
		const mockAnswers = {
			is_outdoor: { type: 'noul', noul: 0.91 },
			lighting: {
				type: 'choice',
				choice: 'daylight',
				probabilities: { daylight: 0.85, indoor_lamp: 0.15 },
				confidence: 0.7,
			},
			clarity: {
				type: 'score',
				score: 1.8,
				legend: { '0': 'Blurry', '1': 'Acceptable', '2': 'Sharp' },
				probabilities: { '0': 0.05, '1': 0.1, '2': 0.85 },
				confidence: 0.8,
			},
		};

		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return {
				model: 'clef-flash',
				answers: mockAnswers,
				usage: { input_tokens: 340, output_tokens: 0 },
			};
		};

		const customQuestions = {
			is_outdoor: {
				type: 'noul',
				instructions: 'Is this scene outdoors?',
				criteria: { true: 'outdoors', false: 'indoors' },
			},
			lighting: {
				type: 'choice',
				instructions: 'What is the primary lighting source?',
				criteria: { daylight: 'natural daylight', indoor_lamp: null },
			},
			clarity: {
				type: 'score',
				instructions: 'Rate the image sharpness.',
				criteria: ['Blurry', 'Acceptable', 'Sharp'],
			},
		};

		const request = new Request('http://localhost/api/decide', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				image: sampleDataUrl,
				state: 'Custom multi-type inspection.',
				questions: customQuestions,
			}),
		});

		const response = await handleDecide({ request }, runAI);

		assert.equal(response.status, 200);
		const body = (await response.json()) as Record<string, unknown>;
		assert.equal(body.model, '@cf/cloudflare/clef-flash');
		assert.equal(body.preset, 'custom');
		assert.equal(body.state, 'Custom multi-type inspection.');
		assert.deepEqual(body.answers, mockAnswers);

		const expectedQuestions = {
			is_outdoor: {
				type: 'noul',
				instructions: 'Is this scene outdoors?',
				criteria: { true: 'outdoors', false: 'indoors' },
			},
			lighting: {
				type: 'choice',
				instructions: 'What is the primary lighting source?',
				criteria: { daylight: 'natural daylight', indoor_lamp: 'indoor lamp' },
			},
			clarity: {
				type: 'score',
				instructions: 'Rate the image sharpness.',
				criteria: ['Blurry', 'Acceptable', 'Sharp'],
			},
		};
		assert.deepEqual(body.questions, expectedQuestions);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], {
			model: '@cf/cloudflare/clef-flash',
			input: {
				model: 'clef-flash',
				state: 'Custom multi-type inspection.',
				images: [sampleDataUrl],
				questions: expectedQuestions,
			},
		});
	});

	it('rejects invalid questions payloads with HTTP 400 and a descriptive error without calling runAI', async () => {
		const tooManyQuestions: Record<string, unknown> = {};
		for (let i = 1; i <= 65; i += 1) {
			tooManyQuestions[`q_${i}`] = {
				type: 'noul',
				instructions: `Question ${i}?`,
			};
		}

		const invalidCases: Array<{
			name: string;
			questions: unknown;
			expectedPattern: RegExp;
		}> = [
			{
				name: '0 questions (empty object)',
				questions: {},
				expectedPattern: /between 1 and 64 questions/i,
			},
			{
				name: 'non-object questions (array)',
				questions: [],
				expectedPattern: /non-empty JSON object/i,
			},
			{
				name: '>64 questions',
				questions: tooManyQuestions,
				expectedPattern: /between 1 and 64 questions/i,
			},
			{
				name: 'invalid question ID characters',
				questions: {
					'bad id!': {
						type: 'noul',
						instructions: 'Is it valid?',
					},
				},
				expectedPattern: /Invalid question ID "bad id!"/i,
			},
			{
				name: 'question ID exceeding 100 characters',
				questions: {
					['a'.repeat(101)]: {
						type: 'noul',
						instructions: 'Too long ID?',
					},
				},
				expectedPattern: /Invalid question ID/i,
			},
			{
				name: 'unsupported question type',
				questions: {
					bad_type: {
						type: 'freeform',
						instructions: 'Describe the scene.',
					},
				},
				expectedPattern: /unsupported type "freeform"/i,
			},
			{
				name: 'missing instructions string',
				questions: {
					no_instructions: {
						type: 'noul',
						instructions: '   ',
					},
				},
				expectedPattern: /requires a non-empty "instructions" string/i,
			},
			{
				name: 'choice with fewer than 2 options',
				questions: {
					single_choice: {
						type: 'choice',
						instructions: 'Only one option?',
						criteria: {
							only_one: 'just one',
						},
					},
				},
				expectedPattern: /between 2 and 255 options/i,
			},
			{
				name: 'choice with non-object criteria',
				questions: {
					bad_choice_criteria: {
						type: 'choice',
						instructions: 'Array criteria for choice?',
						criteria: ['a', 'b'],
					},
				},
				expectedPattern: /requires a "criteria" object with at least 2 options/i,
			},
			{
				name: 'score with fewer than 2 criteria strings',
				questions: {
					single_score: {
						type: 'score',
						instructions: 'Rate with 1 level.',
						criteria: ['Only one level'],
					},
				},
				expectedPattern: /between 2 and 10 levels/i,
			},
			{
				name: 'score with empty string in criteria',
				questions: {
					empty_score_level: {
						type: 'score',
						instructions: 'Rate with blank level.',
						criteria: ['Low', '   '],
					},
				},
				expectedPattern: /level 1 must be a non-empty string/i,
			},
			{
				name: 'score with non-array criteria',
				questions: {
					bad_score_criteria: {
						type: 'score',
						instructions: 'Rate with object criteria.',
						criteria: { low: 'Low', high: 'High' },
					},
				},
				expectedPattern: /requires a "criteria" array of at least 2 levels/i,
			},
		];

		for (const testCase of invalidCases) {
			const calls: RecordedCall[] = [];
			const runAI = async (model: string, input: unknown) => {
				calls.push({ model, input });
				return {};
			};

			const request = new Request('http://localhost/api/decide', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					image: sampleDataUrl,
					questions: testCase.questions,
				}),
			});

			const response = await handleDecide({ request }, runAI);
			assert.equal(response.status, 400, `Expected HTTP 400 for case: ${testCase.name}`);
			assert.equal(response.headers.get('cache-control'), 'no-store');
			const payload = (await response.json()) as { error?: string };
			assert.equal(typeof payload.error, 'string', `Expected error string for case: ${testCase.name}`);
			assert.match(
				payload.error ?? '',
				testCase.expectedPattern,
				`Unexpected error message for case: ${testCase.name}`
			);
			assert.equal(calls.length, 0, `Expected runAI not to be called for case: ${testCase.name}`);
		}
	});

	it('surfaces upstream Workers AI errors as HTTP 500 with structured JSON', async () => {
		const runAI = async () => {
			throw new Error('Upstream Clef Flash service unavailable');
		};

		const request = new Request('http://localhost/api/decide?preset=webcam', {
			method: 'POST',
			headers: { 'content-type': 'image/jpeg' },
			body: sampleImageBytes,
		});

		const response = await handleDecide({ request }, runAI);

		assert.equal(response.status, 500);
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.deepEqual(await response.json(), {
			error: 'Upstream Clef Flash service unavailable',
			model: '@cf/cloudflare/clef-flash',
			preset: 'webcam',
		});
	});
});

describe('Decide emoji preset', () => {
	it('is a valid schema with 70 emoji options whose descriptions lead with the emoji', async () => {
		const { FACE_EMOJI } = await import('../lib/emoji-faces.ts');
		const { PRESETS, normalizeQuestions } = await import('../pages/api/decide.ts');
		const result = normalizeQuestions(PRESETS.emoji.questions);
		assert.equal(result.ok, true, result.ok ? '' : result.error);
		const criteria = (PRESETS.emoji.questions.emoji as { criteria: Record<string, string> }).criteria;
		assert.equal(Object.keys(criteria).length, 70);
		for (const [key, [emoji, looks]] of Object.entries(FACE_EMOJI)) {
			assert.match(key, /^[a-z_]+$/);
			assert.equal(criteria[key], `${emoji} ${looks}`);
		}
		assert.equal(new Set(Object.values(FACE_EMOJI).map(([e]) => e)).size, 70);
		assert.deepEqual(PRESETS.emoji.hero, {
			question: 'emoji',
			gate: 'face_visible',
			gateMessage: 'No face in view. Step up and make a face.',
		});
	});

	it('runs ?preset=emoji in one Clef Flash call and falls back to webcam for unknown presets', async () => {
		const calls: RecordedCall[] = [];
		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return { answers: { emoji: { type: 'choice', choice: 'tears_of_joy', probabilities: { tears_of_joy: 0.6 }, confidence: 0.5 } } };
		};
		const send = (query: string) => {
			const request = new Request(`http://localhost/api/decide${query}`, {
				method: 'POST',
				headers: { 'content-type': 'image/jpeg' },
				body: sampleImageBytes,
			});
			return handleDecide({ request, url: new URL(request.url) }, runAI);
		};

		const response = await send('?preset=emoji');
		assert.equal(response.status, 200);
		assert.equal((await response.json()).preset, 'emoji');
		assert.equal(calls.length, 1);
		assert.deepEqual(Object.keys((calls[0].input as any).questions), ['face_visible', 'emoji']);

		const fallback = await send('?preset=constructor');
		assert.equal((await fallback.json()).preset, 'webcam');
		assert.deepEqual((calls[1].input as any).questions.gesture.type, 'choice');
	});
});

describe('Decide bin preset (Which Bin?)', () => {
	it('is one call of four questions; every option leads with an emoji', async () => {
		const { BIN_OPTIONS } = await import('../lib/bins.ts');
		const { PRESETS, normalizeQuestions } = await import('../pages/api/decide.ts');
		const result = normalizeQuestions(PRESETS.bin.questions);
		assert.equal(result.ok, true, result.ok ? '' : result.error);
		assert.deepEqual(Object.keys(PRESETS.bin.questions), ['item_shown', 'item', 'main_bin', 'lid_bin']);
		for (const id of ['main_bin', 'lid_bin']) {
			assert.deepEqual((PRESETS.bin.questions[id] as { criteria: Record<string, string> }).criteria, BIN_OPTIONS);
		}
		for (const text of Object.values(BIN_OPTIONS)) assert.match(text, /^\p{Extended_Pictographic}/u);
		const items = (PRESETS.bin.questions.item as { criteria: Record<string, string> }).criteria;
		for (const text of Object.values(items)) assert.match(text, /^\p{Extended_Pictographic}/u);
	});

	it('maps each item’s parts to the main or lid answer, or a fixed rule', async () => {
		const { BIN_OPTIONS } = await import('../lib/bins.ts');
		const { PRESETS } = await import('../pages/api/decide.ts');
		const hero = PRESETS.bin.hero!;
		assert.deepEqual(hero.parts!.coffee_cup, [
			{ label: 'lid', id: 'lid_bin' },
			{ label: 'cup', id: 'main_bin' },
			{ label: 'sleeve', fixed: BIN_OPTIONS.recycle },
		]);
		assert.deepEqual(hero.parts!.can, [{ label: 'can', id: 'main_bin' }]);
		assert.deepEqual(hero.parts!.nothing, []);
		for (const parts of Object.values(hero.parts!)) {
			for (const part of parts) assert.ok(part.id ? part.id in PRESETS.bin.questions : part.fixed, part.label);
		}
		assert.equal(hero.gate, 'item_shown');
		assert.equal(hero.gateMin, 0.25);
		assert.equal(hero.minPick, 0.3);
		assert.deepEqual(hero.hideOptions, ['nothing']);
	});

	it('runs ?preset=bin as a single Clef Flash call', async () => {
		const calls: RecordedCall[] = [];
		const runAI = async (model: string, input: unknown) => {
			calls.push({ model, input });
			return { answers: {} };
		};
		const request = new Request('http://localhost/api/decide?preset=bin', {
			method: 'POST',
			headers: { 'content-type': 'image/jpeg' },
			body: sampleImageBytes,
		});
		const response = await handleDecide({ request, url: new URL(request.url) }, runAI);
		assert.equal((await response.json()).preset, 'bin');
		assert.equal(calls.length, 1);
		assert.match((calls[0].input as any).state, /typical US curbside rules/);
	});
});

describe('Decide safety preset (Safety & Field)', () => {
	it('states the site rule and rates against traffic-light levels that name what you can see', async () => {
		const { normalizeQuestions } = await import('../pages/api/decide.ts');
		const safety = PRESETS.safety;
		assert.match(safety.state, /hardhat and a high-visibility vest/);
		assert.equal(normalizeQuestions(safety.questions).ok, true);
		const levels = (safety.questions.scene_risk as { criteria: string[] }).criteria;
		assert.deepEqual(
			levels.map((l) => l.split(':')[0]),
			['🟢 All clear', '🟡 Check', '🟠 Violation', '🔴 Stop work']
		);
		assert.match(levels[2], /missing a hardhat or a high-visibility vest/);
		assert.match(levels[3], /missing both, or a person is near a visible hazard/);
	});

	it('shows a verdict with a checklist drawn from the other answers', () => {
		const hero = PRESETS.safety.hero!;
		assert.equal(hero.question, 'scene_risk');
		assert.equal(hero.gate, undefined);
		assert.deepEqual(hero.checks!.map((c) => c.id), ['person_visible', 'headwear', 'high_visibility_vest', 'visible_hazard']);
		for (const check of hero.checks!) {
			assert.ok(check.id in PRESETS.safety.questions, check.id);
			if (check.requires) assert.ok(check.requires in PRESETS.safety.questions, check.requires);
		}
		assert.deepEqual(hero.checks!.find((c) => c.id === 'headwear')?.pass, ['hardhat']);
		assert.equal(hero.checks!.find((c) => c.id === 'person_visible')?.info, true);
		assert.match(hero.note ?? '', /hardhat and hi-vis vest required/);
	});
});
