/**
 * Which Bin? — data for the Decide preset that sorts a held item into
 * compost, recycling, landfill, or special drop-off.
 *
 * One Clef Flash call, four questions: is an item shown, which item, which
 * bin for its main body, and which bin for its lid or cap. Every other part
 * (a cup's cardboard sleeve, a badge's paper insert) has a fixed bin under
 * the rules, so it comes from the table below instead of the model. The
 * model keeps the judgement calls; the obvious parts cost no questions.
 *
 * (An earlier version asked a bin question for every part of every item,
 * 25 questions in one call: about 1.7 s and 6,100 input tokens per frame,
 * with most answers thrown away.)
 *
 * Option descriptions lead with an emoji so the Decide view can show it.
 */

export const BIN_OPTIONS: Record<string, string> = {
	compost: '🌱 compost: food scraps, plain uncoated paper, certified compostables',
	recycle: '♻️ recycling: clean rigid plastic bottles and tubs, cans, glass, paper, flattened cardboard',
	landfill: '🗑️ landfill: plastic-lined paper, film and bags, wrappers, straws, utensils, foam',
	special: '🔋 special drop-off, not any bin: batteries, electronics, phones, chargers',
};

/** Context for every question. */
export const BIN_RULES =
	'Webcam frame. A person may hold up an item they want to throw away. Assume typical US curbside rules. Recycling: clean, empty rigid plastic bottles, jugs, and tubs, metal cans, glass bottles and jars, paper, and flattened cardboard. Compost (where available): food scraps, plain uncoated paper napkins and plates, and certified compostable items. Landfill: plastic-lined paper cups, plastic film and bags, chip and candy wrappers, straws, plastic utensils, and foam. Special drop-off, never a bin: batteries, electronics, phones, and chargers.';

export type BinKey = 'compost' | 'recycle' | 'landfill' | 'special';

/** How a part is sorted: by the model's main-body or lid answer, or a fixed bin. */
export type PartRule = 'main' | 'lid' | BinKey;

/** Items Clef Flash can identify, each with its parts and how each part is sorted. */
export const BIN_ITEMS: Record<string, { emoji: string; looks: string; parts: Record<string, PartRule> }> = {
	coffee_cup: {
		emoji: '☕',
		looks: 'disposable coffee cup, usually with a lid and sleeve',
		parts: { lid: 'lid', cup: 'main', sleeve: 'recycle' },
	},
	plastic_bottle: { emoji: '🧴', looks: 'plastic water or soda bottle', parts: { bottle: 'main', cap: 'lid' } },
	can: { emoji: '🥫', looks: 'aluminum drink can', parts: { can: 'main' } },
	glass_bottle: { emoji: '🍾', looks: 'glass bottle or jar', parts: { bottle: 'main', cap: 'lid' } },
	wrapper: { emoji: '🍫', looks: 'chip bag, candy or granola bar wrapper', parts: { wrapper: 'main' } },
	food_scraps: { emoji: '🍌', looks: 'banana peel, apple core, or leftover food', parts: { scraps: 'main' } },
	napkin: { emoji: '🧻', looks: 'used paper napkin or tissue', parts: { napkin: 'main' } },
	paper_plate: { emoji: '🍽️', looks: 'paper plate or bowl', parts: { plate: 'main' } },
	utensil: { emoji: '🍴', looks: 'plastic fork, knife, spoon, or straw', parts: { utensil: 'main' } },
	takeout_box: { emoji: '🥡', looks: 'takeout or clamshell food container', parts: { container: 'main' } },
	cardboard: { emoji: '📦', looks: 'cardboard box or packaging', parts: { box: 'main' } },
	paper: { emoji: '📄', looks: 'flyer, brochure, or sheet of paper', parts: { paper: 'main' } },
	plastic_bag: { emoji: '🛍️', looks: 'plastic bag or plastic film', parts: { bag: 'main' } },
	badge: {
		emoji: '🪪',
		looks: 'name badge on a lanyard',
		parts: { holder: 'main', insert: 'recycle', lanyard: 'landfill' },
	},
	battery: { emoji: '🔋', looks: 'battery', parts: { battery: 'main' } },
	electronics: { emoji: '📱', looks: 'phone, charger, cable, or earbuds', parts: { device: 'main' } },
	other: { emoji: '❓', looks: 'some other item someone might throw away', parts: { item: 'main' } },
	nothing: { emoji: '🫥', looks: 'nothing held up or shown, just a person or empty hands', parts: {} },
};

type Question =
	| { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
	| { type: 'choice'; instructions: string; criteria: Record<string, string> };

/** The four questions for the single Clef Flash call. */
export function binQuestions(): Record<string, Question> {
	return {
		item_shown: {
			type: 'noul',
			instructions:
				'Is an object someone might throw away (a cup, bottle, can, wrapper, food, paper, and so on) clearly visible close to the camera? A person with empty hands is not an object.',
			criteria: { true: 'an item is shown', false: 'no item is shown' },
		},
		item: {
			type: 'choice',
			instructions: 'What item is being shown or held up to the camera to throw away?',
			criteria: Object.fromEntries(Object.entries(BIN_ITEMS).map(([k, v]) => [k, `${v.emoji} ${v.looks}`])),
		},
		main_bin: {
			type: 'choice',
			instructions: 'Which bin should the main body of the item shown go in?',
			criteria: BIN_OPTIONS,
		},
		lid_bin: {
			type: 'choice',
			instructions: 'If the item shown has a lid or cap, which bin should the lid or cap go in?',
			criteria: BIN_OPTIONS,
		},
	};
}

/**
 * For the Decide view: each item's parts, either answered by a question
 * (`id`) or by a fixed rule (`fixed`, an option description with its emoji).
 */
export function binPartsByItem(): Record<string, { label: string; id?: string; fixed?: string }[]> {
	return Object.fromEntries(
		Object.entries(BIN_ITEMS).map(([item, { parts }]) => [
			item,
			Object.entries(parts).map(([label, rule]) =>
				rule === 'main'
					? { label, id: 'main_bin' }
					: rule === 'lid'
						? { label, id: 'lid_bin' }
						: { label, fixed: BIN_OPTIONS[rule] }
			),
		])
	);
}
