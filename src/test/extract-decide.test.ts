import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeFields } from '../lib/field-schema.ts';
import {
	CLAIRIC_MODEL,
	CLEF_FLASH_MODEL,
	DEFAULT_RECIPE,
	DEFAULT_SETTINGS,
	FINGER_FIELDS,
	neckLoadKg,
	normalizeSettings,
	RECIPE_MENU,
	RECIPES,
	runRecipe,
	standardDrinks,
} from '../lib/extract-decide.ts';
import { normalizeQuestions } from '../pages/api/decide.ts';
import { handleExtractDecide } from '../pages/api/extract-decide.ts';

const image = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;

type Call = { model: string; input: any };

/** Fake runner: answers Clef Flash with `decide`, Clairic with `extract`. */
function fake(decide: Record<string, unknown>, extract: Record<string, unknown> = {}) {
	const calls: Call[] = [];
	const runAI = async (model: string, input: unknown) => {
		calls.push({ model, input });
		return {
			answers: model === CLEF_FLASH_MODEL ? decide : extract,
			usage: { input_tokens: model === CLEF_FLASH_MODEL ? 300 : 600, output_tokens: 0 },
		};
	};
	return { calls, runAI };
}

const noul = (p: number) => ({ type: 'noul', noul: p });
const choice = (probabilities: Record<string, number>) => {
	const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
	return { type: 'choice', choice, probabilities, confidence: 0.8 };
};
const est = (median: number, p10 = median, p90 = median) => ({ type: 'estimate', value: median, median, p10, p90 });
const val = (value: unknown) => ({ type: 'number', value, confidence: 0.9 });

describe('Extract + Decide recipes', () => {
	it('every Decide stage is a valid Question Schema and every Extract plan a valid Field Schema', () => {
		for (const [key, recipe] of Object.entries(RECIPES)) {
			const q = normalizeQuestions(recipe.questions);
			assert.equal(q.ok, true, `${key}: ${q.ok ? '' : q.error}`);
		}
		const decideAll = {
			hands_raised: noul(1),
			person_visible: noul(1),
			posture: choice({ slouching: 1 }),
			badge_visible: noul(1),
			timepiece: choice({ analog: 1 }),
			readable: noul(1),
		};
		for (const key of ['fingers', 'neck', 'watch'] as const) {
			const plan = RECIPES[key].plan(decideAll, DEFAULT_SETTINGS);
			assert.ok(!('skip' in plan), key);
			const f = normalizeFields(plan.fields);
			assert.equal(f.ok, true, `${key}: ${f.ok ? '' : f.error}`);
		}
		const digital = RECIPES.watch.plan({ ...decideAll, timepiece: choice({ digital: 1 }) }, DEFAULT_SETTINGS);
		assert.ok(!('skip' in digital) && normalizeFields(digital.fields).ok);
	});

	it('computes standard drinks: 355 ml of 5% beer is one US standard drink', () => {
		assert.equal(Number(standardDrinks(355, 5).toFixed(2)), 1.0);
	});

	it('lists exactly the remaining recipes, defaulting to Drink Check, with high-res capture for the watch', () => {
		assert.deepEqual(Object.keys(RECIPES), ['drink', 'fingers', 'neck', 'watch']);
		assert.deepEqual(RECIPE_MENU.map((r) => r.key), ['drink', 'fingers', 'neck', 'watch']);
		assert.equal(DEFAULT_RECIPE, 'drink');
		assert.deepEqual(RECIPE_MENU.find((r) => r.key === 'watch')?.capture, { width: 1280, height: 720 });
		assert.deepEqual(RECIPE_MENU.find((r) => r.key === 'drink')?.capture, { width: 640, height: 360 });
	});

	it('shows the water goal only on Drink Check', () => {
		for (const entry of RECIPE_MENU) {
			assert.deepEqual(entry.settings, entry.key === 'drink' ? ['hydrationGoalMl'] : [], entry.key);
		}
	});

	it('normalizes settings with safe defaults', () => {
		assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
		assert.deepEqual(normalizeSettings({ hydrationGoalMl: 3000 }), { hydrationGoalMl: 3000 });
		assert.deepEqual(normalizeSettings({ hydrationGoalMl: 99999, shutter: true }), DEFAULT_SETTINGS);
	});
});

