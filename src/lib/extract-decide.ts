/**
 * Extract + Decide — recipes that combine Clef Flash (Decision) and Clairic
 * (Extraction) on one captured image.
 *
 * Each recipe has a Decide stage (typed Clef Flash questions) and an Extract
 * stage (a Clairic Field Schema), plus a `compute` step that turns both
 * answer sets into one result card. Clef Flash runs first; its answers gate
 * the frame (skip Clairic when there is nothing to measure) and route it to
 * the right Field Schema.
 *
 * Deterministic maths (hydration, caffeine, standard drinks, products) is done
 * here in code from the models' readings, so the arithmetic is checkable.
 *
 * Kept free of runtime-specific imports so it can be tested offline.
 */
import type { AIRunner } from './api-helpers.ts';
import {
	type Edge,
	bestHour,
	circularDistance,
	formatReading,
	handAngles,
	imageToDial,
	markerDisagreement,
	parseDisplayedTime,
	readAnalog,
	resolveHandAngle,
	twelveFromCrown,
} from './clock.ts';
import type { FieldMap } from './field-schema.ts';

export const CLEF_FLASH_MODEL = '@cf/cloudflare/clef-flash';
export const CLAIRIC_MODEL = '@cf/cloudflare/clairic';

// ---------- question types (Clef Flash wire format) ----------

