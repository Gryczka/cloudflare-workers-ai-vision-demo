/**
 * POST /api/decide — Structured multimodal decision endpoint.
 *
 * Accepts either:
 *   1. `application/json` with `{ image, state?, preset?, questions? }`
 *   2. Raw `image/*` bytes (`image/jpeg`, `image/png`, `image/webp`) with an
 *      optional `?preset=<key>` query parameter (any key of `PRESETS`).
 *
 * Evaluates the frame and state against typed questions (`noul`, `choice`,
 * `score`) in a single forward pass using `@cf/cloudflare/clef-flash` on
 * Workers AI, normalizing shorthand `null` option descriptions in `choice`
 * criteria into human-readable labels before calling the model.
 *
 * @see https://developers.cloudflare.com/workers-ai/models/clef-flash/
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
import { BIN_RULES, binPartsByItem, binQuestions } from '../../lib/bins.ts';
import { faceEmojiCriteria } from '../../lib/emoji-faces.ts';

// Server-render on every request (dynamic API endpoint).
export const prerender = false;

export const CLEF_FLASH_MODEL = '@cf/cloudflare/clef-flash';
export const CLEF_FLASH_SELECTOR = 'clef-flash';

export type BasePresetKey = 'webcam' | 'safety' | 'emoji' | 'bin';
export type PresetKey = BasePresetKey | 'custom';

export type NoulQuestion = {
	type: 'noul';
	instructions: string;
	criteria?: {
		true?: string;
		false?: string;
	};
};

export type ChoiceQuestion = {
	type: 'choice';
	instructions: string;
	criteria: Record<string, string | null>;
};

export type ScoreQuestion = {
	type: 'score';
	instructions: string;
	criteria: string[];
};

export type DecideQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type DecideQuestionMap = Record<string, DecideQuestion>;

export type DecidePreset = {
	label: string;
	state: string;
	questions: DecideQuestionMap;
	/**
	 * Optional big "hero" readout in the `/decide` view: shows the winning
	 * option of `question` large (its description's leading emoji, if any),
	 * or `gateMessage` when the `gate` noul question is below `gateMin`
	 * (default 0.5) or the winner is below `minPick` (default 0).
	 *
	 * With `parts`, the hero also lists, for the winning option, each part's
	 * answer: from a question (`id`) or a fixed rule (`fixed`). The view then
	 * shows only the gate, the pick, and those parts' question cards.
	 */
	hero?: {
		question: string;
		gate?: string;
		gateMessage?: string;
		gateMin?: number;
		minPick?: number;
		hideOptions?: string[];
		parts?: Record<string, { label: string; id?: string; fixed?: string }[]>;
		/** A checklist under the verdict, built from other answers (see `HeroCheck`). */
		checks?: HeroCheck[];
		/** A short line under the hero, e.g. the rule being applied. */
		note?: string;
	};
};

/**
 * One checklist line under the hero, read from another question's answer.
 *
 * - noul: passes when P(yes) ≥ 0.5 (or < 0.5 with `invert`).
 * - choice: passes when the winner is in `pass`; shows "—" when it is in `skip`.
 * - `requires`: a noul question that must be yes, else the line shows "—"
 *   (e.g. no hardhat check when nobody is in view).
 * - `hideWhenPass`: only show the line when it fails (e.g. "hazard nearby").
 * - `info`: not a pass/fail check; show "yes" / "no" (e.g. "person in view").
 */
export type HeroCheck = {
	id: string;
	icon: string;
	label: string;
	pass?: string[];
	skip?: string[];
	invert?: boolean;
	requires?: string;
	hideWhenPass?: boolean;
	info?: boolean;
};

/** Context for the Safety & Field preset: the site rule its levels are judged against. */
export const SAFETY_STATE =
	'Industrial field camera frame. Site rule: everyone in view must wear a hardhat and a high-visibility vest. No other PPE is required.';

/**
 * Built-in question presets for the `/decide` view and `POST /api/decide`.
 *
 * - `webcam`: matches `lucataco/clef-webcam`'s default questions (`gesture`,
 *   `vibe`, `holding_drink`), including `null` option descriptions that are
 *   normalized to human-readable labels before calling Workers AI.
 * - `safety`: site safety check against a stated rule (hardhat + hi-vis vest).
 *   The view shows a traffic-light verdict (🟢 / 🟡 / 🟠 / 🔴) with a
 *   checklist of what it saw.
 * - `emoji`: Clef Flash picks the emoji that best matches the most prominent
 *   face from 70 options (see `src/lib/emoji-faces.ts`).
 * - `bin`: Which Bin? Clef Flash identifies a held item and picks the bin for
 *   its main body and its lid or cap, in one call of four questions; other
 *   parts use fixed rules (see `src/lib/bins.ts`).
 *
 * Object order is the button order in the `/decide` preset bar.
 */
