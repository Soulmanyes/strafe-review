// Sort and search for the recording lists (main page sidebar, /compare picker). Needs data.js.

// [key, label, value, direction]: 1 = smallest first, -1 = largest first. A missing value
// (NaN or null) always goes last, and ties go newest first.
const finishTime = (h) => (h.reason === 'finish' && h.runTime ? h.runTime : NaN);
const LIST_SORTS = [
	['newest', 'Newest first', (h) => h.started, -1],
	['oldest', 'Oldest first', (h) => h.started, 1],
	['finish', 'Fastest finish', finishTime, 1],
	['j1land', 'Jump 1 landing speed', (h) => h.j1Land ?? NaN, -1],
	['j1gain', 'Jump 1 speed gained', (h) => (h.j1Land == null || h.j1Takeoff == null ? NaN : h.j1Land - h.j1Takeoff), -1],
	['player', 'Player name', (h) => (isOther(h) ? (h.player || '').toLowerCase() || NaN : NaN), 1]
];

const missing = (v) => v == null || (typeof v === 'number' && !Number.isFinite(v));

// A sorted copy; an unknown key sorts newest first
function sortHeads(hs, key) {
	const [, , get, dir] = LIST_SORTS.find((s) => s[0] === key) || LIST_SORTS[0];
	const vals = new Map(hs.map((h) => [h, get(h)]));
	return [...hs].sort((a, b) => {
		const va = vals.get(a);
		const vb = vals.get(b);
		if (missing(va) !== missing(vb)) return missing(va) ? 1 : -1;
		if (!missing(va)) {
			const c = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
			if (c) return c * dir;
		}
		return (b.started || 0) - (a.started || 0);
	});
}

// Every word of the query must appear in the player, label, map, a tag (own or automatic) or the note.
// Case is ignored; an empty query matches everything.
function matchesSearch(h, q) {
	const words = (q || '').toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const hay = [whoseRun(h), h.player, h.dir, h.map, ...(h.tags || []), ...(h.auto || []), h.note].filter(Boolean).join('\n').toLowerCase();
	return words.every((w) => hay.includes(w));
}

// Fills a sort select and keeps the choice in localStorage under storeKey
function initSort(sel, storeKey, onChange) {
	sel.replaceChildren(...LIST_SORTS.map(([k, label]) => new Option(label, k)));
	const saved = localStorage.getItem(storeKey);
	sel.value = LIST_SORTS.some((s) => s[0] === saved) ? saved : 'newest';
	sel.onchange = () => {
		localStorage.setItem(storeKey, sel.value);
		onChange();
	};
}

if (typeof module !== 'undefined') module.exports = { LIST_SORTS, sortHeads, matchesSearch };
