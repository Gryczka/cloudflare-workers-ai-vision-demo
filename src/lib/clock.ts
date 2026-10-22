/**
 * Clock geometry for the Watch Reader recipe.
 *
 * Pure functions, shared by the server (turning hand angles into a time) and
 * the browser (comparing a reading with the local clock). Angles are degrees
 * clockwise from the dial's 12 o'clock.
 */

export type ClockReading = { hours: number; minutes: number };

/** Smallest absolute difference between two angles, in degrees (0–180). */
export function circularDistance(a: number, b: number): number {
	const d = Math.abs((((a - b) % 360) + 360) % 360);
	return d > 180 ? 360 - d : d;
}

/** Normalize an angle into [0, 360). */
export function normalizeAngle(a: number): number {
	return ((a % 360) + 360) % 360;
}

/** Where the dial's 12 o'clock faces in the image, as an image angle (clockwise from up). */
export const TWELVE_IMAGE_ANGLE = { top: 0, right: 90, bottom: 180, left: 270 } as const;
export type Edge = keyof typeof TWELVE_IMAGE_ANGLE;

/**
 * Where 12 faces, from the crown's position. On almost every watch the crown
 * sits at 3 o'clock, so 12 is a quarter-turn counter-clockwise from it.
 */
export function twelveFromCrown(crown: Edge): Edge {
	return ({ right: 'top', bottom: 'right', left: 'bottom', top: 'left' } as const)[crown];
}

/** Convert an image angle (clockwise from up) to a dial angle (clockwise from 12). */
export function imageToDial(imageAngle: number, twelve: Edge): number {
	return normalizeAngle(imageAngle - TWELVE_IMAGE_ANGLE[twelve]);
}

/**
 * Pick the angle for a hand from Clairic's estimate, using Clef Flash's
 * nearest-position answer (as a dial angle) to settle wrap-around near 12.
 *
 * An estimate straddling 0°/360° can have a meaningless median (e.g. 180°
 * when p10 = 5° and p90 = 355°). The median is kept when it is within 45°
 * (1.5 markers) of the marker; otherwise whichever of p10 / p90 is closest
 * replaces it. A rough marker never nudges a good median. `agrees` is false
 * when nothing lands within 45°.
 */
export function resolveHandAngle(
	estimate: { mid: number; low: number; high: number },
	markerAngle: number | null
): { angle: number; agrees: boolean | null } {
	if (markerAngle === null) return { angle: normalizeAngle(estimate.mid), agrees: null };
	const mid = normalizeAngle(estimate.mid);
	if (circularDistance(mid, markerAngle) <= 45) return { angle: mid, agrees: true };
	let best = mid;
	for (const c of [estimate.low, estimate.high].map(normalizeAngle)) {
		if (circularDistance(c, markerAngle) < circularDistance(best, markerAngle)) best = c;
	}
	return { angle: best, agrees: circularDistance(best, markerAngle) <= 45 };
}

/**
 * Hour (0–11) that best fits an hour-hand angle given the minutes, and how
 * far off the best fit is (0–15°). The hour hand sits at h×30° + m×0.5°.
 */
export function bestHour(hourAngle: number, minutes: number): { hour: number; error: number } {
	let hour = 0;
	let error = Infinity;
	for (let h = 0; h < 12; h += 1) {
		const e = circularDistance(hourAngle, h * 30 + minutes * 0.5);
		if (e < error) {
			hour = h;
			error = e;
		}
	}
	return { hour, error };
}

/**
 * Turn minute- and hour-hand angles into a time.
 *
 * Also tries the hands the other way round. The swap is only taken when the
 * given assignment fits badly (>10° off) and the swapped one fits well (<5°),
 * so ordinary measurement noise does not flip the hands. Geometry can only
 * catch some swaps: the hour hand's offset within the hour is at most 15°,
 * so a swapped reading is often still plausible (2:00 swapped reads 12:10).
 */
