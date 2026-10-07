/**
 * Offline verification for the kita-force-steer client half.
 *
 * Loads lib/client.js through a stubbed ModuleLoader (no browser, no dsh), then
 * asserts the slot registration, the cancel/steer verb wiring, and the button's
 * interaction policy. Run: node scripts/verify-client.mjs
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

const reactStub = {
	createElement: (type, props, children) => ({ type, props, children }),
	useRef: (initial) => ({ current: initial }),
	useCallback: (fn) => fn
};
const mod = definition.factory((name) => {
	if (name === 'react') return reactStub;
	throw new Error('unexpected require: ' + name);
});
check('exports.apply is a function', typeof mod.apply === 'function');
check('exports.inject declares slots + sessions',
	Array.isArray(mod.inject) && mod.inject.includes('slots') && mod.inject.includes('sessions'),
	JSON.stringify(mod.inject));

// ---- 2. fake client services --------------------------------------------------------
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
check('inject face exposes cancel + steer',
	typeof injected?.forceSteer?.cancel === 'function' && typeof injected?.forceSteer?.steer === 'function');

// ---- 3. business verbs --------------------------------------------------------------
calls.length = 0;
injected.forceSteer.cancel('S1');
check('cancel reaches SessionFace.cancel()', calls.some((c) => c.kind === 'cancel'));
calls.length = 0;
injected.forceSteer.cancel('missing');
check('cancel on an unmaterialized session is a no-op', calls.length === 0);

calls.length = 0;
const steered = await injected.forceSteer.steer('S1', 'redirect now');
const begin = calls.find((c) => c.kind === 'beginSubmission');
const prompt = calls.find((c) => c.kind === 'prompt');
check('steer returns true when the Host accepts', steered === true);
check('steer registers a local echo as steering', begin?.input?.mode === 'steer' && begin?.input?.text === 'redirect now',
	JSON.stringify(begin?.input));
check('steer prompts with mode=steer and the echo identity',
	prompt?.mode === 'steer' && prompt?.requestId === 'req-1' &&
	Array.isArray(prompt?.content) && prompt.content[0]?.type === 'text' && prompt.content[0]?.text === 'redirect now');
check('steer on an unmaterialized session returns false',
	(await injected.forceSteer.steer('missing', 'x')) === false);

// ---- 4. button policy ---------------------------------------------------------------
function renderButton(overrides) {
	const props = {
		sessionId: 'S1',
		forceSteer: injected.forceSteer,
		inputActions: { setDraft: (t) => calls.push({ kind: 'setDraft', text: t }), submit: () => calls.push({ kind: 'submit' }) },
		useInput: (selector) => selector({ draft: '', phase: 'plain', attachmentIds: [] }),
		useSession: (selector) => selector({ running: true, removed: false }),
		...overrides
	};
	const element = registration.component(props);
	return element;
}

// running + empty draft -> interrupt only
calls.length = 0;
let button = renderButton({});
button.props.onClick();
check('empty draft: still interrupts', calls.some((c) => c.kind === 'cancel'));
check('empty draft: sends nothing', !calls.some((c) => c.kind === 'prompt' || c.kind === 'submit'));
check('empty draft label is 打断', button.children[1].children === '打断');

// running + text draft -> cancel then steer, then clear
calls.length = 0;
button = renderButton({ useInput: (selector) => selector({ draft: 'switch to plan B', phase: 'plain', attachmentIds: [] }) });
button.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
const order = calls.map((c) => c.kind);
check('text draft: cancel happens before the prompt', order.indexOf('cancel') >= 0 && order.indexOf('cancel') < order.indexOf('prompt'),
	order.join(','));
check('text draft: draft cleared after acceptance', calls.some((c) => c.kind === 'setDraft' && c.text === ''));
check('text draft label is 插话', button.children[1].children === '插话');
check('text draft marks the button armed', String(button.props.className).includes('kitaForceSteer_armed'));

// running + attachments -> official submit machine (file receipts stay official)
calls.length = 0;
button = renderButton({ useInput: (selector) => selector({ draft: '', phase: 'plain', attachmentIds: ['a'] }) });
button.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
check('attachments: delegates to official submit()', calls.some((c) => c.kind === 'submit'));

// not running -> disabled
button = renderButton({ useSession: (selector) => selector({ running: false, removed: false }) });
check('idle session: button disabled', button.props.disabled === true);
calls.length = 0;
button.props.onClick();
check('idle session: click does nothing', calls.length === 0);

// machine busy -> disabled
button = renderButton({ useInput: (selector) => selector({ draft: 'x', phase: 'submitting', attachmentIds: [] }) });
check('submit machine busy: button disabled', button.props.disabled === true);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
