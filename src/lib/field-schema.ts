/**
 * Field Schema — the typed fields an Extraction asks `@cf/cloudflare/clairic`
 * to read, compute, or estimate from one captured image.
 *
 * This module is the single source of truth for the schema rules. It is
 * imported by the server route (`POST /api/extract`) and bundled into the
 * `/extract` browser editor, so the live editor and the API can never
 * disagree about what a valid schema is. Keep it free of runtime-specific
 * imports (no `cloudflare:workers`, no DOM).
 *
 * @see https://developers.cloudflare.com/workers-ai/models/clairic/
 */

export const FIELD_TYPES = [
	'text',
	'number',
	'date',
	'time',
	'datetime',
	'duration',
	'list',
	'estimate',
	'forecast',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export const LIST_ITEM_TYPES = ['text', 'number', 'date'] as const;
export const DURATION_UNITS = ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years'] as const;
export const FORECAST_INTERVALS = ['step', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'] as const;
export const ESTIMATE_SCALES = ['linear', 'log'] as const;

/**
 * Demo cap on fields per schema. Clairic itself has no upper limit (it splits
 * large schemas across parallel passes), but every field costs input tokens
 * on every sampled frame.
 */
export const MAX_FIELDS = 32;

/** Clairic's field-name rule (stricter than Clef Flash question IDs). */
export const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$/;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type FieldSpec = {
	type: FieldType;
	instructions?: string;
	unit?: string;
	integer?: boolean;
	decimals?: number;
	items?: (typeof LIST_ITEM_TYPES)[number];
	min?: number | string;
	max?: number | string;
	step?: number | 'month' | 'year';
	scale?: (typeof ESTIMATE_SCALES)[number];
	null_threshold?: number;
	horizon?: number;
	interval?: (typeof FORECAST_INTERVALS)[number];
};

export type FieldMap = Record<string, FieldSpec>;

export type ExtractPresetKey = 'scene' | 'site';

/** Preset used when none (or an unknown one) is requested. */
export const DEFAULT_EXTRACT_PRESET: ExtractPresetKey = 'scene';

/** Narrow an arbitrary value to a known preset key, or `null`. */
export function asExtractPresetKey(value: unknown): ExtractPresetKey | null {
	return typeof value === 'string' && Object.hasOwn(EXTRACT_PRESETS, value)
		? (value as ExtractPresetKey)
		: null;
}

export type ExtractPreset = {
	label: string;
	state: string;
	fields: FieldMap;
};

/**
 * Built-in Field Schema presets for `/extract` and `POST /api/extract`.
 *
 * - `scene`: webcam-friendly counts and readable text.
 * - `site`: industrial field counts, gauge readings, and sign/tag text.
 *
 * Object order is the button order in the `/extract` preset bar.
 */
export const EXTRACT_PRESETS: Record<ExtractPresetKey, ExtractPreset> = {
	scene: {
		label: 'Webcam & Objects',
		state: 'Live webcam frame from a browser session.',
		fields: {
			people_count: {
				type: 'estimate',
				min: 0,
				max: 10,
				step: 1,
				instructions: 'Number of people visible in the frame',
			},
			fingers_raised: {
				type: 'estimate',
				min: 0,
				max: 10,
				step: 1,
				instructions: 'Total fingers held up across all visible hands',
			},
			held_items: {
				type: 'list',
				items: 'text',
				instructions: 'Objects a person is holding',
			},
			visible_text: {
				type: 'text',
				instructions: 'Readable printed text, such as a sign, shirt, mug, or label',
			},
		},
	},
	site: {
		label: 'Site & Gauges',
		state: 'Industrial field camera frame monitored for workers, gauges, and posted signage.',
		fields: {
			people_count: {
				type: 'estimate',
				min: 0,
				max: 30,
				step: 1,
				instructions: 'Number of people visible in the frame',
			},
			people_without_hardhat: {
				type: 'estimate',
				min: 0,
				max: 30,
				step: 1,
				instructions: 'Number of visible people not wearing a hardhat or safety helmet',
			},
			gauge_reading: {
				type: 'number',
				decimals: 1,
				instructions: 'Value shown on the most prominent gauge, meter, or digital readout',
			},
			sign_text: {
				type: 'text',
				instructions: 'Text on the most prominent safety or hazard sign',
			},
			inspection_date: {
				type: 'date',
				instructions: 'Date on any visible inspection tag or label',
			},
		},
	},
};

export type FieldSchemaResult = { ok: true; fields: FieldMap } | { ok: false; error: string };

const KNOWN_KEYS = new Set([
	'type',
	'instructions',
	'unit',
	'integer',
	'decimals',
	'items',
	'min',
	'max',
	'step',
	'scale',
	'null_threshold',
	'horizon',
	'interval',
]);

const RANGE_TYPES = new Set<FieldType>(['estimate', 'forecast']);

/**
 * Validate and normalize a Field Schema.
 *
 * Enforces Clairic's documented per-type rules (required `items` on lists,
 * required `min`/`max` on estimates and forecasts, forecast-only `horizon`
 * and `interval`, numeric-only `integer`/`decimals`, and so on) and rejects
 * keys that do not apply to a field's type, so mistakes surface in the
 * editor instead of as an opaque model error.
 */
export function normalizeFields(rawFields: unknown): FieldSchemaResult {
	if (!isPlainObject(rawFields)) {
		return { ok: false, error: '`fields` must be a non-empty JSON object.' };
	}

	const entries = Object.entries(rawFields);
	if (entries.length < 1 || entries.length > MAX_FIELDS) {
		return { ok: false, error: `\`fields\` must contain between 1 and ${MAX_FIELDS} fields.` };
	}

	const normalized: FieldMap = {};
	for (const [name, rawField] of entries) {
		const result = normalizeField(name, rawField);
		if (!result.ok) return result;
		normalized[name] = result.field;
	}

	return { ok: true, fields: normalized };
}

function normalizeField(
	name: string,
	raw: unknown
): { ok: true; field: FieldSpec } | { ok: false; error: string } {
	const fail = (message: string) => ({ ok: false as const, error: `Field "${name}" ${message}` });

	if (!FIELD_NAME_PATTERN.test(name)) {
		return {
			ok: false,
			error: `Invalid field name "${name}". Start with a letter or '_', then up to 63 letters, digits, '_', '.', or '-'.`,
		};
	}
	if (!isPlainObject(raw)) return fail('must be an object.');

	for (const key of Object.keys(raw)) {
		if (!KNOWN_KEYS.has(key)) return fail(`has unknown key "${key}".`);
	}

	const type = raw.type;
	if (!FIELD_TYPES.includes(type as FieldType)) {
		return fail(`has unsupported type "${String(type)}". Expected one of: ${FIELD_TYPES.join(', ')}.`);
	}
	const fieldType = type as FieldType;
	const field: FieldSpec = { type: fieldType };
	const has = (key: string) => raw[key] !== undefined;
	const onlyFor = (key: string, allowed: FieldType[]) =>
		has(key) && !allowed.includes(fieldType)
			? fail(`uses "${key}", which only applies to ${allowed.join(' / ')} fields.`)
			: null;

	if (has('instructions')) {
		if (typeof raw.instructions !== 'string') return fail('"instructions" must be a string.');
		const instructions = raw.instructions.trim();
		if (instructions) field.instructions = instructions;
	}

	if (has('unit')) {
		if (typeof raw.unit !== 'string' || !raw.unit.trim()) return fail('"unit" must be a non-empty string.');
		const unit = raw.unit.trim();
		if (fieldType === 'duration' && !(DURATION_UNITS as readonly string[]).includes(unit)) {
			return fail(`duration "unit" must be one of: ${DURATION_UNITS.join(', ')}.`);
		}
		field.unit = unit;
	}

	const integerMisuse = onlyFor('integer', ['number', 'duration']);
	if (integerMisuse) return integerMisuse;
	if (has('integer')) {
		if (typeof raw.integer !== 'boolean') return fail('"integer" must be true or false.');
		field.integer = raw.integer;
	}

	if (fieldType === 'list') {
		if (!(LIST_ITEM_TYPES as readonly unknown[]).includes(raw.items)) {
			return fail(`is a list and requires "items": one of ${LIST_ITEM_TYPES.join(', ')}.`);
		}
		field.items = raw.items as FieldSpec['items'];
	} else if (has('items')) {
		return fail('uses "items", which only applies to list fields.');
	}

	if (has('decimals')) {
		const numericList = fieldType === 'list' && field.items === 'number';
		if (fieldType !== 'number' && fieldType !== 'duration' && !numericList) {
			return fail('uses "decimals", which only applies to number, duration, or number-list fields.');
		}
		if (!Number.isInteger(raw.decimals) || (raw.decimals as number) < 0 || (raw.decimals as number) > 6) {
			return fail('"decimals" must be an integer from 0 to 6.');
		}
		field.decimals = raw.decimals as number;
	}

	if (has('null_threshold')) {
		const t = raw.null_threshold;
		if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > 1) {
			return fail('"null_threshold" must be a number greater than 0 and at most 1.');
		}
		field.null_threshold = t;
	}

	for (const key of ['min', 'max', 'step', 'scale']) {
		const misuse = onlyFor(key, ['estimate', 'forecast']);
		if (misuse) return misuse;
	}
	for (const key of ['horizon', 'interval']) {
		const misuse = onlyFor(key, ['forecast']);
		if (misuse) return misuse;
	}

	if (RANGE_TYPES.has(fieldType)) {
		const range = normalizeRange(raw);
		if (!range.ok) return fail(range.error);
		Object.assign(field, range.value);
	}

	if (fieldType === 'forecast') {
		if (has('horizon')) {
			const h = raw.horizon;
			if (!Number.isInteger(h) || (h as number) < 1 || (h as number) > 64) {
				return fail('"horizon" must be an integer from 1 to 64.');
			}
			field.horizon = h as number;
		}
		if (has('interval')) {
			if (!(FORECAST_INTERVALS as readonly unknown[]).includes(raw.interval)) {
				return fail(`"interval" must be one of: ${FORECAST_INTERVALS.join(', ')}.`);
			}
			field.interval = raw.interval as FieldSpec['interval'];
		}
	}

	return { ok: true, field };
}

function normalizeRange(
	raw: Record<string, unknown>
): { ok: true; value: Partial<FieldSpec> } | { ok: false; error: string } {
	if (raw.min === undefined || raw.max === undefined) {
		return { ok: false, error: 'requires both "min" and "max" (numbers, or ISO dates for date estimates).' };
	}

	const value: Partial<FieldSpec> = {};
	const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
	const isDate = (v: unknown): v is string =>
		typeof v === 'string' && ISO_DATE_PATTERN.test(v) && !Number.isNaN(Date.parse(v));

	let dateRange = false;
	if (isNum(raw.min) && isNum(raw.max)) {
		if (raw.min >= raw.max) return { ok: false, error: '"min" must be less than "max".' };
	} else if (isDate(raw.min) && isDate(raw.max)) {
		if (raw.min >= raw.max) return { ok: false, error: '"min" must be an earlier date than "max".' };
		dateRange = true;
	} else {
		return {
			ok: false,
			error: '"min" and "max" must both be numbers or both be ISO dates (YYYY-MM-DD).',
		};
	}
	value.min = raw.min as number | string;
	value.max = raw.max as number | string;

	if (raw.step !== undefined) {
		if (raw.step === 'month' || raw.step === 'year') {
			if (!dateRange) return { ok: false, error: '"step" of "month" or "year" requires a date range.' };
			value.step = raw.step;
		} else if (isNum(raw.step) && raw.step > 0) {
			value.step = raw.step;
		} else {
			return { ok: false, error: '"step" must be a positive number, "month", or "year".' };
		}
	}

	if (raw.scale !== undefined) {
		if (!(ESTIMATE_SCALES as readonly unknown[]).includes(raw.scale)) {
			return { ok: false, error: `"scale" must be one of: ${ESTIMATE_SCALES.join(', ')}.` };
		}
		if (raw.scale === 'log' && (dateRange || (raw.min as number) <= 0)) {
			return { ok: false, error: '"scale": "log" requires a numeric range with "min" greater than 0.' };
		}
		value.scale = raw.scale as FieldSpec['scale'];
	}

	return { ok: true, value };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