export const PRESETS: Record<BasePresetKey, DecidePreset> = {
	webcam: {
		label: 'Webcam & Gestures',
		state: 'Live webcam frame from a browser session.',
		questions: {
			gesture: {
				type: 'choice',
				instructions: 'Hand gesture?',
				criteria: {
					thumbs_up: null,
					peace_sign: null,
					waving: null,
					pointing: null,
					none: null,
				},
			},
			vibe: {
				type: 'choice',
				instructions: 'What is the person doing?',
				criteria: {
					locked_in: 'working at the screen',
					talking: null,
					on_phone: null,
					celebrating: null,
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
		},
	},
	safety: {
		label: 'Safety & Field',
		state: SAFETY_STATE,
		questions: {
			person_visible: {
				type: 'noul',
				instructions: 'Is at least one person visible in the frame?',
				criteria: {
					true: 'at least one person is visible',
					false: 'no person is visible',
				},
			},
			headwear: {
				type: 'choice',
				instructions: 'What headwear is the primary visible person wearing?',
				criteria: {
					hardhat: 'construction hardhat or safety helmet',
					baseball_cap: 'brimmed baseball cap',
					other_headwear: 'hood, beanie, or other soft cover',
					bare_head: 'no headwear',
					no_person: 'no person visible',
				},
			},
			high_visibility_vest: {
				type: 'noul',
				instructions: 'Is a high-visibility safety vest or reflective garment visible on a person?',
				criteria: {
					true: 'wearing high-visibility vest or reflective gear',
					false: 'no high-visibility vest visible',
				},
			},
			visible_hazard: {
				type: 'noul',
				instructions:
					'Is a person near a visible hazard, such as moving machinery, an unprotected edge, or a suspended load?',
				criteria: {
					true: 'a person is near a visible hazard',
					false: 'no visible hazard near a person',
				},
			},
			scene_risk: {
				type: 'score',
				instructions: 'Applying the site rule, which safety level fits this scene?',
				criteria: [
					'🟢 All clear: nobody in view, or everyone in view wears a hardhat and a high-visibility vest',
					'🟡 Check: can’t tell, because a head or torso is hidden or the person is too far away',
					'🟠 Violation: someone is missing a hardhat or a high-visibility vest',
					'🔴 Stop work: someone is missing both, or a person is near a visible hazard (moving machinery, an unprotected edge, a suspended load)',
				],
			},
		},
		hero: {
			question: 'scene_risk',
			checks: [
				{ id: 'person_visible', icon: '👷', label: 'Person in view', info: true },
				{ id: 'headwear', icon: '⛑️', label: 'Hardhat', pass: ['hardhat'], skip: ['no_person'], requires: 'person_visible' },
				{ id: 'high_visibility_vest', icon: '🦺', label: 'Hi-vis vest', requires: 'person_visible' },
				{ id: 'visible_hazard', icon: '⚠️', label: 'Hazard nearby', invert: true, hideWhenPass: true },
			],
			note: 'Site rule: hardhat and hi-vis vest required',
		},
	},
	emoji: {
		label: 'Emoji',
		state: 'Webcam frame. A person may be making a facial expression at the camera.',
		questions: {
			face_visible: {
				type: 'noul',
				instructions: 'Is a person’s face clearly visible and facing the camera?',
				criteria: { true: 'a face is clearly visible', false: 'no face is clearly visible' },
			},
			emoji: {
				type: 'choice',
				instructions: 'Which emoji best matches the facial expression or face gesture of the most prominent face?',
				criteria: faceEmojiCriteria(),
			},
		},
		hero: { question: 'emoji', gate: 'face_visible', gateMessage: 'No face in view. Step up and make a face.' },
	},
	bin: {
		label: 'Which Bin?',
		state: BIN_RULES,
		questions: binQuestions(),
		hero: {
			question: 'item',
			gate: 'item_shown',
			gateMessage: 'Hold up something you’d throw away.',
			// Live (one call, all questions): "item shown?" scored 83–89% on items and 4% on an
			// empty frame. A soda can was the clear pick at only 48% (next best 15%), so the
			// pick needs 30%, not 50%.
			gateMin: 0.25,
			minPick: 0.3,
			hideOptions: ['nothing'],
			parts: binPartsByItem(),
		},
	},
};

const DEFAULT_PRESET: BasePresetKey = 'webcam';

function asBasePresetKey(value: unknown): BasePresetKey | null {
	return typeof value === 'string' && Object.hasOwn(PRESETS, value) ? (value as BasePresetKey) : null;
}

const QUESTION_ID_PATTERN = /^[a-zA-Z0-9_.-]{1,100}$/;

/**
 * Convert an option key like `thumbs_up` or `peace-sign` into a clean
 * human-readable description (`thumbs up`, `peace sign`).
 */
export function humanizeOptionKey(key: string): string {
	const cleaned = key.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
	return cleaned || key;
}

/**
 * Validate and normalize a map of typed Clef questions.
 *
 * Ensures 1..64 questions, valid question IDs, supported question types
 * (`noul`, `choice`, `score`), and normalizes `null` or empty `choice` option
 * descriptions into human-readable labels derived from the option key.
 */
export function normalizeQuestions(rawQuestions: unknown):
	| { ok: true; questions: Record<string, DecideQuestion> }
	| { ok: false; error: string } {
	if (!isPlainObject(rawQuestions)) {
		return { ok: false, error: '`questions` must be a non-empty JSON object.' };
	}

	const entries = Object.entries(rawQuestions);
	if (entries.length < 1 || entries.length > 64) {
		return {
			ok: false,
			error: '`questions` must contain between 1 and 64 questions.',
		};
	}

	const normalized: Record<string, DecideQuestion> = {};

	for (const [id, rawQuestion] of entries) {
		if (!QUESTION_ID_PATTERN.test(id)) {
			return {
				ok: false,
				error: `Invalid question ID "${id}". Use 1-100 letters, digits, '_', '.', or '-'.`,
			};
		}

		if (!isPlainObject(rawQuestion)) {
			return {
				ok: false,
				error: `Question "${id}" must be an object.`,
			};
		}

		const type = rawQuestion.type;
		if (type !== 'noul' && type !== 'choice' && type !== 'score') {
			return {
				ok: false,
				error: `Question "${id}" has unsupported type "${String(type)}". Expected "noul", "choice", or "score".`,
			};
		}

		const instructions =
			typeof rawQuestion.instructions === 'string' ? rawQuestion.instructions.trim() : '';
		if (!instructions) {
			return {
				ok: false,
				error: `Question "${id}" requires a non-empty "instructions" string.`,
			};
		}

		if (type === 'noul') {
			const question: NoulQuestion = {
				type: 'noul',
				instructions,
			};
			if (rawQuestion.criteria !== undefined) {
				if (!isPlainObject(rawQuestion.criteria)) {
					return {
						ok: false,
						error: `Question "${id}" criteria must be an object when provided.`,
					};
				}
				const criteria: { true?: string; false?: string } = {};
				if (typeof rawQuestion.criteria.true === 'string' && rawQuestion.criteria.true.trim()) {
					criteria.true = rawQuestion.criteria.true.trim();
				}
				if (typeof rawQuestion.criteria.false === 'string' && rawQuestion.criteria.false.trim()) {
					criteria.false = rawQuestion.criteria.false.trim();
				}
				if (Object.keys(criteria).length > 0) {
					question.criteria = criteria;
				}
			}
			normalized[id] = question;
			continue;
		}

		if (type === 'choice') {
			if (!isPlainObject(rawQuestion.criteria)) {
				return {
					ok: false,
					error: `Choice question "${id}" requires a "criteria" object with at least 2 options.`,
				};
			}
			const optionEntries = Object.entries(rawQuestion.criteria);
			if (optionEntries.length < 2 || optionEntries.length > 255) {
				return {
					ok: false,
					error: `Choice question "${id}" must define between 2 and 255 options in "criteria".`,
				};
			}

			const criteria: Record<string, string> = {};
			for (const [optionKey, rawDesc] of optionEntries) {
				const trimmedKey = optionKey.trim();
				if (!trimmedKey) {
					return {
						ok: false,
						error: `Choice question "${id}" contains an empty option key.`,
					};
				}
				if (rawDesc === null || rawDesc === undefined) {
					criteria[trimmedKey] = humanizeOptionKey(trimmedKey);
				} else if (typeof rawDesc === 'string') {
					const trimmedDesc = rawDesc.trim();
					criteria[trimmedKey] = trimmedDesc || humanizeOptionKey(trimmedKey);
				} else {
					return {
						ok: false,
						error: `Option "${trimmedKey}" in question "${id}" must have a string or null description.`,
					};
				}
			}

			normalized[id] = {
				type: 'choice',
				instructions,
				criteria,
			};
			continue;
		}

		if (!Array.isArray(rawQuestion.criteria)) {
			return {
				ok: false,
				error: `Score question "${id}" requires a "criteria" array of at least 2 levels.`,
			};
		}
		if (rawQuestion.criteria.length < 2 || rawQuestion.criteria.length > 10) {
			return {
				ok: false,
				error: `Score question "${id}" must define between 2 and 10 levels in "criteria".`,
			};
		}

		const scoreCriteria: string[] = [];
		for (let i = 0; i < rawQuestion.criteria.length; i += 1) {
			const item = rawQuestion.criteria[i];
			const text = typeof item === 'string' ? item.trim() : '';
			if (!text) {
				return {
					ok: false,
					error: `Score question "${id}" level ${i} must be a non-empty string.`,
				};
			}
			scoreCriteria.push(text);
		}

		normalized[id] = {
			type: 'score',
			instructions,
			criteria: scoreCriteria,
		};
	}

	return { ok: true, questions: normalized };
}

function resolvePresetKey(value: unknown, hasCustomQuestions = false): PresetKey {
	if (value === 'custom' || (hasCustomQuestions && !asBasePresetKey(value))) {
		return 'custom';
	}
	return resolveBasePresetKey(value);
}

function resolveBasePresetKey(value: unknown): BasePresetKey {
	return asBasePresetKey(value) ?? DEFAULT_PRESET;
}

/**
 * Handle a multimodal decision request.
 *
 * Accepts an injectable `runAI` runner (defaulting to the Workers AI binding)
 * so the full HTTP request-to-response contract can be tested offline.
 */
export async function handleDecide(
	{ request, url }: { request: Request; url?: URL },
	runAI: AIRunner = defaultRunAI
): Promise<Response> {
	const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
	const resolvedUrl = url ?? new URL(request.url);
	const queryPreset = resolvedUrl.searchParams.get('preset');

	let basePresetKey = resolveBasePresetKey(queryPreset);
	let presetKey: PresetKey = resolvePresetKey(queryPreset);
	let state = PRESETS[basePresetKey].state;
	let rawQuestions: unknown = PRESETS[basePresetKey].questions;
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
		const hasCustomQuestions = body.questions !== undefined;
		basePresetKey = resolveBasePresetKey(requestedPreset);
		presetKey = resolvePresetKey(requestedPreset, hasCustomQuestions);
		const preset = PRESETS[basePresetKey];
		state =
			typeof body.state === 'string' && body.state.trim()
				? body.state.trim()
				: preset.state;
		rawQuestions = hasCustomQuestions ? body.questions : preset.questions;
	} else if (contentType.startsWith('image/')) {
		const mediaType = contentType.split(';')[0].trim();
		const imageBuffer = await request.arrayBuffer();
		if (imageBuffer.byteLength === 0) {
			return json({ error: 'Image body is empty.' }, { status: 400 });
		}

		bytes = imageBuffer.byteLength;
		imageDataUrl = arrayBufferToDataUrl(imageBuffer, mediaType || 'image/jpeg');
		basePresetKey = resolveBasePresetKey(queryPreset);
		presetKey = basePresetKey;
		const preset = PRESETS[basePresetKey];
		state = preset.state;
		rawQuestions = preset.questions;
	} else {
		return json(
			{ error: 'Send an application/json or image/* request body.' },
			{ status: 415 }
		);
	}

	const validated = normalizeQuestions(rawQuestions);
	if (!validated.ok) {
		return json({ error: validated.error }, { status: 400 });
	}

	const started = Date.now();
	try {
		const rawResult = (await runAI(CLEF_FLASH_MODEL, {
			model: CLEF_FLASH_SELECTOR,
			state,
			images: [imageDataUrl],
			questions: validated.questions,
		})) as {
			model?: string;
			answers?: Record<string, unknown>;
			usage?: { input_tokens?: number; output_tokens?: number };
		} | null;

		const inferenceMs = Date.now() - started;
		const answers =
			rawResult && isPlainObject(rawResult.answers) ? rawResult.answers : {};
		const usage =
			rawResult && isPlainObject(rawResult.usage)
				? {
						input_tokens: Number(rawResult.usage.input_tokens ?? 0),
						output_tokens: Number(rawResult.usage.output_tokens ?? 0),
					}
				: { input_tokens: 0, output_tokens: 0 };

		return json({
			model: CLEF_FLASH_MODEL,
			preset: presetKey,
			state,
			questions: validated.questions,
			answers,
			usage,
			inferenceMs,
			bytes,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Decision model inference failed.';
		return json(
			{
				error: message,
				model: CLEF_FLASH_MODEL,
				preset: presetKey,
			},
			{ status: 500 }
		);
	}
}

export const POST: APIRoute = ({ request, url }) => handleDecide({ request, url });