describe('runRecipe: drink', () => {
	it('gates: no drink in view → Clairic is never called', async () => {
		const { calls, runAI } = fake({ drink_visible: noul(0.1), drink_type: choice({ none: 0.9 }), label_readable: noul(0) });
		const out = await runRecipe('drink', image, DEFAULT_SETTINGS, runAI);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].model, CLEF_FLASH_MODEL);
		assert.match(out.skipped ?? '', /No drink in view/);
		assert.equal(out.result, null);
		assert.equal(out.extract, null);
	});

	it('routes water to hydration and reports % of the daily goal', async () => {
		const { calls, runAI } = fake(
			{ drink_visible: noul(0.95), drink_type: choice({ water: 0.9, sparkling_water: 0.1 }), label_readable: noul(0.1) },
			{ capacity_ml: est(500, 450, 550), fill_pct: est(50, 40, 60) }
		);
		const out = await runRecipe('drink', image, { hydrationGoalMl: 2500 }, runAI);
		assert.deepEqual(calls.map((c) => c.model), [CLEF_FLASH_MODEL, CLAIRIC_MODEL]);
		assert.match(calls[1].input.state, /plain water/);
		assert.deepEqual(Object.keys(calls[1].input.fields), ['capacity_ml', 'fill_pct']);
		assert.equal(out.route?.key, 'hydration');
		assert.equal(out.result?.headline, '250 ml left');
		assert.match(out.result?.subline ?? '', /^10% of a 2\.5 L daily goal/);
	});

	it('weights caffeine by Clef Flash probabilities', async () => {
		const { runAI } = fake(
			{ drink_visible: noul(0.9), drink_type: choice({ coffee: 0.6, tea: 0.4 }), label_readable: noul(0.2) },
			{ capacity_ml: est(300), fill_pct: est(100) }
		);
		const out = await runRecipe('drink', image, DEFAULT_SETTINGS, runAI);
		// 300 ml × (0.6×0.4 + 0.4×0.2) mg/ml = 300 × 0.32 = 96 mg
		assert.equal(out.route?.key, 'caffeine');
		assert.equal(out.result?.headline, '~96 mg caffeine');
		assert.match(out.result?.subline ?? '', /coffee 60% · tea 40%/);
	});

	it('uses the label ABV when readable, and asks Clairic for it', async () => {
		const { calls, runAI } = fake(
			{ drink_visible: noul(0.9), drink_type: choice({ beer: 0.95 }), label_readable: noul(0.9) },
			{ capacity_ml: est(355), fill_pct: est(100), brand: { type: 'text', value: 'Hazy IPA' }, abv_pct: val(5) }
		);
		const out = await runRecipe('drink', image, DEFAULT_SETTINGS, runAI);
		assert.ok('abv_pct' in calls[1].input.fields);
		assert.equal(out.route?.key, 'alcohol');
		assert.equal(out.result?.headline, '1.0 standard drink');
		assert.match(out.result?.subline ?? '', /Hazy IPA · 5\.0% ABV \(from label\)/);
		assert.match(out.result?.note ?? '', /Not a measure of impairment/);
	});

	it('falls back to a typical ABV range without a label', async () => {
		const { calls, runAI } = fake(
			{ drink_visible: noul(0.9), drink_type: choice({ wine: 0.9 }), label_readable: noul(0.1) },
			{ capacity_ml: est(150), fill_pct: est(100) }
		);
		const out = await runRecipe('drink', image, DEFAULT_SETTINGS, runAI);
		assert.ok(!('abv_pct' in calls[1].input.fields));
		assert.match(out.result?.subline ?? '', /12\.5% ABV \(typical for wine\)/);
	});
});

