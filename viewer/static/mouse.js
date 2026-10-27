'use strict';
// Strafe Review: turning in mouse terms. Degrees of yaw become centimetres of mouse movement:
//   cm = deg * 2.54 / (dpi * sensitivity * m_yaw)
// (the same formula as Momentum's mouse settings page). sensitivity and m_yaw come from the
// attempt's head (`mouse`, recorded since 2026-10-27) or, for older attempts, from the game's
// current config.cfg (/api/mouse). DPI is typed in once in the viewer; Momentum's own stored DPI,
// if the recorder found one, only pre-fills it.
// Uses strafing() and turnBtn() from checks.js.

const MOUSE_KEY = 'strafe-review-mouse';

function loadDpi() {
	const v = Number.parseFloat(localStorage.getItem(MOUSE_KEY) ?? '');
	return Number.isFinite(v) && v > 0 ? v : null;
}

function saveDpi(v) {
	if (Number.isFinite(v) && v > 0) localStorage.setItem(MOUSE_KEY, String(v));
	else localStorage.removeItem(MOUSE_KEY);
}

// DPI to fill the box with when the viewer has none: the newest one Momentum stored
function dpiFromHeads(heads) {
	for (const h of heads) if (h.mouse && h.mouse.dpi > 0) return h.mouse.dpi;
	return null;
}

// Mouse settings for one attempt: { cmPerDeg, sens, yaw, dpi, recorded }, or null without a DPI or
// a sens. recorded = false means the game's current sens was used, not the one the attempt had.
function mouseFor(h, current, dpi) {
	if (!(dpi > 0)) return null;
	const m = h && h.mouse && h.mouse.sensitivity > 0 && h.mouse.m_yaw > 0 ? h.mouse : null;
	const src = m || (current && current.sensitivity > 0 && current.m_yaw > 0 ? current : null);
	if (!src) return null;
	return {
		cmPerDeg: 2.54 / (dpi * src.sensitivity * src.m_yaw),
		sens: src.sensitivity,
		yaw: src.m_yaw,
		dpi,
		recorded: !!m
	};
}

// Mouse turn of one strafe (checks.js strafesOf()) in degrees: `did` is the net turn in the strafe's
// direction, `opt` the optimal turn over the same ticks. Ticks with +left/+right held are left out
// (they turn at cl_yawspeed, not by mouse), so are missed ticks and rows the checks don't judge.
function strafeTurn(d, st) {
	let did = 0;
	let opt = 0;
	let ticks = 0;
	for (let i = st.i0; i <= st.i1; i++) {
		if (turnBtn(d, i) || !strafing(d, i) || !Number.isFinite(d.yawd[i]) || !Number.isFinite(d.opt[i])) continue;
		did += d.yawd[i] * st.dir;
		opt += d.opt[i];
		ticks++;
	}
	return { did, opt, ticks };
}

// "4.1 cm" style, 1 decimal
const cmText = (deg, m) => `${(deg * m.cmPerDeg).toFixed(1)} cm`;
// Mouse speed for a turn of deg degrees per tick
const cmPerSec = (degPerTick, interval, m) => (degPerTick * m.cmPerDeg) / interval;

if (typeof module !== 'undefined') module.exports = { MOUSE_KEY, mouseFor, strafeTurn, cmText, cmPerSec, dpiFromHeads };
