// Checks the viewer's CS:S gain against a real server's SSJ: runs the shipped findJumps() / ssjJump() on a
// recording made from a CS:S demo (viewer/css_demo.py) and compares each jump with the [SSJ] chat line.
// Jumps are paired by takeoff speed (SSJ's "Speed:"), and a jump's gain is on the line after its own.
// Each jump is scored twice: with the demo's wish velocity (wx/wy) and without it (velocity + angles, as
// for Momentum recordings made before wishVel was saved).
//
//   node viewer/check_css_ssj.js OUT.json CONSOLE.txt
const fs = require('fs');
const data = require('./static/data.js');

const [file, consoleFile] = process.argv.slice(2);
if (!file || !consoleFile) {
	console.log('usage: node viewer/check_css_ssj.js OUT.json CONSOLE.txt');
	process.exit(1);
}
const lines = fs
	.readFileSync(consoleFile, 'utf8')
	.split('\n')
	.filter((l) => l.startsWith('[SSJ]'))
	.map((l) => {
		const g = (k) => {
			const m = l.match(new RegExp(`${k}: (-?[\\d.]+)`));
			return m ? +m[1] : null;
		};
		return { j: g('Jump'), speed: g('Speed'), gain: g('Gain') };
	});

function score(withWish) {
	const a = JSON.parse(fs.readFileSync(file));
	if (!withWish) {
		const keep = a.cols.indexOf('wx');
		a.cols = a.cols.slice(0, keep);
		a.rows = a.rows
			.split(';')
			.map((r) => r.split(',').slice(0, keep).join(','))
			.join(';');
	}
	const d = data.parse(a);
	return { d, jumps: data.findJumps(d, a.preRows).jumps };
}
const W = score(true);
const O = score(false);
let used = 0;
let n = 0;
let okW = 0;
let okO = 0;
W.jumps.forEach((j, k) => {
	const sp = W.d.speed[j.s];
	const li = lines.findIndex((s, i) => i >= used && s.speed !== null && Math.abs(s.speed - sp) <= 3);
	if (li < 0) return;
	used = li + 1;
	const nx = lines[li + 1];
	if (!nx || nx.j !== lines[li].j + 1 || nx.gain === null) return;
	n++;
	const w = j.ssj;
	const o = O.jumps[k] ? O.jumps[k].ssj : NaN;
	// SSJ prints 2 decimals cut off, so 0.01 either way is a match
	const hitW = Math.abs(w - nx.gain) < 0.015;
	const hitO = Math.abs(o - nx.gain) < 0.015;
	okW += hitW;
	okO += hitO;
	console.log(
		`J:${nx.j} takeoff ${sp.toFixed(0)}  SSJ ${nx.gain.toFixed(2)}  wish ${w.toFixed(2)}${hitW ? '' : ' *'}  old ${o.toFixed(2)}${hitO ? '' : ' *'}`
	);
});
const fit = data.angleFit(O.d);
console.log(`matched to 0.01: wish ${okW}/${n}, old ${okO}/${n} (angle fit lag ${fit.lag}, err ${fit.err.toFixed(3)})`);
