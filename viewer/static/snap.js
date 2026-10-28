'use strict';
// Section pictures: Copy (clipboard) and Save (PNG file) buttons for the Run stats, graph and path
// sections of the main and compare pages. The section is cloned with every computed style written
// inline and canvases swapped for images, wrapped in an SVG foreignObject and drawn onto a canvas,
// so no library is needed. Loaded by index.html and compare.html.

// Header furniture left out of the picture: controls, how-to hints, plain explanations (the ones with
// an id, like #rs-note, carry numbers and stay), the zoom buttons, tooltips and the hover readout.
// The path's Focus / Compare buttons that are on stay, as labels.
const SNAP_DROP = 'button, input, select, label, .hint, .align-tip, .sec-head > .muted:not([id]), .path-zoom, #rs-tip, #readout, .snap-btns';
const SNAP_KEEP = '#path-roles button.on';

function snapCopy(src) {
	if (src.nodeType === Node.TEXT_NODE) return document.createTextNode(src.data);
	if (src.nodeType !== Node.ELEMENT_NODE) return null;
	if (src.matches(SNAP_DROP) && !src.matches(SNAP_KEEP)) return null;
	const cs = getComputedStyle(src);
	if (cs.display === 'none') return null;
	let out;
	if (src.tagName === 'CANVAS') {
		out = document.createElement('img');
		out.src = src.toDataURL();
	} else {
		out = src.cloneNode(false);
		out.removeAttribute('id');
	}
	const kids = [...src.childNodes].map(snapCopy);
	// A header that lost its hints, and its section, would keep the height the hints wrapped to
	const free = src.matches('section, .sec-head') ? ['height', 'block-size'] : [];
	let style = '';
	for (const p of cs) if (!free.includes(p)) style += `${p}:${cs.getPropertyValue(p)};`;
	out.setAttribute('style', style);
	out.append(...kids.filter(Boolean));
	return out;
}

// parts: elements (cloned as they look now) or strings (a bold caption line), stacked top to bottom.
// Resolves to a PNG blob at the screen's pixel ratio, on the page background.
async function snapRender(parts) {
	const pad = 14;
	const root = getComputedStyle(document.body);
	const bg = root.getPropertyValue('background-color');
	const wrap = document.createElement('div');
	const w = Math.ceil(Math.max(...parts.filter((p) => typeof p !== 'string').map((p) => p.getBoundingClientRect().width))) + 2 * pad;
	wrap.setAttribute('style', `box-sizing:border-box;width:${w}px;padding:${pad}px;display:flex;flex-direction:column;gap:10px;background:${bg};color:${root.getPropertyValue('color')};font:${root.getPropertyValue('font')};position:fixed;left:-100000px;top:0`);
	for (const p of parts) {
		if (typeof p === 'string') {
			const t = document.createElement('div');
			t.setAttribute('style', 'font-weight:700;font-size:15px');
			t.textContent = p;
			wrap.append(t);
			continue;
		}
		const c = snapCopy(p);
		if (!c) continue;
		c.style.margin = '0';
		c.style.flex = 'none';
		wrap.append(c);
	}
	document.body.append(wrap);
	const h = Math.ceil(wrap.getBoundingClientRect().height);
	wrap.remove();
	wrap.style.position = 'static';
	const s = window.devicePixelRatio || 1;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w * s)}" height="${Math.ceil(h * s)}" viewBox="0 0 ${w} ${h}"><foreignObject x="0" y="0" width="${w}" height="${h}">${new XMLSerializer().serializeToString(wrap)}</foreignObject></svg>`;
	const img = new Image();
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	await img.decode();
	const cv = document.createElement('canvas');
	cv.width = Math.ceil(w * s);
	cv.height = Math.ceil(h * s);
	const g = cv.getContext('2d');
	g.fillStyle = bg;
	g.fillRect(0, 0, cv.width, cv.height);
	g.drawImage(img, 0, 0, cv.width, cv.height);
	return new Promise((ok, fail) => cv.toBlob((b) => (b ? ok(b) : fail(new Error('no image'))), 'image/png'));
}

// "surf_artois: b1 · Soulman" -> "surf_artois-b1_Soulman"
function snapFileName(name) {
	return `${name.replace(/[:\s·]+/g, (m) => (m.includes('·') ? '_' : '-')).replace(/[^\w.-]+/g, '').replace(/^[-_]+|[-_]+$/g, '') || 'strafe-review'}.png`;
}

function snapFlash(b, text) {
	clearTimeout(b.snapTimer);
	b.textContent = text;
	b.snapTimer = setTimeout(() => (b.textContent = b.dataset.label), 1600);
}

// A Copy and a Save button. parts() gives what snapRender() draws, or null when the section is empty;
// name() gives the file name without .png. Returns the button box for the caller to place.
function snapButtons(what, parts, name) {
	const box = document.createElement('span');
	box.className = 'snap-btns';
	const mk = (label, title) => {
		const b = document.createElement('button');
		b.textContent = b.dataset.label = label;
		b.title = title;
		box.append(b);
		return b;
	};
	const copy = mk('Copy', `Copy the ${what} to the clipboard as a picture`);
	const save = mk('Save', `Save the ${what} as a PNG file`);
	copy.onclick = () => {
		const ps = parts();
		if (!ps) return snapFlash(copy, 'Nothing to copy');
		if (!window.ClipboardItem || !navigator.clipboard?.write) return snapFlash(copy, 'No clipboard, use Save');
		// The write starts inside the click, with the picture still being drawn, so the browser allows it
		navigator.clipboard.write([new ClipboardItem({ 'image/png': snapRender(ps) })]).then(
			() => snapFlash(copy, 'Copied'),
			(e) => {
				console.error('snap copy', e);
				snapFlash(copy, 'Copy failed, use Save');
			}
		);
	};
	save.onclick = async () => {
		const ps = parts();
		if (!ps) return snapFlash(save, 'Nothing to save');
		try {
			const a = document.createElement('a');
			a.href = URL.createObjectURL(await snapRender(ps));
			a.download = snapFileName(name());
			a.click();
			setTimeout(() => URL.revokeObjectURL(a.href), 5000);
			snapFlash(save, 'Saved');
		} catch (e) {
			console.error('snap save', e);
			snapFlash(save, 'Save failed');
		}
	};
	return box;
}
