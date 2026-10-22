import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	circularDistance,
	compareToClock,
	describeComparison,
	handAngles,
	imageToDial,
	markerDisagreement,
	parseDisplayedTime,
	readAnalog,
	resolveHandAngle,
	twelveFromCrown,
} from '../lib/clock.ts';

/** Ideal hand angles for a time. */
const angles = (h: number, m: number) => ({ minute: m * 6, hour: (h % 12) * 30 + m * 0.5 });

describe('clock geometry', () => {
	it('measures circular distance across 0°', () => {
		assert.equal(circularDistance(355, 5), 10);
		assert.equal(circularDistance(10, 350), 20);
		assert.equal(circularDistance(90, 270), 180);
	});

	it('reads ideal hand angles back to the same time', () => {
		for (const [h, m] of [
			[12, 0],
			[3, 50],
			[6, 30],
			[9, 5],
			[11, 59],
			[1, 1],
		]) {
			const a = angles(h, m);
			const r = readAnalog(a.minute, a.hour);
			assert.deepEqual([r.hours, r.minutes, r.swapped], [h, m, false], `${h}:${m}`);
		}
	});

	it('reads 3:50 as 3:50 even though the hour hand is nearly on 4', () => {
		const r = readAnalog(300, 115);
		assert.deepEqual([r.hours, r.minutes], [3, 50]);
	});

	it('tolerates a few degrees of measurement noise', () => {
		const r = readAnalog(6 * 20 + 4, 4 * 30 + 10 - 5);
		assert.deepEqual([r.hours, r.minutes], [4, 21]);
	});

	it('swaps the hands only when the given order fits badly and the swap fits well', () => {
		// 4:30 with the hands mixed up: "minute" at 135°, "hour" at 180°.
		// Read as given, 4:23 would need the hour hand at 131.5°, so 180° fits badly (11.5°).
		const r = readAnalog(135, 180);
		assert.equal(r.swapped, true);
		assert.deepEqual([r.hours, r.minutes], [4, 30]);
		// Some swaps are undetectable: 2:00 swapped reads as a plausible 12:10 (only 5° off).
		assert.equal(readAnalog(60, 0).swapped, false);
	});

	it('uses the nearest-marker angle to settle wrap-around near 12', () => {
		// Split estimate around 0°: median is meaningless (180°).
		const split = { mid: 180, low: 355, high: 6 };
		assert.deepEqual(resolveHandAngle(split, 0), { angle: 355, agrees: true });
		assert.deepEqual(resolveHandAngle({ mid: 92, low: 88, high: 97 }, 90), { angle: 92, agrees: true });
		assert.equal(resolveHandAngle({ mid: 200, low: 190, high: 210 }, 90).agrees, false);
		assert.deepEqual(resolveHandAngle({ mid: 370, low: 360, high: 380 }, null), { angle: 10, agrees: null });
	});

	it('rotates image angles onto the dial, using the crown to find 12', () => {
		assert.equal(twelveFromCrown('right'), 'top');
		assert.equal(twelveFromCrown('top'), 'left');
		assert.equal(imageToDial(45, 'left'), 135);
		assert.equal(imageToDial(10, 'right'), 280);
	});

	it('scores readings against rough hand positions', () => {
		assert.deepEqual(handAngles({ hours: 3, minutes: 30 }), { minute: 180, hour: 105 });
		const markers = { minute: 30, hour: 0 };
		assert.ok(
			markerDisagreement({ hours: 12, minutes: 4 }, markers) < markerDisagreement({ hours: 12, minutes: 7 }, markers)
		);
		assert.equal(markerDisagreement({ hours: 1, minutes: 0 }, { minute: null, hour: null }), 0);
	});

	it('parses displayed times into 12-hour form', () => {
		assert.deepEqual(parseDisplayedTime('14:05'), { hours: 2, minutes: 5 });
		assert.deepEqual(parseDisplayedTime('00:30:12'), { hours: 12, minutes: 30 });
		assert.deepEqual(parseDisplayedTime('9:41 AM'), { hours: 9, minutes: 41 });
		assert.equal(parseDisplayedTime('25:00'), null);
		assert.equal(parseDisplayedTime(null), null);
	});

	it('compares a reading with the local clock', () => {
		const now = { hours: 14, minutes: 43 };
		assert.equal(compareToClock({ hours: 2, minutes: 44 }, now).kind, 'spot_on');
		assert.deepEqual(compareToClock({ hours: 2, minutes: 47 }, now), { kind: 'fast', minutes: 4 });
		assert.deepEqual(compareToClock({ hours: 2, minutes: 35 }, now), { kind: 'slow', minutes: 8 });
		assert.deepEqual(compareToClock({ hours: 11, minutes: 44 }, now), { kind: 'timezone', hours: -3, minutes: -179 });
		assert.deepEqual(compareToClock({ hours: 12, minutes: 58 }, { hours: 1, minutes: 2 }), { kind: 'slow', minutes: 4 });
		assert.equal(describeComparison({ kind: 'timezone', hours: -3, minutes: -180 }), '−3 h from here. Still on home time? ✈️');
		assert.equal(describeComparison({ kind: 'fast', minutes: 4 }), '4 min fast ⏩');
		// On a 12-hour dial, 3:50 vs 11:13 is closest going forward: 4 h 37 min ahead.
		assert.deepEqual(compareToClock({ hours: 3, minutes: 50 }, { hours: 11, minutes: 13 }), { kind: 'way_off', minutes: 277 });
		assert.equal(describeComparison({ kind: 'way_off', minutes: 277 }), '4 h 37 min ahead. Stopped, or never set? 🕰️');
		assert.equal(describeComparison({ kind: 'way_off', minutes: -95 }), '1 h 35 min behind. Stopped, or never set? 🕰️');
	});
});
