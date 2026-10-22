import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXTRACT_PRESETS, MAX_FIELDS, normalizeFields } from '../lib/field-schema.ts';

function expectError(fields: unknown, pattern: RegExp) {
	const result = normalizeFields(fields);
	assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(fields)}`);
	if (!result.ok) assert.match(result.error, pattern);
}

function expectOk(fields: unknown) {
	const result = normalizeFields(fields);
	assert.equal(result.ok, true, result.ok ? '' : result.error);
	if (!result.ok) throw new Error(result.error);
	return result.fields;
}

describe('normalizeFields (shared by /api/extract and the /extract editor)', () => {
	it('accepts every built-in preset unchanged', () => {
		for (const [key, preset] of Object.entries(EXTRACT_PRESETS)) {
			assert.deepEqual(expectOk(preset.fields), preset.fields, `preset ${key}`);
		}
	});

	it('accepts the documented Clairic invoice example', () => {
		expectOk({
			invoice_number: { type: 'text' },
			due_date: { type: 'date', instructions: 'Issue date plus the net payment days' },
			total: { type: 'number', decimals: 2, unit: 'USD', instructions: 'Amount due including shipping' },
			contacts: { type: 'list', items: 'text' },
			po_number: { type: 'text', instructions: 'Purchase order number' },
			days_to_pay: { type: 'estimate', min: 0, max: 120, step: 1, instructions: 'Days until paid' },
		});
	});

	it('trims instructions and drops empty ones', () => {
		const fields = expectOk({ a: { type: 'text', instructions: '  hi  ' }, b: { type: 'text', instructions: '   ' } });
		assert.deepEqual(fields, { a: { type: 'text', instructions: 'hi' }, b: { type: 'text' } });
	});

	it('rejects non-objects, empty schemas, and oversized schemas', () => {
		expectError(null, /non-empty JSON object/);
		expectError([], /non-empty JSON object/);
		expectError({}, /between 1 and 32/);
		const tooMany = Object.fromEntries(
			Array.from({ length: MAX_FIELDS + 1 }, (_, i) => [`f${i}`, { type: 'text' }])
		);
		expectError(tooMany, /between 1 and 32/);
	});

	it('enforces the Clairic field-name pattern', () => {
		expectError({ '1count': { type: 'number' } }, /Invalid field name "1count"/);
		expectError({ 'has space': { type: 'number' } }, /Invalid field name/);
		expectError({ ['a'.repeat(65)]: { type: 'number' } }, /Invalid field name/);
		expectOk({ _ok: { type: 'number' }, 'a.b-c': { type: 'number' } });
	});

	it('rejects unknown types and unknown keys', () => {
		expectError({ x: { type: 'noul' } }, /unsupported type "noul"/);
		expectError({ x: { type: 'text', criteria: {} } }, /unknown key "criteria"/);
	});

	it('requires items on lists and rejects items elsewhere', () => {
		expectError({ x: { type: 'list' } }, /requires "items"/);
		expectError({ x: { type: 'list', items: 'boolean' } }, /requires "items"/);
		expectError({ x: { type: 'text', items: 'text' } }, /only applies to list/);
	});

	it('limits integer and decimals to numeric fields', () => {
		expectError({ x: { type: 'text', integer: true } }, /"integer", which only applies to number \/ duration/);
		expectError({ x: { type: 'text', decimals: 2 } }, /"decimals", which only applies/);
		expectError({ x: { type: 'number', decimals: 7 } }, /from 0 to 6/);
		expectError({ x: { type: 'number', decimals: 1.5 } }, /from 0 to 6/);
		expectOk({ x: { type: 'list', items: 'number', decimals: 2 } });
		expectError({ x: { type: 'list', items: 'text', decimals: 2 } }, /"decimals", which only applies/);
	});

	it('constrains duration units', () => {
		expectOk({ x: { type: 'duration', unit: 'minutes' } });
		expectError({ x: { type: 'duration', unit: 'fortnights' } }, /duration "unit" must be one of/);
	});

	it('requires a valid range on estimates and forecasts', () => {
		expectError({ x: { type: 'estimate' } }, /requires both "min" and "max"/);
		expectError({ x: { type: 'estimate', min: 5, max: 5 } }, /less than "max"/);
		expectError({ x: { type: 'estimate', min: 0, max: '2026-01-01' } }, /both be numbers or both be ISO dates/);
		expectError({ x: { type: 'estimate', min: 0, max: 10, step: 0 } }, /positive number/);
		expectError({ x: { type: 'estimate', min: 0, max: 10, step: 'month' } }, /requires a date range/);
		expectError({ x: { type: 'estimate', min: 0, max: 10, scale: 'log' } }, /"min" greater than 0/);
		expectOk({ x: { type: 'estimate', min: '2026-01-01', max: '2027-01-01', step: 'month' } });
		expectOk({ x: { type: 'estimate', min: 1, max: 1000, scale: 'log' } });
	});

	it('rejects range keys outside estimates and forecasts', () => {
		expectError({ x: { type: 'number', min: 0 } }, /"min", which only applies to estimate \/ forecast/);
	});

	it('limits horizon and interval to forecasts', () => {
		expectError({ x: { type: 'estimate', min: 0, max: 1, horizon: 3 } }, /"horizon", which only applies to forecast/);
		expectError({ x: { type: 'forecast', min: 0, max: 1, horizon: 65 } }, /from 1 to 64/);
		expectError({ x: { type: 'forecast', min: 0, max: 1, interval: 'decade' } }, /"interval" must be one of/);
		expectOk({ x: { type: 'forecast', min: 0, max: 100, horizon: 4, interval: 'week' } });
	});

	it('validates null_threshold', () => {
		expectOk({ x: { type: 'text', null_threshold: 1 } });
		expectError({ x: { type: 'text', null_threshold: 0 } }, /greater than 0 and at most 1/);
		expectError({ x: { type: 'text', null_threshold: 1.2 } }, /greater than 0 and at most 1/);
	});
});
