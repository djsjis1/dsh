/**
 * Render smoke test for the browser half.
 *
 * The bundle is a plain script that hands a factory to the host module loader,
 * so the test replays that handshake with a tiny hook runtime and executes the
 * component body for both slot views. It exists because registering the slot
 * correctly says nothing about whether the component renders.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

let bundle;
globalThis.window = { __ModuleLoader__: { load: (module) => { bundle = module; } } };
new Function("window", source)(globalThis.window);
assert.ok(bundle, "bundle did not call __ModuleLoader__.load");
assert.equal(bundle.id, "dsh-plugin-wechat");

const slots = [];
const state = { index: 0, values: [] };

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const index = state.index++;
    if (state.values.length <= index) state.values[index] = initial;
    return [state.values[index], (next) => { state.values[index] = typeof next === "function" ? next(state.values[index]) : next; }];
  },
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn) => fn,
};

const module = bundle.factory((name) => {
  if (name === "react") return react;
  throw new Error(`unexpected require: ${name}`);
});

assert.deepEqual(module.inject, ["slots", "locale"]);

module.apply({
  effect: (fn) => fn(),
  locale: { register: () => {}, bind: () => (key) => key },
  slots: {
    inject: (name, register) => register(),
    register: (options, component) => slots.push({ options, component }),
  },
});

assert.equal(slots.length, 1, "expected exactly one slot registration");
const [{ options, component }] = slots;
assert.equal(options.name, "plugins.item");
assert.equal(options.id, "wechat");
assert.equal(typeof options.label, "function");
assert.equal(typeof component, "function");

const t = (key) => key;
const summary = component({ view: "summary", t });
assert.equal(summary, "description", "the card one-liner is the localized description");

state.index = 0;
state.values = [];
const page = component({ view: "page", t });
assert.ok(page && page.type === "div", "the page view renders a container");
assert.ok(page.children.length > 0);

console.log("client smoke ok: plugins.item registered, summary and page views render");
