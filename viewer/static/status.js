// Status box (main page, while no attempts are saved): what the program sees of the setup, so a
// "nothing shows up" report says where it stops: no log (game not restarted), a log without recorder
// lines (recorder not loading or no run yet), or recorder lines without saved attempts.
'use strict';

let statusTimer = null;

function ago(t, now) {
	const s = Math.max(0, Math.round(now - t));
	return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

function statusRows(st) {
	const c = st.collector, log = st.log, rows = [];
	const add = (ok, label, text) => rows.push([ok, label, text]);
	add(!!st.game, 'Game folder', st.game || 'Momentum Mod not found in any Steam library');
	add(st.recorder, 'Recorder', st.recorder ? 'installed (custom\\0-strafe-review)' : 'not installed: start strafe-review again');
	add(st.autoexecBlock, 'autoexec.cfg', st.autoexecBlock ? 'has the strafe-review block' : 'block missing: start strafe-review again');
	if (!st.collecting) add(false, 'Collector', 'off (started with --no-collect)');
	else if (!log.exists) add(false, 'Game log', `${log.path} doesn't exist yet. Restart Momentum, so it reads autoexec.cfg and writes this log.`);
	else add(true, 'Game log', `${log.path}: ${(log.size / 1024).toFixed(0)} KB, last written ${ago(log.modified, st.now)}`);
	if (st.collecting && log.exists) {
		add(c.lines > 0, 'Lines read', `${c.lines}${c.lastLine ? `, last ${ago(c.lastLine, st.now)}` : ''}`);
		add(!!c.lastLoad, 'Recorder loaded', c.lastLoad
			? 'yes (its start line is in the log)'
			: 'not seen in the log. It writes a line when the game loads the HUD; none means the game doesn\'t load it. Another HUD mod in custom\\ can hide it: start strafe-review again, then restart the game.');
		add(c.recorder > 0, 'Recorder lines', c.recorder
			? `${c.recorder}, last ${ago(c.lastRecorder, st.now)}`
			: 'none yet. Attempts come when a run ends (finish, reset or fail) after the timer started.');
	}
	add(st.saved > 0, 'Attempts saved', `${st.saved}${c.dropped ? ` (${c.dropped} incomplete, dropped)` : ''} in ${st.store}`);
	if (st.error) add(false, 'Collector error', `${st.error.text} (${ago(st.error.time, st.now)})`);
	return rows;
}

async function showStatus(box) {
	let st;
	try {
		st = await (await fetch('/api/status')).json();
	} catch {
		return;
	}
	if (!box.isConnected || box.querySelector('.status-box') === null && box.childElementCount) return;
	const div = box.querySelector('.status-box') || box.appendChild(document.createElement('div'));
	div.className = 'status-box';
	div.replaceChildren();
	const h = div.appendChild(document.createElement('div'));
	h.className = 'status-head';
	h.textContent = 'Setup check (updates by itself)';
	for (const [ok, label, text] of statusRows(st)) {
		const row = div.appendChild(document.createElement('div'));
		row.className = `status-row ${ok ? 'ok' : 'bad'}`;
		row.append(Object.assign(document.createElement('b'), {textContent: `${ok ? '✓' : '✗'} ${label}`}), ` ${text}`);
	}
	clearTimeout(statusTimer);
	statusTimer = setTimeout(() => showStatus(box), 3000);
}
