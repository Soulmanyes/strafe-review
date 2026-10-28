'use strict';
// Strafe Review: tags worked out from the recordings themselves, never stored. Own attempts only.
//   "new sens": attempts at a sens never used before, for AUTO_TAG_HOURS from the first one, until
//               the sens changes again. A sens = sensitivity, m_yaw and Momentum's stored DPI (an
//               attempt without a stored DPI keeps the one before it).
//   "old sens": the same, after going back to a sens used before, but only when at least `oldMin`
//               attempts at other sens values came in between (a short trial and back gets nothing).
//   "PB":       a finish faster than every earlier finish on the same map, tickrate, style and track.
// Attempts recorded before the recorder stamped `mouse` (2026-10-27) get no sens tags; the first
// stamped sens is the baseline and is never tagged.

const AUTO_TAGS_KEY = 'strafe-review-autotags'; // { oldMin }
const AUTO_TAG_HOURS = 24;
const AUTO_OLD_MIN = 75;

function loadAutoOpts() {
	let o = {};
	try {
		o = JSON.parse(localStorage.getItem(AUTO_TAGS_KEY)) || {};
	} catch {}
	return { oldMin: Number.isInteger(o.oldMin) && o.oldMin >= 0 ? o.oldMin : AUTO_OLD_MIN };
}

function saveAutoOpts(o) {
	if (o.oldMin === AUTO_OLD_MIN) localStorage.removeItem(AUTO_TAGS_KEY);
	else localStorage.setItem(AUTO_TAGS_KEY, JSON.stringify({ oldMin: o.oldMin }));
}

// Sets h.auto (array of tag names) on every head in the list
function autoTags(list, opts = loadAutoOpts()) {
	for (const h of list) h.auto = [];
	const own = list.filter((h) => h.label !== 'replay').sort((a, b) => a.started - b.started);

	let dpi = null;
	let cur = null; // the sens key in use
	let tag = null; // its tag, or null
	let since = 0; // when that tag's window started
	const lastAt = new Map(); // sens key -> index of its latest attempt among stamped ones
	let n = 0;
	for (const h of own) {
		const m = h.mouse;
		if (!m || !(m.sensitivity > 0) || !(m.m_yaw > 0)) continue;
		if (m.dpi > 0) dpi = m.dpi;
		const key = `${m.sensitivity.toFixed(4)}|${m.m_yaw.toFixed(5)}|${dpi ?? '?'}`;
		if (key !== cur) {
			if (cur === null) tag = null;
			else if (!lastAt.has(key)) tag = 'new sens';
			else tag = n - lastAt.get(key) - 1 >= opts.oldMin ? 'old sens' : null;
			since = h.started;
			cur = key;
		}
		if (tag && h.started - since < AUTO_TAG_HOURS * 3600e3) h.auto.push(tag);
		lastAt.set(key, n++);
	}

	const best = new Map(); // "<dir>|<interval>|<style>|<track>" -> fastest run time so far
	for (const h of own) {
		if (h.reason !== 'finish' || h.practice || !(h.runTime > 0)) continue;
		const t = h.track || {};
		const k = `${h.dir}|${h.interval}|${h.style ?? 0}|${t.type ?? 0}/${t.number ?? 0}`;
		if (!best.has(k) || h.runTime < best.get(k)) {
			best.set(k, h.runTime);
			h.auto.push('PB');
		}
	}
}

// Own tags and automatic ones together, for filters
const allTags = (h) => [...new Set([...(h.tags || []), ...(h.auto || [])])];

if (typeof module !== 'undefined') module.exports = { autoTags, allTags, AUTO_OLD_MIN, AUTO_TAG_HOURS };
