// Updates (every page): a banner when a newer release is out, with Update when this copy can install
// it (the Windows exe) or how to get it (the repo). On the main page the sidebar foot also shows the
// version, Check for updates and the "Install updates automatically" switch (off by default).
'use strict';

const updPost = (action, body = {}) => fetch(`/api/update/${action}`, {
	method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
});

function updEl(tag, props = {}, ...kids) {
	const el = Object.assign(document.createElement(tag), props);
	el.append(...kids);
	return el;
}

async function updInstall(btn, info) {
	btn.disabled = true;
	btn.textContent = 'Updating…';
	const res = await updPost('install');
	if (!res.ok) {
		alert(`The update didn't work: ${await res.text()}`);
		return updRender();
	}
	// the program starts again on the new version; reload once it answers with it
	const banner = document.getElementById('upd-banner');
	if (banner) banner.firstChild.textContent = `Installed ${info.latest.tag}. Strafe Review is starting again…`;
	for (let i = 0; i < 120; i++) {
		await new Promise((r) => setTimeout(r, 1000));
		try {
			const now = await (await fetch('/api/update')).json();
			if (now.version !== info.version) return location.reload();
		} catch { /* still starting */ }
	}
	alert('Strafe Review didn\'t come back after the update. Start it again by hand.');
}

function updBanner(info) {
	document.getElementById('upd-banner')?.remove();
	if (!info.latest) return;
	const l = info.latest;
	const text = updEl('span', {textContent: `Strafe Review ${l.tag} is available (you have ${info.version}). `});
	const bar = updEl('div', {id: 'upd-banner'}, text);
	if (info.canInstall) {
		const btn = updEl('button', {textContent: 'Update', className: 'upd-go'});
		btn.addEventListener('click', () => updInstall(btn, info));
		bar.append(btn);
	} else {
		text.textContent += 'This copy runs from the repo: update it with git pull. ';
	}
	if (l.url) bar.append(updEl('a', {href: l.url, target: '_blank', rel: 'noopener', textContent: 'What\'s new'}));
	if (info.failed === l.tag) bar.append(updEl('span', {className: 'muted', textContent: ' (installing it failed before)'}));
	const close = updEl('button', {textContent: '×', title: 'Hide until the page is opened again', className: 'upd-close'});
	close.addEventListener('click', () => bar.remove());
	bar.append(close);
	document.body.append(bar);
}

function updFoot(info) {
	const foot = document.getElementById('updates');
	if (!foot) return;
	const check = updEl('button', {textContent: 'Check for updates'});
	check.addEventListener('click', async () => {
		check.disabled = true;
		check.textContent = 'Checking…';
		await updPost('check');
		updRender();
	});
	const status = info.error ? 'GitHub couldn\'t be reached' : info.latest ? `${info.latest.tag} is available` : info.checked ? 'up to date' : '';
	const kids = [updEl('div', {className: 'upd-line'}, updEl('span', {className: 'muted', textContent: `Version ${info.version}${status ? ` · ${status}` : ''}`}), check)];
	if (info.canInstall) {
		const box = updEl('input', {type: 'checkbox', checked: info.auto});
		box.addEventListener('change', async () => {
			await updPost('auto', {auto: box.checked});
			updRender();
		});
		kids.push(updEl('label', {className: 'upd-auto', title: 'Off: a banner offers each new version. On: it installs by itself and starts again.'},
			box, ' Install updates automatically'));
	}
	foot.replaceChildren(...kids);
}

async function updRender() {
	let info;
	try {
		info = await (await fetch('/api/update')).json();
	} catch {
		return;
	}
	updBanner(info);
	updFoot(info);
}

updRender();
setInterval(updRender, 10 * 60 * 1000); // the server looks for updates by itself; show what it found