export function readAnalog(
	minuteAngle: number,
	hourAngle: number
): ClockReading & { swapped: boolean; fitError: number } {
	const read = (minA: number, hourA: number) => {
		const minutes = Math.round(normalizeAngle(minA) / 6) % 60;
		const { hour, error } = bestHour(normalizeAngle(hourA), minutes);
		return { hours: hour === 0 ? 12 : hour, minutes, fitError: error };
	};
	const normal = read(minuteAngle, hourAngle);
	const swapped = read(hourAngle, minuteAngle);
	if (normal.fitError > 10 && swapped.fitError < 5) return { ...swapped, swapped: true };
	return { ...normal, swapped: false };
}

/** Parse a displayed time such as "14:05", "2:05 PM", or "02:05:33" into 12-hour form. */
export function parseDisplayedTime(value: unknown): ClockReading | null {
	if (typeof value !== 'string') return null;
	const match = /(\d{1,2}):(\d{2})/.exec(value);
	if (!match) return null;
	const h = Number(match[1]);
	const m = Number(match[2]);
	if (h > 23 || m > 59) return null;
	const h12 = h % 12;
	return { hours: h12 === 0 ? 12 : h12, minutes: m };
}

/** Ideal dial angles of the hands for a reading. */
export function handAngles({ hours, minutes }: ClockReading): { minute: number; hour: number } {
	return { minute: minutes * 6, hour: normalizeAngle((hours % 12) * 30 + minutes * 0.5) };
}

/**
 * How well a reading agrees with Clef Flash's rough hand positions (dial
 * angles), in "markers" (30° units): lower is better. Used to judge between
 * Clairic's direct read and the hand-angle geometry.
 */
export function markerDisagreement(
	reading: ClockReading,
	markers: { minute: number | null; hour: number | null }
): number {
	const a = handAngles(reading);
	let score = 0;
	if (markers.minute !== null) score += circularDistance(a.minute, markers.minute) / 30;
	if (markers.hour !== null) score += circularDistance(a.hour, markers.hour) / 30;
	return score;
}

export function formatReading({ hours, minutes }: ClockReading): string {
	return `${hours}:${String(minutes).padStart(2, '0')}`;
}

export type ClockComparison =
	| { kind: 'spot_on'; minutes: number }
	| { kind: 'fast' | 'slow'; minutes: number }
	| { kind: 'timezone'; hours: number; minutes: number }
	| { kind: 'way_off'; minutes: number };

/**
 * Compare a 12-hour reading with the actual local time.
 *
 * Within ±2 min is "spot on". Within ±3 min of a whole-hour offset is a
 * likely time-zone difference ("still on home time?"). Up to 30 min off is
 * fast or slow; beyond that it is "way off" (stopped, never set, or misread).
 */
export function compareToClock(reading: ClockReading, now: { hours: number; minutes: number }): ClockComparison {
	const toMinutes = (h: number, m: number) => ((h % 12) * 60 + m) % 720;
	let diff = toMinutes(reading.hours, reading.minutes) - toMinutes(now.hours, now.minutes);
	if (diff > 360) diff -= 720;
	if (diff <= -360) diff += 720;
	if (Math.abs(diff) <= 2) return { kind: 'spot_on', minutes: diff };
	const hours = Math.round(diff / 60);
	if (hours !== 0 && Math.abs(diff - hours * 60) <= 3) {
		return { kind: 'timezone', hours, minutes: diff };
	}
	if (Math.abs(diff) > 30) return { kind: 'way_off', minutes: diff };
	return { kind: diff > 0 ? 'fast' : 'slow', minutes: Math.abs(diff) };
}

/** One-line description of a comparison for the result card. */
export function describeComparison(c: ClockComparison): string {
	switch (c.kind) {
		case 'spot_on':
			return 'Spot on ✅';
		case 'timezone':
			return `${c.hours > 0 ? '+' : '−'}${Math.abs(c.hours)} h from here. Still on home time? ✈️`;
		case 'fast':
			return `${c.minutes} min fast ⏩`;
		case 'slow':
			return `${c.minutes} min slow ⏪`;
		case 'way_off': {
			const abs = Math.abs(c.minutes);
			return `${Math.floor(abs / 60)} h ${abs % 60} min ${c.minutes > 0 ? 'ahead' : 'behind'}. Stopped, or never set? 🕰️`;
		}
	}
}
