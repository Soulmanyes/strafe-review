// "Show the jump-1 line in game" (main page sidebar foot). Off by default, so it never covers someone's
// own HUD; the server writes the choice into the installed recorder.
'use strict';

(async () => {
	const foot = document.getElementById('ingame');
	if (!foot) return;
	let st;
	try {
		st = await (await fetch('/api/settings')).json();
	} catch {
		return;
	}
	const box = Object.assign(document.createElement('input'), {type: 'checkbox', checked: st.inGameLine});
	const note = Object.assign(document.createElement('div'), {className: 'muted'});
	const label = document.createElement('label');
	label.className = 'upd-auto';
	label.title = 'After jump 1 lands: landing speed, gain %, gain per strafe and the biggest mistake, at the top middle of the screen';
	label.append(box, ' Show the jump-1 line in game');
	box.addEventListener('change', async () => {
		const res = await fetch('/api/settings', {
			method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({inGameLine: box.checked})
		});
		const got = res.ok ? await res.json() : null;
		note.textContent = !got ? 'Couldn\'t save it.'
			: got.applied ? 'Type panorama_reload in the game console, or restart the game, to apply it.'
			: 'Saved. The recorder isn\'t installed yet; it applies once it is.';
	});
	foot.replaceChildren(label, note);
})();