describe('POST /api/extract-decide', () => {
	const post = (body: BodyInit, type: string, query = '') => {
		const request = new Request(`http://localhost/api/extract-decide${query}`, {
			method: 'POST',
			headers: { 'content-type': type },
			body,
		});
		return { request, url: new URL(request.url) };
	};

	it('rejects bad content types, empty images, and unknown recipes', async () => {
		const { runAI, calls } = fake({});
		assert.equal((await handleExtractDecide(post('x', 'text/plain'), runAI)).status, 415);
		assert.equal((await handleExtractDecide(post(new Uint8Array(0), 'image/jpeg'), runAI)).status, 400);
		const bad = await handleExtractDecide(post(new Uint8Array([1]), 'image/jpeg', '?recipe=nope'), runAI);
		assert.equal(bad.status, 400);
		assert.deepEqual(await bad.json(), { error: 'Unknown recipe "nope".' });
		assert.equal(calls.length, 0);
	});

	it('runs a JSON request with settings and reports timing and bytes', async () => {
		const { runAI } = fake(
			{ drink_visible: noul(0.9), drink_type: choice({ water: 1 }), label_readable: noul(0) },
			{ capacity_ml: est(600), fill_pct: est(50) }
		);
		const response = await handleExtractDecide(
			post(JSON.stringify({ image, recipe: 'drink', settings: { hydrationGoalMl: 3000 } }), 'application/json'),
			runAI
		);
		assert.equal(response.status, 200);
		const payload = await response.json();
		assert.equal(payload.recipe, 'drink');
		assert.match(payload.result.subline, /^10% of a 3\.0 L daily goal/);
		assert.equal(typeof payload.inferenceMs, 'number');
		assert.equal(payload.bytes, 4);
	});

	it('reports which stage failed', async () => {
		const runAI = async (model: string) => {
			if (model === CLAIRIC_MODEL) throw new Error('AiError: preview capacity');
			return { answers: { hands_raised: noul(1) } };
		};
		const response = await handleExtractDecide(post(new Uint8Array([1]), 'image/jpeg', '?recipe=fingers'), runAI);
		assert.equal(response.status, 500);
		assert.deepEqual(await response.json(), {
			error: 'AiError: preview capacity',
			stage: 'extract',
			model: CLAIRIC_MODEL,
			recipe: 'fingers',
		});
	});
});

describe('runRecipe: tech neck', () => {
	it('gates on a visible person and converts tilt to neck load', async () => {
		const gated = fake({ person_visible: noul(0.1) });
		assert.match((await runRecipe('neck', image, DEFAULT_SETTINGS, gated.runAI)).skipped ?? '', /head and shoulders/);
		assert.equal(gated.calls.length, 1);

		const { calls, runAI } = fake(
			{ person_visible: noul(0.95), posture: choice({ looking_down: 0.8, slouching: 0.2 }) },
			{ head_tilt_deg: est(30, 20, 40) }
		);
		const out = await runRecipe('neck', image, DEFAULT_SETTINGS, runAI);
		assert.match(calls[1].input.state, /looking at a phone/);
		assert.equal(out.result?.headline, '~18 kg on your neck');
		assert.equal(out.result?.hero, '😬');
		assert.match(out.result?.note ?? '', /not medical advice/);
	});

	it('interpolates and clamps the published loads', () => {
		assert.equal(neckLoadKg(0), 5);
		assert.equal(neckLoadKg(22.5), 15);
		assert.equal(neckLoadKg(60), 27);
		assert.equal(neckLoadKg(90), 27);
		assert.equal(neckLoadKg(-5), 5);
	});
});

