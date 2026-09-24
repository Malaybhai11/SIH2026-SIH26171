// Direct (non-simulated) action executors — the default. They dispatch the same DOM
// events a framework listens for (input/change/click/key*), with no artificial
// cursor paths or keystroke cadence, so each step costs milliseconds instead of
// seconds. humanBehavior.js remains available as an opt-in ("humanize") for sites
// whose UI logic genuinely depends on pointer movement.

import { nativeValueSetter, resolveKeyDetails, NON_PRINTABLE_KEYS } from "./humanBehavior.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fastDelay(minMs, maxMs) {
  await sleep(Math.min(minMs, maxMs ?? minMs));
}

export async function fastClick(el, { postDelay } = {}) {
  if (!el) return;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.focus?.({ preventScroll: true });
  el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
  await sleep(postDelay ?? 150);
}

export async function fastHover(el) {
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent("pointerover", opts));
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new MouseEvent("mouseenter", { ...opts, bubbles: false }));
  await sleep(120);
}

export async function fastType(el, text) {
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.focus();
  if (el.isContentEditable) {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
  } else {
    const setter = nativeValueSetter(el);
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  await sleep(50);
}

export async function fastScroll(amount) {
  window.scrollBy({ top: amount, behavior: "instant" });
  await sleep(250); // let lazy content hydrate
}

export async function fastPressKey(target, key) {
  if (!target) return;
  const opts = { ...resolveKeyDetails(key), bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent("keydown", opts));
  if (!NON_PRINTABLE_KEYS.has(key)) target.dispatchEvent(new KeyboardEvent("keypress", opts));
  target.dispatchEvent(new KeyboardEvent("keyup", opts));
  if (key === "Enter" && target.form && target.tagName === "INPUT") {
    target.form.requestSubmit?.();
  }
  await sleep(100);
}

export async function fastSelect(selectEl, value) {
  if (!selectEl) return;
  selectEl.value = value;
  selectEl.dispatchEvent(new Event("input", { bubbles: true }));
  selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(50);
}

export async function fastCheck(inputEl, desired) {
  if (inputEl && inputEl.checked !== desired) await fastClick(inputEl, { postDelay: 50 });
}
