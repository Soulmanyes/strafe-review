// Stop button (every page): ends the Strafe Review program, which otherwise keeps running after the
// game quits so the page stays available. It starts again with the game or by hand.
'use strict';

for (const btn of document.querySelectorAll('button.stop')) {
	btn.title = 'Stop Strafe Review. Attempts you play while it is stopped are picked up from the game\'s log when it starts again (with the game, or by hand).';
	btn.addEventListener('click', async () => {
		if (!confirm('Stop Strafe Review? This page stops working until it starts again.')) return;
		try {
			const res = await fetch('/api/stop', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
		} catch (e) {
			alert(`Could not stop it: ${e.message}`);
			return;
		}
		document.body.className = 'stopped';
		document.body.innerHTML = '<div class="stopped-msg"><h1>Strafe Review stopped</h1>'
			+ '<p>It starts again when you start the game, or by hand. You can close this tab.</p></div>';
	});
}