describe('runRecipe: watch reader', () => {
	/** Clef Flash answers for an analog watch; markers are image positions (h1–h12). */
	const analogDecide = (minute: number, hour: number, crown = 'right', twelve = 'top') => ({
		timepiece: choice({ analog: 0.9, digital: 0.1 }),
		readable: noul(0.9),
		crown_position: choice({ [crown]: 0.8 }),
		twelve_position: choice({ [twelve]: 0.9 }),
		minute_marker: choice({ [`h${minute}`]: 0.8 }),
		hour_marker: choice({ [`h${hour}`]: 0.8 }),
	});

	it('gates on a readable timepiece', async () => {
		const none = fake({ timepiece: choice({ none: 0.9 }) });
		assert.match((await runRecipe('watch', image, DEFAULT_SETTINGS, none.runAI)).skipped ?? '', /Hold a watch/);
		const blurry = fake({ timepiece: choice({ analog: 0.9 }), readable: noul(0.2) });
		assert.match((await runRecipe('watch', image, DEFAULT_SETTINGS, blurry.runAI)).skipped ?? '', /closer/);
	});

	it('reads an upright analog watch from hand angles', async () => {
		const { calls, runAI } = fake(analogDecide(10, 4), {
			minute_hand_deg: est(300, 295, 306),
			hour_hand_deg: est(115, 110, 121),
			displayed_time: { type: 'time', value: '13:50:00' },
		});
		const out = await runRecipe('watch', image, DEFAULT_SETTINGS, runAI);
		assert.match(calls[1].input.state, /faces the top edge of the image/);
		// Direct read got the hour wrong (1:50); Clef Flash's hour position favours the geometry.
		assert.equal(out.result?.headline, '3:50');
		// The dial draws the final time's hands (3:50 → 300°, 115°), not Clairic's raw hour angle.
		assert.deepEqual([out.result?.dial?.minute.mid, out.result?.dial?.hour.mid], [300, 115]);
		assert.deepEqual(out.result?.clock, { hours: 3, minutes: 50 });
	});

	it('prefers Clairic’s direct read when it agrees better with Clef Flash (live 12:04 case)', async () => {
		const { runAI } = fake(analogDecide(1, 12), {
			minute_hand_deg: est(44, 14, 123),
			hour_hand_deg: est(3, 1, 39),
			displayed_time: { type: 'time', value: '00:04:00' },
		});
		const out = await runRecipe('watch', image, DEFAULT_SETTINGS, runAI);
		assert.equal(out.result?.headline, '12:04');
		assert.ok(out.result?.facts.some((f) => f.label === 'Minutes · Clairic' && f.value === ':04 from the direct read'));
	});

	it('finds 12 from the crown on a rotated watch and rotates the hands onto the dial', async () => {
		// 7:23 with 12 facing left (crown at top): dial angles 138° / 221.5° → image 48° / 131.5°.
		const { calls, runAI } = fake(analogDecide(2, 4, 'top', 'top'), {
			minute_hand_deg: est(48, 44, 53),
			hour_hand_deg: est(131, 126, 137),
		});
		const out = await runRecipe('watch', image, DEFAULT_SETTINGS, runAI);
		assert.match(calls[1].input.state, /faces the left edge/);
		assert.equal(out.result?.headline, '7:23');
		assert.ok(out.result?.facts.some((f) => f.value === 'left (from the crown)'));
	});

	it('avoids the 3:50 trap: Clef Flash decides the hour, Clairic the minutes (live case)', async () => {
		// The short hand is nearest 4, but at :50 that means 3.
		const { runAI } = fake(analogDecide(10, 4), {
			minute_hand_deg: est(127, 84, 304),
			hour_hand_deg: est(154, 102, 198),
			displayed_time: { type: 'time', value: '13:50:00' },
		});
		const out = await runRecipe('watch', image, DEFAULT_SETTINGS, runAI);
		assert.equal(out.result?.headline, '3:50');
		assert.ok(out.result?.facts.some((f) => f.label === 'Hour · Clef Flash' && f.value === '3 (short hand nearest 4 at :50)'));
	});

	it('rotates Clef Flash’s hour answer onto the dial', async () => {
		// 12 faces left: image position 4 o'clock (120°) → dial 210° → 7.
		const { runAI } = fake(analogDecide(2, 4, 'top', 'top'), {
			minute_hand_deg: est(48, 44, 53),
			hour_hand_deg: est(131, 126, 137),
		});
		assert.equal((await runRecipe('watch', image, DEFAULT_SETTINGS, runAI)).result?.headline, '7:23');
	});

	it('settles a split minute-hand estimate near 12 with Clef Flash’s position', async () => {
		const { runAI } = fake(analogDecide(12, 2), {
			minute_hand_deg: est(180, 357, 4),
			hour_hand_deg: est(60, 55, 64),
		});
		const out = await runRecipe('watch', image, DEFAULT_SETTINGS, runAI);
		assert.equal(out.result?.headline, '2:00');
	});

	it('handles a three-hand watch: names the thinnest hand as seconds and keeps it out of the time', async () => {
		const decide = { ...analogDecide(10, 4), seconds_hand: noul(0.9) };
		const { calls, runAI } = fake(decide, {
			minute_hand_deg: est(300, 296, 305),
			hour_hand_deg: est(116, 110, 121),
			displayed_time: { type: 'time', value: '3:50:27' },
		});
		const out = await runRecipe('watch', image, DEFAULT_SETTINGS, runAI);
		assert.match(calls[1].input.state, /thinnest is the seconds hand/);
		assert.match(calls[1].input.fields.minute_hand_deg.instructions, /not the thinnest seconds hand/);
		assert.ok(!('seconds_hand_deg' in calls[1].input.fields));
		assert.equal(out.route?.label, 'Analog · 3 hands');
		assert.equal(out.result?.headline, '3:50');
		assert.ok(out.result?.facts.some((f) => f.label === 'Seconds hand'));
	});

	it('asks for no seconds hand on a two-hand watch', async () => {
		const { calls, runAI } = fake({ ...analogDecide(10, 4), seconds_hand: noul(0.1) }, {
			minute_hand_deg: est(300),
			hour_hand_deg: est(115),
		});
		const out = await runRecipe('watch', image, DEFAULT_SETTINGS, runAI);
		assert.doesNotMatch(calls[1].input.state, /seconds hand/);
		assert.ok(!out.result?.facts.some((f) => f.label === 'Seconds hand'));
	});

	it('reads a phone lock screen as the easy case', async () => {
		const { calls, runAI } = fake(
			{ timepiece: choice({ digital: 0.95 }), readable: noul(0.9) },
			{ displayed_time: { type: 'time', value: '14:07' } }
		);
		const out = await runRecipe('watch', image, DEFAULT_SETTINGS, runAI);
		assert.deepEqual(Object.keys(calls[1].input.fields), ['displayed_time']);
		assert.equal(out.result?.headline, '2:07');
		assert.deepEqual(out.result?.clock, { hours: 2, minutes: 7 });
	});
});