export type Question =
	| { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
	| { type: 'choice'; instructions: string; criteria: Record<string, string> }
	| { type: 'score'; instructions: string; criteria: string[] };

export type QuestionMap = Record<string, Question>;
type Answers = Record<string, any>;

// ---------- settings ----------

export type RecipeSettings = {
	/** Daily hydration goal for the drink recipe, in ml. */
	hydrationGoalMl: number;
};

/** Settings a recipe reads; the UI shows only these controls for it. */
export type SettingKey = keyof RecipeSettings;

export const DEFAULT_SETTINGS: RecipeSettings = {
	hydrationGoalMl: 2500,
};

/** Grams of pure alcohol in one US standard drink. */
export const STANDARD_DRINK_GRAMS = 14;

export function normalizeSettings(raw: unknown): RecipeSettings {
	const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const goal = Number(input.hydrationGoalMl);
	return {
		hydrationGoalMl:
			Number.isFinite(goal) && goal >= 500 && goal <= 6000 ? Math.round(goal) : DEFAULT_SETTINGS.hydrationGoalMl,
	};
}

// ---------- result types ----------

export type Fact = { label: string; value: string };
export type Spread = { mid: number; low: number; high: number };

export type RecipeResult = {
	/** Optional large visual shown above the headline (e.g. an emoji). */
	hero?: string;
	headline: string;
	subline?: string;
	facts: Fact[];
	note?: string;
	/** Analog dial to draw: final hand angles (`mid`, degrees clockwise from 12) over Clairic's measured p10–p90. */
	dial?: { minute: Spread; hour: Spread };
	/**
	 * A clock reading (12-hour). The browser compares it with its own local
	 * time, which never goes into the models' input.
	 */
	clock?: { hours: number; minutes: number };
};


type ExtractPlan = { route: string; routeLabel: string; state: string; fields: FieldMap };
type Skip = { skip: string };

type Recipe = {
	label: string;
	blurb: string;
	state: string;
	/** Settings this recipe reads. */
	settings: SettingKey[];
	/** Capture size for this recipe (default 640×360); small text and dials need more. */
	capture?: { width: number; height: number };
	questions: QuestionMap;
	/** Gate and route: choose the Extract stage from Clef Flash's answers, or skip it. */
	plan(decide: Answers, settings: RecipeSettings): ExtractPlan | Skip;
	compute(decide: Answers, extract: Answers, plan: ExtractPlan, settings: RecipeSettings): RecipeResult;
};

// ---------- answer helpers ----------

/** P(yes) of a noul answer, or 0 when missing. */
export function pYes(answer: unknown): number {
	const p = (answer as Answers | undefined)?.noul;
	return typeof p === 'number' && Number.isFinite(p) ? p : 0;
}

function topChoice(answer: unknown): string | null {
	const a = answer as Answers | undefined;
	if (typeof a?.choice === 'string') return a.choice;
	const probs = a?.probabilities;
	if (!probs || typeof probs !== 'object') return null;
	let best: string | null = null;
	let bestP = -1;
	for (const [key, p] of Object.entries(probs)) {
		if (typeof p === 'number' && p > bestP) {
			best = key;
			bestP = p;
		}
	}
	return best;
}

function probs(answer: unknown): Record<string, number> {
	const raw = (answer as Answers | undefined)?.probabilities;
	const out: Record<string, number> = {};
	if (raw && typeof raw === 'object') {
		for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
	}
	return out;
}

/** Median and p10–p90 of a Clairic estimate, or a plain number's value. */
function spread(answer: unknown): Spread | null {
	const a = answer as Answers | undefined;
	const mid = num(a?.median) ?? num(a?.value);
	if (mid === null) return null;
	return { mid, low: num(a?.p10) ?? mid, high: num(a?.p90) ?? mid };
}

function num(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function value(answer: unknown): unknown {
	const v = (answer as Answers | undefined)?.value;
	return v === undefined ? null : v;
}

function pct(p: number) {
	return `${Math.round(p * 100)}%`;
}

function fmt(n: number, digits = 0) {
	return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function rangeText(s: Spread, unit = '', digits = 0) {
	const u = unit ? ` ${unit}` : '';
	return s.low === s.high ? `${fmt(s.mid, digits)}${u}` : `${fmt(s.low, digits)}–${fmt(s.high, digits)}${u}`;
}

// ---------- Drink Check ----------

const DRINK_TYPES: Record<string, string> = {
	water: 'plain water',
	sparkling_water: 'sparkling or flavored water',
	coffee: 'coffee or espresso drink',
	tea: 'tea',
	soda: 'soda or soft drink',
	energy_drink: 'energy drink',
	juice: 'juice or smoothie',
	beer: 'beer or cider',
	wine: 'wine',
	cocktail: 'cocktail or mixed drink',
	none: 'no drink visible',
};

/** Typical caffeine per ml (≈ coffee 95 mg/240 ml, tea 47/240, soda 34/355, energy 80/250). */
export const CAFFEINE_MG_PER_ML: Record<string, number> = {
	coffee: 0.4,
	tea: 0.2,
	soda: 0.1,
	energy_drink: 0.32,
};

/** Typical ABV % when no label is readable: [typical, low, high]. */
export const TYPICAL_ABV: Record<string, [number, number, number]> = {
	beer: [5, 4, 7],
	wine: [12.5, 11, 15],
	cocktail: [15, 8, 25],
};

const HYDRATION = new Set(['water', 'sparkling_water', 'juice']);
const ETHANOL_G_PER_ML = 0.789;

type DrinkGroup = 'hydration' | 'caffeine' | 'alcohol';

function drinkGroup(type: string): DrinkGroup {
	if (type in CAFFEINE_MG_PER_ML) return 'caffeine';
	if (type in TYPICAL_ABV) return 'alcohol';
	return 'hydration';
}

/** Standard drinks in a volume of a beverage at a given ABV. */
export function standardDrinks(volumeMl: number, abvPct: number, gramsPerDrink = STANDARD_DRINK_GRAMS): number {
	return (volumeMl * (abvPct / 100) * ETHANOL_G_PER_ML) / gramsPerDrink;
}

/** Probability-weighted mean of `table` over the types present in `p`. */
function weighted(p: Record<string, number>, table: Record<string, number>): { value: number; mix: string } {
	let total = 0;
	let sum = 0;
	const parts: string[] = [];
	for (const [type, perUnit] of Object.entries(table)) {
		const w = p[type] ?? 0;
		if (w <= 0) continue;
		total += w;
		sum += w * perUnit;
		parts.push(`${type.replace(/_/g, ' ')} ${pct(w)}`);
	}
	return { value: total > 0 ? sum / total : 0, mix: parts.join(' · ') };
}

const drink: Recipe = {
	label: 'Drink Check',
	blurb: 'Clef Flash identifies the drink; Clairic measures it; the maths depends on what it is.',
	state: 'A person holds up a drink container to the webcam.',
	settings: ['hydrationGoalMl'],
	questions: {
		drink_visible: {
			type: 'noul',
			instructions: 'Is a person holding up a drink or drink container?',
		},
		drink_type: {
			type: 'choice',
			instructions: 'What kind of drink is it?',
			criteria: DRINK_TYPES,
		},
		label_readable: {
			type: 'noul',
			instructions: 'Is a brand label or printed text on the drink clearly readable?',
		},
	},
	plan(decide) {
		const type = topChoice(decide?.drink_type);
		if (pYes(decide?.drink_visible) < 0.5 || !type || type === 'none') {
			return { skip: 'No drink in view. Hold one up to the camera.' };
		}
		const group = drinkGroup(type);
		const fields: FieldMap = {
			capacity_ml: {
				type: 'estimate',
				min: 100,
				max: 1200,
				step: 10,
				unit: 'ml',
				instructions: 'Full capacity of the drink container',
			},
			fill_pct: {
				type: 'estimate',
				min: 0,
				max: 100,
				step: 5,
				unit: '%',
				instructions: 'How full the container is',
			},
		};
		if (pYes(decide?.label_readable) >= 0.5) {
			fields.brand = { type: 'text', instructions: 'Brand or product name printed on the label' };
			if (group === 'alcohol') {
				fields.abv_pct = {
					type: 'number',
					decimals: 1,
					unit: '%',
					instructions: 'Alcohol by volume percentage printed on the label',
				};
			}
		}
		const typeLabel = DRINK_TYPES[type] ?? type;
		return {
			route: group,
			routeLabel: { hydration: 'Hydration', caffeine: 'Caffeine', alcohol: 'Alcohol' }[group],
			state: `A person holds up a container of ${typeLabel} to the webcam.`,
			fields,
		};
	},
	compute(decide, extract, plan, settings) {
		const capacity = spread(extract.capacity_ml);
		const fill = spread(extract.fill_pct);
		const brand = typeof value(extract.brand) === 'string' ? (value(extract.brand) as string) : null;
		const type = topChoice(decide.drink_type) ?? 'drink';
		const typeName = type.replace(/_/g, ' ');
		if (!capacity || !fill) {
			return { headline: typeName, subline: 'Could not measure the container', facts: [] };
		}
		const remaining: Spread = {
			mid: (capacity.mid * fill.mid) / 100,
			low: (capacity.low * fill.low) / 100,
			high: (capacity.high * fill.high) / 100,
		};
		const facts: Fact[] = [
			{ label: 'Drink', value: brand ? `${brand} (${typeName})` : typeName },
			{ label: 'Container', value: `${fmt(capacity.mid)} ml (${rangeText(capacity, 'ml')})` },
			{ label: 'Fill', value: `${fmt(fill.mid)}% (${rangeText(fill, '%')})` },
			{ label: 'Left', value: `${fmt(remaining.mid)} ml (${rangeText(remaining, 'ml')})` },
		];
		const p = probs(decide.drink_type);

		if (plan.route === 'caffeine') {
			const { value: mgPerMl, mix } = weighted(p, CAFFEINE_MG_PER_ML);
			const mg: Spread = {
				mid: remaining.mid * mgPerMl,
				low: remaining.low * mgPerMl,
				high: remaining.high * mgPerMl,
			};
			facts.push({ label: 'Caffeine', value: `${rangeText(mg, 'mg')} (typical for type)` });
			return {
				headline: `~${fmt(mg.mid)} mg caffeine`,
				subline: `in what's left · ${mix}`,
				facts,
			};
		}

		if (plan.route === 'alcohol') {
			const labelAbv = num(value(extract.abv_pct));
			let abv: Spread;
			let source: string;
			if (labelAbv !== null) {
				abv = { mid: labelAbv, low: labelAbv, high: labelAbv };
				source = 'from label';
			} else {
				const typical = TYPICAL_ABV[type] ?? TYPICAL_ABV.beer;
				abv = { mid: typical[0], low: typical[1], high: typical[2] };
				source = `typical for ${typeName}`;
			}
			const g = STANDARD_DRINK_GRAMS;
			const drinks: Spread = {
				mid: standardDrinks(remaining.mid, abv.mid, g),
				low: standardDrinks(remaining.low, abv.low, g),
				high: standardDrinks(remaining.high, abv.high, g),
			};
			facts.push({ label: 'ABV', value: `${rangeText(abv, '%', 1)} (${source})` });
			facts.push({ label: 'Standard drinks', value: `${rangeText(drinks, '', 1)} (US, ${g} g alcohol each)` });
			return {
				headline: `${fmt(drinks.mid, 1)} standard drink${drinks.mid >= 0.95 && drinks.mid < 1.05 ? '' : 's'}`,
				subline: `${brand ?? typeName} · ${fmt(abv.mid, 1)}% ABV (${source}) · ${fmt(remaining.mid)} ml`,
				facts,
				note: 'Informational only. Not a measure of impairment.',
			};
		}

		const goal = settings.hydrationGoalMl;
		facts.push({ label: 'Daily goal', value: `${fmt(goal / 1000, 1)} L (setting)` });
		return {
			headline: `${fmt(remaining.mid)} ml left`,
			subline: `${pct(remaining.mid / goal)} of a ${fmt(goal / 1000, 1)} L daily goal · ${typeName}`,
			facts,
		};
	},
};

// ---------- Finger Math ----------

/** Field Schema tuned live: plain integer counts, anchored to right / left hand. */
export const FINGER_FIELDS: FieldMap = {
	hand_one_fingers: {
		type: 'number',
		integer: true,
		instructions: 'Fingers held up on the hand on the right',
	},
	hand_two_fingers: {
		type: 'number',
		integer: true,
		instructions: 'Fingers held up on the hand on the left',
	},
	product: {
		type: 'number',
		integer: true,
		instructions: 'Fingers on the first hand multiplied by fingers on the second hand',
	},
};

const FINGER_STATE =
	'Webcam frame. Find the two most prominent hands in view and count the fingers each one is holding up.';

const fingers: Recipe = {
	label: 'Finger Math',
	blurb: 'Clef Flash checks two hands are raised; Clairic counts the fingers; the Worker multiplies and checks Clairic’s own answer.',
	state: FINGER_STATE,
	settings: [],
	questions: {
		hands_raised: {
			type: 'noul',
			instructions: 'Are two hands clearly raised toward the camera with fingers visible?',
		},
	},
	plan(decide) {
		if (pYes(decide?.hands_raised) < 0.5) return { skip: 'Raise two hands toward the camera.' };
		return { route: 'fingers', routeLabel: 'Finger count', state: FINGER_STATE, fields: FINGER_FIELDS };
	},
	compute(_decide, extract) {
		const a = num(value(extract.hand_one_fingers));
		const b = num(value(extract.hand_two_fingers));
		const modelProduct = num(value(extract.product));
		if (a === null || b === null) return { headline: '?', subline: 'Could not count both hands', facts: [] };
		const product = a * b;
		return {
			hero: '✋',
			headline: `${a} × ${b} = ${product}`,
			subline: modelProduct === null || modelProduct === product ? 'Clairic agrees' : `Clairic said ${modelProduct}`,
			facts: [
				{ label: 'Right hand', value: String(a) },
				{ label: 'Left hand', value: String(b) },
				{ label: 'Clairic product', value: modelProduct === null ? '—' : String(modelProduct) },
			],
		};
	},
};

// ---------- Tech Neck Check ----------

/**
 * Estimated load on the neck by forward head tilt, kg (interpolated).
 * From Hansraj (2014), "Assessment of stresses in the cervical spine caused
 * by posture and position of the head": 0° ≈ 10–12 lb, 15° ≈ 27 lb,
 * 30° ≈ 40 lb, 45° ≈ 49 lb, 60° ≈ 60 lb.
 */
export const NECK_LOAD_KG: [deg: number, kg: number][] = [
	[0, 5],
	[15, 12],
	[30, 18],
	[45, 22],
	[60, 27],
];

export function neckLoadKg(tiltDeg: number): number {
	const t = Math.min(Math.max(tiltDeg, 0), 60);
	for (let i = 1; i < NECK_LOAD_KG.length; i += 1) {
		const [d1, k1] = NECK_LOAD_KG[i];
		const [d0, k0] = NECK_LOAD_KG[i - 1];
		if (t <= d1) return k0 + ((t - d0) / (d1 - d0)) * (k1 - k0);
	}
	return NECK_LOAD_KG[NECK_LOAD_KG.length - 1][1];
}

const POSTURES: Record<string, string> = {
	upright: 'sitting or standing upright, head level',
	leaning_in: 'leaning toward the screen or camera',
	slouching: 'slouching, shoulders rounded',
	looking_down: 'head bent down, as if looking at a phone',
};

const neck: Recipe = {
	label: 'Tech Neck',
	blurb: 'Clef Flash checks your posture; Clairic estimates how far your head tilts forward; the Worker works out the load on your neck.',
	state: 'Webcam frame of a person.',
	settings: [],
	questions: {
		person_visible: {
			type: 'noul',
			instructions: 'Is a person’s head and shoulders clearly visible?',
		},
		posture: {
			type: 'choice',
			instructions: 'What is the person’s posture?',
			criteria: POSTURES,
		},
	},
	plan(decide) {
		if (pYes(decide?.person_visible) < 0.5) return { skip: 'Step in so your head and shoulders are in view.' };
		const posture = topChoice(decide?.posture) ?? 'upright';
		return {
			route: posture,
			routeLabel: posture.replace(/_/g, ' '),
			state: `Webcam frame of a person whose posture looks ${POSTURES[posture] ?? posture}.`,
			fields: {
				head_tilt_deg: {
					type: 'estimate',
					min: 0,
					max: 60,
					step: 1,
					unit: '°',
					instructions:
						'How far the head is tilted forward or down from upright, in degrees (0 = head level, ears over shoulders)',
				},
			},
		};
	},
	compute(decide, extract, plan) {
		const tilt = spread(extract.head_tilt_deg);
		const posture = plan.route.replace(/_/g, ' ');
		if (!tilt) return { headline: 'Could not measure head tilt', subline: posture, facts: [] };
		const load: Spread = { mid: neckLoadKg(tilt.mid), low: neckLoadKg(tilt.low), high: neckLoadKg(tilt.high) };
		const p = probs(decide.posture);
		return {
			hero: tilt.mid < 10 ? '🧘' : tilt.mid < 30 ? '🙂' : tilt.mid < 45 ? '😬' : '🦒',
			headline: `~${fmt(load.mid)} kg on your neck`,
			subline: `${fmt(tilt.mid)}° forward tilt · ${posture} (${pct(p[plan.route] ?? 0)})`,
			facts: [
				{ label: 'Head tilt', value: `${fmt(tilt.mid)}° (${rangeText(tilt, '°')})` },
				{ label: 'Neck load', value: `${fmt(load.mid)} kg (${rangeText(load, 'kg')})` },
				{ label: 'Upright head', value: '~5 kg' },
			],
			note: 'Loads from published modelling (Hansraj, 2014). Just for fun, not medical advice.',
		};
	},
};

// ---------- Watch Reader ----------

const IMAGE_POSITIONS = Object.fromEntries(
	Array.from({ length: 12 }, (_, i) => [
		`h${i + 1}`,
		`toward ${i + 1} o’clock, as if the image itself were a clock face with 12 at the top`,
	])
);

const EDGES = { top: 'top edge', right: 'right edge', bottom: 'bottom edge', left: 'left edge' };

/** Image angle of Clef Flash's "h1"–"h12" position answer, or null. */
function positionAngle(answer: unknown): number | null {
	const key = topChoice(answer);
	const match = key ? /^h(\d{1,2})$/.exec(key) : null;
	return match ? (Number(match[1]) % 12) * 30 : null;
}

/** Where the dial's 12 faces: from the crown when Clef Flash sees one clearly, else its direct guess. */
function twelveEdge(decide: Answers | null | undefined): { edge: Edge; from: 'crown' | 'dial' } {
	const crown = topChoice(decide?.crown_position);
	const crownP = probs(decide?.crown_position)[crown ?? ''] ?? 0;
	if (crown && crown in EDGES && crownP >= 0.5) return { edge: twelveFromCrown(crown as Edge), from: 'crown' };
	const twelve = topChoice(decide?.twelve_position);
	return { edge: twelve && twelve in EDGES ? (twelve as Edge) : 'top', from: 'dial' };
}

const watch: Recipe = {
	label: 'Watch Reader',
	blurb: 'Show an analog watch (the challenge) or a phone lock screen. Clef Flash finds the hands and the crown; Clairic reads and measures; geometry and Clef Flash pick the best reading.',
	state: 'Webcam frame. A person may hold up a watch or phone close to the camera.',
	settings: [],
	capture: { width: 1280, height: 720 },
	questions: {
		timepiece: {
			type: 'choice',
			instructions: 'How does the timepiece held up to the camera show the time?',
			criteria: {
				analog: 'with hour and minute hands on a dial (no digits shown)',
				digital: 'as digits on a screen (digital watch, smartwatch, phone lock screen, digital clock)',
				none: 'no timepiece close enough to read',
			},
		},
		readable: {
			type: 'noul',
			instructions: 'Is the watch face or screen close, in focus, and readable?',
		},
		crown_position: {
			type: 'choice',
			instructions: 'For an analog watch, which edge of the image is the crown (the small winding knob on the side of the case) nearest to?',
			criteria: { ...EDGES, none: 'no crown visible' },
		},
		twelve_position: {
			type: 'choice',
			instructions: 'For an analog watch, which edge of the image does the dial’s 12 o’clock position face?',
			criteria: EDGES,
		},
		seconds_hand: {
			type: 'noul',
			instructions: 'For an analog watch, is there a third hand, thinner than the other two (a seconds hand)?',
		},
		minute_marker: {
			type: 'choice',
			instructions:
				'Where in the image does the minute hand point? It is the longer of the two thicker hands; ignore the thinnest hand (seconds) if there is one.',
			criteria: IMAGE_POSITIONS,
		},
		hour_marker: {
			type: 'choice',
			instructions: 'Where in the image does the short hour hand point?',
			criteria: IMAGE_POSITIONS,
		},
	},
	plan(decide) {
		const kind = topChoice(decide?.timepiece);
		if (!kind || kind === 'none') return { skip: 'Hold a watch or phone lock screen up to the camera.' };
		if (pYes(decide?.readable) < 0.5) return { skip: 'Bring it closer and hold it steady.' };
		if (kind === 'digital') {
			return {
				route: 'digital',
				routeLabel: 'Digital',
				state: 'Close-up of a digital watch, smartwatch, phone lock screen, or clock.',
				fields: {
					displayed_time: { type: 'time', instructions: 'The time shown on the display' },
				},
			};
		}
		const { edge } = twelveEdge(decide);
		const threeHands = pYes(decide?.seconds_hand) >= 0.5;
		const angle = (instructions: string) => ({
			type: 'estimate' as const,
			min: 0,
			max: 359,
			step: 1,
			unit: '°',
			instructions,
		});
		const from = 'in degrees clockwise from straight up in the image';
		return {
			route: 'analog',
			routeLabel: threeHands ? 'Analog · 3 hands' : 'Analog',
			state: `Close-up of an analog watch face. The dial’s 12 o’clock position faces the ${edge} edge of the image.${
				threeHands
					? ' It has three hands: the thinnest is the seconds hand, the longer of the two thicker hands is the minute hand, and the shortest is the hour hand.'
					: ''
			}`,
			fields: {
				minute_hand_deg: angle(
					threeHands
						? `Direction the minute hand points (the longer of the two thicker hands, not the thinnest seconds hand), ${from}`
						: `Direction the longer hand (the minute hand) points, ${from}`
				),
				hour_hand_deg: angle(`Direction the shortest hand (the hour hand) points, ${from}`),
				// The seconds hand is named (so it is not mistaken for the minute hand) but not measured:
				// live seconds readings were noise (53 s for 35 s, 24 s for 41 s).
				displayed_time: { type: 'time', instructions: 'The time the watch shows' },
			},
		};
	},
	compute(decide, extract, plan) {
		const direct = parseDisplayedTime(value(extract.displayed_time));
		if (plan.route === 'digital') {
			if (!direct) return { headline: 'Could not read the time', subline: 'Try holding it steadier', facts: [] };
			return {
				hero: '📱',
				headline: formatReading(direct),
				subline: 'Digits are the easy case. Try an analog watch!',
				facts: [{ label: 'Read as', value: String(value(extract.displayed_time)) }],
				clock: direct,
			};
		}

		const { edge, from } = twelveEdge(decide);
		const toDial = (imageAngle: number | null) => (imageAngle === null ? null : imageToDial(imageAngle, edge));
		const markers = {
			minute: toDial(positionAngle(decide.minute_marker)),
			hour: toDial(positionAngle(decide.hour_marker)),
		};

		// Candidate 1: geometry from Clairic's hand angles (image → dial).
		const minuteEst = spread(extract.minute_hand_deg);
		const hourEst = spread(extract.hour_hand_deg);
		const dialSpread = (s: Spread): Spread => ({
			mid: imageToDial(s.mid, edge),
			low: imageToDial(s.low, edge),
			high: imageToDial(s.high, edge),
		});
		let geometry: (ReturnType<typeof readAnalog> & { minuteAngle: number; hourAngle: number }) | null = null;
		let dial: RecipeResult['dial'];
		let lowConfidence = false;
		if (minuteEst && hourEst) {
			const m = dialSpread(minuteEst);
			const h = dialSpread(hourEst);
			const minute = resolveHandAngle(m, markers.minute);
			const hour = resolveHandAngle(h, markers.hour);
			geometry = { ...readAnalog(minute.angle, hour.angle), minuteAngle: minute.angle, hourAngle: hour.angle };
			dial = { minute: { ...m, mid: minute.angle }, hour: { ...h, mid: hour.angle } };
			lowConfidence = minute.agrees === false || hour.agrees === false;
		}

		// Candidate 2: Clairic's direct read. Clef Flash's hand positions judge between them.
		const candidates = [
			geometry ? { source: 'hand angles', reading: geometry } : null,
			direct ? { source: 'direct read', reading: direct } : null,
		].filter((c): c is { source: string; reading: { hours: number; minutes: number } } => c !== null);
		if (!candidates.length) {
			return { headline: 'Could not read the hands', subline: 'Bring the watch closer', facts: [] };
		}
		const scored = candidates
			.map((c) => ({ ...c, score: markerDisagreement(c.reading, markers) }))
			.sort((a, b) => a.score - b.score);
		const best = scored[0];

		// Minutes: the Clairic reading whose minute hand agrees best with Clef Flash's position.
		const minuteSource = [...candidates].sort(
			(a, b) =>
				(markers.minute === null ? 0 : circularDistance(handAngles(a.reading).minute, markers.minute)) -
				(markers.minute === null ? 0 : circularDistance(handAngles(b.reading).minute, markers.minute))
		)[0];
		const minutes = minuteSource.reading.minutes;

		// Hour: where Clef Flash says the short hand is, plus Clairic's minutes. The hour hand
		// sits at hour×30° + minutes×0.5°, so "nearest 4" at :50 means 3 (the 3:50 trap).
		const toHour = (h: number) => h % 12 || 12;
		// (Asking Clef Flash which hour the hand "most recently passed" was tried live and was
		// unreliable; nearest position + minutes got every test watch right.)
		const hourFromClef = markers.hour !== null ? toHour(bestHour(markers.hour, minutes).hour) : null;
		const reading = { hours: hourFromClef ?? best.reading.hours, minutes };

		const facts: Fact[] = [];
		if (hourFromClef !== null) {
			facts.push({
				label: 'Hour · Clef Flash',
				value: `${hourFromClef} (short hand nearest ${toHour(Math.round((markers.hour ?? 0) / 30))} at :${String(minutes).padStart(2, '0')})`,
			});
		}
		facts.push({ label: 'Minutes · Clairic', value: `:${String(minutes).padStart(2, '0')} from the ${minuteSource.source}` });
		if (direct) facts.push({ label: 'Clairic direct read', value: formatReading(direct) });
		if (geometry) {
			facts.push({
				label: 'Clairic hand angles',
				value: `${formatReading(geometry)} (min ${fmt(geometry.minuteAngle)}°, hour ${fmt(geometry.hourAngle)}°)`,
			});
		}
		facts.push({ label: '12 faces', value: `${edge} (from ${from === 'crown' ? 'the crown' : 'the dial'})` });

		if (pYes(decide.seconds_hand) >= 0.5) {
			facts.push({ label: 'Seconds hand', value: 'spotted (the thinnest hand), ignored for the time' });
		}

		// Draw the final time's hands, with Clairic's measured p10–p90 ranges shaded behind them.
		if (dial) {
			const final = handAngles(reading);
			dial = { minute: { ...dial.minute, mid: final.minute }, hour: { ...dial.hour, mid: final.hour } };
		}

		return {
			hero: '⌚',
			headline: formatReading(reading),
			subline:
				best.source === 'hand angles' && geometry?.swapped
					? 'I think I mixed up the hands. Fixed it.'
					: lowConfidence && best.source === 'hand angles'
						? 'Low confidence: the hands were hard to see'
						: hourFromClef !== null
							? `Hour from Clef Flash · minutes from Clairic’s ${minuteSource.source}`
							: `Picked the ${best.source}; Clef Flash’s hand positions agreed best`,
			facts,
			dial,
			clock: reading,
		};
	},
};

// ---------- registry ----------

export const RECIPES = { drink, fingers, neck, watch } satisfies Record<string, Recipe>;
export type RecipeKey = keyof typeof RECIPES;

/** Recipe buttons for the UI. `settings` lists the controls shown for each recipe. */
export type RecipeMenuEntry = {
	key: RecipeKey;
	label: string;
	blurb: string;
	settings: SettingKey[];
	capture: { width: number; height: number };
};

const DEFAULT_CAPTURE = { width: 640, height: 360 };

export const RECIPE_MENU: RecipeMenuEntry[] = (Object.entries(RECIPES) as [RecipeKey, Recipe][]).map(([key, r]) => ({
	key,
	label: r.label,
	blurb: r.blurb,
	settings: r.settings,
	capture: r.capture ?? DEFAULT_CAPTURE,
}));

export const DEFAULT_RECIPE: RecipeKey = RECIPE_MENU[0].key;

export function asRecipeKey(value: unknown): RecipeKey | null {
	return typeof value === 'string' && Object.hasOwn(RECIPES, value) ? (value as RecipeKey) : null;
}

// ---------- pipeline ----------

export type StageReport = {
	model: string;
	state: string;
	questions?: QuestionMap;
	fields?: FieldMap;
	answers: Answers;
	usage: { input_tokens: number; output_tokens: number };
	ms: number;
};

export type PipelineOutput = {
	recipe: RecipeKey;
	label: string;
	route: { key: string; label: string } | null;
	/** Why Clairic was not called (the Decide stage gated the frame), or null. */
	skipped: string | null;
	result: RecipeResult | null;
	decide: StageReport;
	extract: StageReport | null;
	/** Model calls made for this frame. */
	calls: number;
};

export class StageError extends Error {
	readonly stage: 'decide' | 'extract';
	readonly model: string;

	constructor(stage: 'decide' | 'extract', model: string, cause: unknown) {
		super(cause instanceof Error ? cause.message : `${stage} stage failed.`);
		this.stage = stage;
		this.model = model;
	}
}

async function runStage(
	runAI: AIRunner,
	stage: 'decide' | 'extract',
	state: string,
	image: string,
	schema: QuestionMap | FieldMap
): Promise<StageReport> {
	const model = stage === 'decide' ? CLEF_FLASH_MODEL : CLAIRIC_MODEL;
	const input =
		stage === 'decide'
			? { model: 'clef-flash', state, images: [image], questions: schema }
			: { model: 'clairic', state, images: [image], fields: schema };
	const started = Date.now();
	let raw: Answers | null;
	try {
		raw = (await runAI(model, input)) as Answers | null;
	} catch (error) {
		throw new StageError(stage, model, error);
	}
	const answers = raw && typeof raw.answers === 'object' && raw.answers ? raw.answers : {};
	const usage = raw && typeof raw.usage === 'object' && raw.usage ? raw.usage : {};
	return {
		model,
		state,
		...(stage === 'decide' ? { questions: schema as QuestionMap } : { fields: schema as FieldMap }),
		answers,
		usage: { input_tokens: Number(usage.input_tokens ?? 0), output_tokens: Number(usage.output_tokens ?? 0) },
		ms: Date.now() - started,
	};
}

/**
 * Run one recipe against one image data URL.
 *
 * Throws `StageError` when a model call fails.
 */
export async function runRecipe(
	key: RecipeKey,
	image: string,
	settings: RecipeSettings,
	runAI: AIRunner
): Promise<PipelineOutput> {
	const recipe = RECIPES[key];
	const base = { recipe: key, label: recipe.label, skipped: null, result: null, extract: null };

	// Decide, then gate / route, then extract.
	const decide = await runStage(runAI, 'decide', recipe.state, image, { ...recipe.questions });
	const plan = recipe.plan(decide.answers, settings);
	if ('skip' in plan) return { ...base, decide, route: null, skipped: plan.skip, calls: 1 };

	const extract = await runStage(runAI, 'extract', plan.state, image, plan.fields);
	return {
		...base,
		decide,
		route: { key: plan.route, label: plan.routeLabel },
		extract,
		result: recipe.compute(decide.answers, extract.answers, plan, settings),
		calls: 2,
	};
}
