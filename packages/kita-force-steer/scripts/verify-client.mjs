/**
 * Offline verification for the kita-force-steer client half.
 *
 * Loads lib/client.js through a stubbed ModuleLoader (no browser, no dsh), then
 * asserts the slot registration, the cancel/steer verb wiring, and the busy
 * submission gesture policy. Run: node scripts/verify-client.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

let failures = 0;
function check(name, condition, detail) {
	if (condition) {
		console.log('  ok   ' + name);
		return;
	}
	failures += 1;
	console.log('  FAIL ' + name + (detail === undefined ? '' : ' -> ' + detail));
}

// ---- 1. module form -----------------------------------------------------------------
let definition = null;
const windowStub = { __ModuleLoader__: { load: (d) => { definition = d; } } };
new Function('window', source)(windowStub);
check('module form: window.__ModuleLoader__.load called', definition !== null);
check('module id is kita-force-steer', definition?.id === 'kita-force-steer');

// ---- 2. browser stubs ---------------------------------------------------------------
const listeners = { keydown: [], click: [] };
let menuOpen = false;
globalThis.document = {
	addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
	removeEventListener(type, fn) {
		const list = listeners[type] || [];
		const index = list.indexOf(fn);
		if (index >= 0) list.splice(index, 1);
	},
	querySelector() { return menuOpen ? { role: 'listbox' } : null; }
};

const reactStub = {
	createElement: (type, props, children) => ({ type, props, children }),
	useRef: (initial) => ({ current: initial }),
	useCallback: (fn) => fn,
	useEffect: (fn) => { const cleanup = fn(); return cleanup; }
};
const mod = definition.factory((name) => {
	if (name === 'react') return reactStub;
	throw new Error('unexpected require: ' + name);
});
check('exports.apply is a function', typeof mod.apply === 'function');
check('exports.inject declares slots + sessions',
	Array.isArray(mod.inject) && mod.inject.includes('slots') && mod.inject.includes('sessions'),
	JSON.stringify(mod.inject));

// ---- 3. fake client services --------------------------------------------------------
const calls = [];
function makeSession() {
	return {
		beginSubmission(input) {
			calls.push({ kind: 'beginSubmission', input });
			return { requestId: 'req-1', abandon: () => calls.push({ kind: 'abandon' }) };
		},
		async prompt(content, mode, signal, requestId) {
			calls.push({ kind: 'prompt', content, mode, requestId });
			return { ok: true, value: { accepted: true } };
		},
		async cancel() {
			calls.push({ kind: 'cancel' });
			return { ok: true, value: { accepted: true } };
		}
	};
}
const session = makeSession();
let registration = null;
const ctx = {
	slots: {
		inject(key, callback) { calls.push({ kind: 'inject', key }); callback(); },
		register(options, component) { registration = { options, component }; return () => {}; }
	},
	sessions: { binding: (id) => (id === 'S1' ? { session } : undefined) }
};

mod.apply(ctx);
check('registered into conversation.input.right', registration?.options?.name === 'conversation.input.right',
	registration?.options?.name);
check('registration id is kita-force-steer', registration?.options?.id === 'kita-force-steer');
const injected = registration?.options?.inject?.();
check('inject face exposes cancel + send',
	typeof injected?.forceSteer?.cancel === 'function' && typeof injected?.forceSteer?.send === 'function');

// ---- 4. business verbs --------------------------------------------------------------
calls.length = 0;
injected.forceSteer.cancel('S1');
check('cancel reaches SessionFace.cancel()', calls.some((c) => c.kind === 'cancel'));
calls.length = 0;
injected.forceSteer.cancel('missing');
check('cancel on an unmaterialized session is a no-op', calls.length === 0);

calls.length = 0;
const queued = await injected.forceSteer.send('S1', 'redirect now', 'queue');
const begin = calls.find((c) => c.kind === 'beginSubmission');
const prompt = calls.find((c) => c.kind === 'prompt');
check('send returns true when the Host accepts', queued === true);
check('send registers a local echo with the requested mode',
	begin?.input?.mode === 'queue' && begin?.input?.text === 'redirect now', JSON.stringify(begin?.input));
check('send prompts with the requested mode and the echo identity',
	prompt?.mode === 'queue' && prompt?.requestId === 'req-1' &&
	Array.isArray(prompt?.content) && prompt.content[0]?.type === 'text' && prompt.content[0]?.text === 'redirect now');
check('send passes an explicit steer mode through too (not used by the gesture path)',
	(await (async () => { calls.length = 0; const ok = await injected.forceSteer.send('S1', 'x', 'steer'); return ok && calls.find((c) => c.kind === 'prompt')?.mode === 'steer'; })()) === true);
check('send on an unmaterialized session returns false',
	(await injected.forceSteer.send('missing', 'x', 'queue')) === false);

// ---- 5. busy submission gesture policy ----------------------------------------------
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function mountGesture(overrides) {
	listeners.keydown.length = 0;
	listeners.click.length = 0;
	const props = {
		sessionId: 'S1',
		forceSteer: injected.forceSteer,
		inputActions: {
			setDraft: (text) => calls.push({ kind: 'setDraft', text }),
			submit: () => calls.push({ kind: 'submit' })
		},
		useInput: (selector) => selector({ draft: '', phase: 'plain', attachmentIds: [] }),
		useSession: (selector) => selector({ running: true, removed: false }),
		...overrides
	};
	return registration.component(props);
}

function keyEvent(overrides) {
	const event = {
		key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false,
		defaultPrevented: false, propagationStopped: false, immediateStopped: false,
		preventDefault() { this.defaultPrevented = true; },
		stopPropagation() { this.propagationStopped = true; },
		stopImmediatePropagation() { this.immediateStopped = true; }
	};
	return Object.assign(event, overrides);
}
function clickEvent(kind) {
	const card = { contains: () => true };
	const primary = { kind: 'primary' };
	return {
		defaultPrevented: false, propagationStopped: false,
		preventDefault() { this.defaultPrevented = true; },
		stopPropagation() { this.propagationStopped = true; },
		stopImmediatePropagation() {},
		target: {
			closest(selector) {
				if (selector === '[data-composer-card]') return card;
				if (selector === '[class*="_primary"]') return kind === 'send' ? primary : null;
				return null;
			}
		}
	};
}
function dispatch(type, event) {
	for (const fn of listeners[type]) fn(event);
}
const withDraft = (draft, attachmentIds = []) => (selector) => selector({ draft, phase: 'plain', attachmentIds });

// headless: no DOM of its own
check('renders nothing (headless interceptor)', mountGesture({ useInput: withDraft('hi') }) === null);

// idle session -> the official path keeps the gesture
menuOpen = false;
mountGesture({ useSession: (selector) => selector({ running: false, removed: false }), useInput: withDraft('hi') });
calls.length = 0;
let event = keyEvent({});
dispatch('keydown', event);
check('idle session: Enter is not swallowed', event.defaultPrevented === false);
check('idle session: Enter does not interrupt', !calls.some((c) => c.kind === 'cancel'));

// running + text draft -> interrupt first, then hand off to the OFFICIAL machine.
// The clock is frozen so the settle wait resolves on its first poll instead of
// costing CANCEL_SETTLE_TIMEOUT_MS per case.
const realNow = Date.now;
function freezeClock() { let t = 0; Date.now = () => (t += 5000); }
function restoreClock() { Date.now = realNow; }

mountGesture({ useInput: withDraft('switch to plan B') });
calls.length = 0;
event = keyEvent({});
dispatch('keydown', event);
await tick();
const order = calls.map((c) => c.kind);
check('busy Enter: gesture swallowed at the document boundary',
	event.defaultPrevented === true && event.propagationStopped === true && event.immediateStopped === true);
check('busy Enter: cancel precedes the hand-off',
	order.includes('cancel') && order.includes('prompt') && order.indexOf('cancel') < order.indexOf('prompt'),
	order.join(','));
check('busy Enter: plain text goes out as QUEUE, never as steer (the steer/cancel race drops the message)',
	calls.find((c) => c.kind === 'prompt')?.mode === 'queue', order.join(','));
check('busy Enter: draft cleared after acceptance', calls.some((c) => c.kind === 'setDraft' && c.text === ''));

// running + attachments -> official machine, handed over only after the settle
freezeClock();
mountGesture({ useInput: withDraft('', ['a']) });
calls.length = 0;
event = keyEvent({});
dispatch('keydown', event);
const beforeSettle = calls.map((c) => c.kind);
check('attachments: only the cancel is issued synchronously',
	beforeSettle.includes('cancel') && !beforeSettle.includes('submit'), beforeSettle.join(','));
await tick();
check('attachments: interrupts then delegates to official submit()',
	calls.some((c) => c.kind === 'cancel') && calls.some((c) => c.kind === 'submit'));
restoreClock();

// releases: Shift/accelerated/IME, open candidate menu, empty draft, busy machine
mountGesture({ useInput: withDraft('hi') });
for (const [name, overrides] of [
	['Shift+Enter is a line break', { shiftKey: true }],
	['Cmd/Ctrl+Enter keeps the official opposite mode', { ctrlKey: true }],
	['Meta+Enter keeps the official opposite mode', { metaKey: true }],
	['IME composition is left alone', { isComposing: true }],
	['other keys are left alone', { key: 'a' }]
]) {
	calls.length = 0;
	event = keyEvent(overrides);
	dispatch('keydown', event);
	check(name, event.defaultPrevented === false && calls.length === 0);
}
menuOpen = true;
calls.length = 0;
event = keyEvent({});
dispatch('keydown', event);
check('open slash/at menu owns Enter', event.defaultPrevented === false && calls.length === 0);
menuOpen = false;
mountGesture({ useInput: withDraft('') });
calls.length = 0;
event = keyEvent({});
dispatch('keydown', event);
check('empty draft never interrupts', event.defaultPrevented === false && calls.length === 0);
mountGesture({ useInput: (selector) => selector({ draft: 'x', phase: 'submitting', attachmentIds: [] }) });
calls.length = 0;
event = keyEvent({});
dispatch('keydown', event);
check('submit machine busy: gesture left to the official bar', event.defaultPrevented === false && calls.length === 0);
mountGesture({ useSession: (selector) => selector({ running: true, removed: true }), useInput: withDraft('hi') });
calls.length = 0;
event = keyEvent({});
dispatch('keydown', event);
check('removed session: gesture left alone', event.defaultPrevented === false && calls.length === 0);

// the primary Send button shares the plain-Enter semantics
mountGesture({ useInput: withDraft('ship it') });
calls.length = 0;
let click = clickEvent('send');
dispatch('click', click);
await tick();
check('Send button: click intercepted', click.defaultPrevented === true && click.propagationStopped === true);
check('Send button: interrupts then hands off as queue',
	calls.some((c) => c.kind === 'cancel') && calls.find((c) => c.kind === 'prompt')?.mode === 'queue');
calls.length = 0;
click = clickEvent('other');
dispatch('click', click);
check('other composer controls are untouched', click.defaultPrevented === false && calls.length === 0);
calls.length = 0;
click = { ...clickEvent('send'), target: null };
dispatch('click', click);
check('a click without a DOM target is ignored', click.defaultPrevented === false && calls.length === 0);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