describe('runRecipe: finger math', () => {
	it('gates on two raised hands, then counts with the live-tuned fields', async () => {
		const gated = fake({ hands_raised: noul(0.2) });
		const skipped = await runRecipe('fingers', image, DEFAULT_SETTINGS, gated.runAI);
		assert.equal(gated.calls.length, 1);
		assert.match(skipped.skipped ?? '', /Raise two hands/);

		const { calls, runAI } = fake({ hands_raised: noul(0.9) }, { hand_one_fingers: val(3), hand_two_fingers: val(4), product: val(12) });
		const out = await runRecipe('fingers', image, DEFAULT_SETTINGS, runAI);
		assert.deepEqual(calls[1].input.fields, FINGER_FIELDS);
		assert.equal(calls[1].input.fields.hand_one_fingers.instructions, 'Fingers held up on the hand on the right');
		assert.equal(out.result?.headline, '3 × 4 = 12');
		assert.equal(out.result?.subline, 'Clairic agrees');
	});

	it('multiplies in code and shows when Clairic’s own product disagrees', async () => {
		const { runAI } = fake({ hands_raised: noul(0.9) }, { hand_one_fingers: val(5), hand_two_fingers: val(3), product: val(16) });
		const out = await runRecipe('fingers', image, DEFAULT_SETTINGS, runAI);
		assert.equal(out.result?.headline, '5 × 3 = 15');
		assert.equal(out.result?.subline, 'Clairic said 16');
	});
});
