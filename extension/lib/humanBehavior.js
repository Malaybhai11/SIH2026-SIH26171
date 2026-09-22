// Human Behavior Simulation Engine for Browser Agent Actions
//
// Implements realistic kinematic models, human cognitive pauses, keystroke dynamics,
// Bézier mouse trajectories, and physics-based smooth scrolling to mimic genuine user interaction.

export const QWERTY_ADJACENT = {
  q: ["w", "a", "s"],
  w: ["q", "e", "s", "a", "d"],
  e: ["w", "r", "d", "s", "f"],
  r: ["e", "t", "f", "d", "g"],
  t: ["r", "y", "g", "f", "h"],
  y: ["t", "u", "h", "g", "j"],
  u: ["y", "i", "j", "h", "k"],
  i: ["u", "o", "k", "j", "l"],
  o: ["i", "p", "l", "k"],
  p: ["o", "l"],
  a: ["q", "w", "s", "z"],
  s: ["a", "w", "e", "d", "x", "z"],
  d: ["s", "e", "r", "f", "c", "x"],
  f: ["d", "r", "t", "g", "v", "c"],
  g: ["f", "t", "y", "h", "b", "v"],
  h: ["g", "y", "u", "j", "n", "b"],
  j: ["h", "u", "i", "k", "m", "n"],
  k: ["j", "i", "o", "l", "m"],
  l: ["k", "o", "p"],
  z: ["a", "s", "x"],
  x: ["z", "s", "d", "c"],
  c: ["x", "d", "f", "v", " "],
  v: ["c", "f", "g", "b", " "],
  b: ["v", "g", "h", "n", " "],
  n: ["b", "h", "j", "m", " "],
  m: ["n", "j", "k"],
};

export const KEY_CODES = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  ArrowDown: 40,
  ArrowUp: 38,
  ArrowLeft: 37,
  ArrowRight: 39,
  Backspace: 8,
  Delete: 46,
  " ": 32,
};

export const NON_PRINTABLE_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
]);

// Virtual cursor state (tracks position across interactions)
export const virtualCursor = {
  x: typeof window !== "undefined" ? Math.round(window.innerWidth * 0.5) : 500,
  y: typeof window !== "undefined" ? Math.round(window.innerHeight * 0.5) : 400,
};

// Sync virtual cursor with real physical mouse movements when possible
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener(
    "mousemove",
    (e) => {
      if (e.isTrusted) {
        virtualCursor.x = Math.round(e.clientX);
        virtualCursor.y = Math.round(e.clientY);
      }
    },
    { passive: true }
  );
}

export function getVirtualCursor() {
  return { ...virtualCursor };
}

export function setVirtualCursor(x, y) {
  virtualCursor.x = Math.round(x);
  virtualCursor.y = Math.round(y);
}

/**
 * Box-Muller transform for generating Gaussian (normal) distributed random values.
 */
export function gaussianRandom(mean = 0, stdDev = 1, min = -Infinity, max = Infinity) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  const result = mean + z * stdDev;
  return Math.max(min, Math.min(max, result));
}

/**
 * Log-normal distribution (ideal for human keystroke flight times and reaction delays).
 */
export function logNormalRandom(mean = 100, stdDev = 30, min = 40, max = 500) {
  const variance = stdDev * stdDev;
  const mu = Math.log((mean * mean) / Math.sqrt(variance + mean * mean));
  const sigma = Math.sqrt(Math.log(variance / (mean * mean) + 1));
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  const sample = Math.exp(mu + sigma * z);
  return Math.max(min, Math.min(max, sample));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Human delay with jitter sampled from a bounded normal distribution.
 */
export function humanDelay(minMs, maxMs) {
  const mean = (minMs + maxMs) / 2;
  const stdDev = (maxMs - minMs) / 6;
  const delay = gaussianRandom(mean, stdDev, minMs, maxMs);
  return sleep(delay);
}

/**
 * Fitts's Law duration calculation:
 * T = a + b * log2(distance / targetWidth + 1)
 */
export function fittsDuration(distance, targetWidth = 30) {
  const effectiveWidth = Math.max(15, targetWidth);
  const indexDifficulty = Math.log2(distance / effectiveWidth + 1);
  const duration = 150 + 130 * indexDifficulty;
  return Math.max(140, Math.min(700, Math.round(duration)));
}

/**
 * Minimum-jerk trajectory polynomial (Flash & Hogan, 1985).
 * Represents human reaching movements: zero velocity at start, peak at middle, smooth deceleration at end.
 */
export function minimumJerk(t) {
  const clamped = Math.max(0, Math.min(1, t));
  return 10 * Math.pow(clamped, 3) - 15 * Math.pow(clamped, 4) + 6 * Math.pow(clamped, 5);
}

/**
 * Cubic Bézier interpolation between 4 control points.
 */
export function cubicBezier(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
    y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y,
  };
}

/**
 * Target acquisition with 2D Gaussian offset rather than exact mathematical center.
 * Avoids edge clipping via adaptive padding.
 */
export function getRealisticTargetPoint(element) {
  if (typeof element?.getBoundingClientRect !== "function") {
    return { clientX: 100, clientY: 100 };
  }
  const rect = element.getBoundingClientRect();
  const width = Math.max(2, rect.width);
  const height = Math.max(2, rect.height);

  const padX = Math.min(8, width * 0.18);
  const padY = Math.min(6, height * 0.18);

  const sigmaX = Math.max(1, (width - 2 * padX) / 6);
  const sigmaY = Math.max(1, (height - 2 * padY) / 6);

  const centerX = rect.left + width / 2;
  const centerY = rect.top + height / 2;

  const targetX = gaussianRandom(centerX, sigmaX, rect.left + padX, rect.right - padX);
  const targetY = gaussianRandom(centerY, sigmaY, rect.top + padY, rect.bottom - padY);

  return {
    clientX: Math.round(targetX),
    clientY: Math.round(targetY),
  };
}

/**
 * Generates an array of trajectory points along a human Bézier curve with minimum-jerk velocity
 * and motor tremor noise.
 */
export function generateBezierPath(startX, startY, endX, endY, targetWidth = 30) {
  const dx = endX - startX;
  const dy = endY - startY;
  const distance = Math.hypot(dx, dy);

  if (distance < 4) {
    return [{ x: endX, y: endY, t: 1 }];
  }

  const duration = fittsDuration(distance, targetWidth);
  const stepCount = Math.max(8, Math.min(65, Math.round(duration / 16)));

  const angle = Math.atan2(dy, dx);
  const perpX = -Math.sin(angle);
  const perpY = Math.cos(angle);

  // Natural human arm curvature
  const curvature = (Math.random() < 0.5 ? 1 : -1) * (0.12 + Math.random() * 0.18) * distance;

  const cp1Dist = 0.25 + Math.random() * 0.15;
  const cp1Jitter = (Math.random() - 0.5) * 6;
  const cp1 = {
    x: startX + dx * cp1Dist + perpX * curvature * 0.85 + cp1Jitter,
    y: startY + dy * cp1Dist + perpY * curvature * 0.85 + cp1Jitter,
  };

  const cp2Dist = 0.70 + Math.random() * 0.15;
  const cp2Jitter = (Math.random() - 0.5) * 4;
  const cp2 = {
    x: startX + dx * cp2Dist + perpX * curvature * 0.35 + cp2Jitter,
    y: startY + dy * cp2Dist + perpY * curvature * 0.35 + cp2Jitter,
  };

  const p0 = { x: startX, y: startY };
  const p3 = { x: endX, y: endY };

  const points = [];
  for (let i = 1; i <= stepCount; i++) {
    const linearT = i / stepCount;
    const easedT = minimumJerk(linearT);
    const coord = cubicBezier(p0, cp1, cp2, p3, easedT);

    // Subtle micro-tremor during transit
    const tremorX = linearT < 0.95 ? (Math.random() - 0.5) * 0.8 : 0;
    const tremorY = linearT < 0.95 ? (Math.random() - 0.5) * 0.8 : 0;

    points.push({
      x: Math.round(coord.x + tremorX),
      y: Math.round(coord.y + tremorY),
      t: linearT,
    });
  }

  points[points.length - 1] = { x: endX, y: endY, t: 1 };
  return points;
}

export function createPointerEvent(type, x, y, extra = {}) {
  const sx = (typeof window !== "undefined" ? window.screenX || 0 : 0) + x;
  const sy = (typeof window !== "undefined" ? window.screenY || 0 : 0) + y + 80;
  const px = (typeof window !== "undefined" ? window.scrollX || 0 : 0) + x;
  const py = (typeof window !== "undefined" ? window.scrollY || 0 : 0) + y;

  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: typeof window !== "undefined" ? window : null,
    clientX: x,
    clientY: y,
    screenX: sx,
    screenY: sy,
    pageX: px,
    pageY: py,
    pointerType: "mouse",
    isPrimary: true,
    pointerId: 1,
    width: 1,
    height: 1,
    pressure: extra.buttons ? 0.5 : 0,
    ...extra,
  });
}

export function createMouseEvent(type, x, y, extra = {}) {
  const sx = (typeof window !== "undefined" ? window.screenX || 0 : 0) + x;
  const sy = (typeof window !== "undefined" ? window.screenY || 0 : 0) + y + 80;
  const px = (typeof window !== "undefined" ? window.scrollX || 0 : 0) + x;
  const py = (typeof window !== "undefined" ? window.scrollY || 0 : 0) + y;

  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: typeof window !== "undefined" ? window : null,
    clientX: x,
    clientY: y,
    screenX: sx,
    screenY: sy,
    pageX: px,
    pageY: py,
    ...extra,
  });
}

/**
 * Smoothly moves the virtual mouse cursor across the viewport to target (x, y),
 * dispatching continuous pointermove / mousemove events with realistic speed profile.
 */
export async function moveCursorTo(targetX, targetY, options = {}) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    virtualCursor.x = targetX;
    virtualCursor.y = targetY;
    return;
  }

  const { targetWidth = 30, speedMultiplier = 1.0 } = options;
  const path = generateBezierPath(virtualCursor.x, virtualCursor.y, targetX, targetY, targetWidth);

  let lastElement = null;

  for (const pt of path) {
    virtualCursor.x = pt.x;
    virtualCursor.y = pt.y;

    const targetEl = document.elementFromPoint(pt.x, pt.y) || document.body || document.documentElement;

    if (targetEl && targetEl !== lastElement) {
      if (lastElement) {
        try {
          lastElement.dispatchEvent(createPointerEvent("pointerout", pt.x, pt.y));
          lastElement.dispatchEvent(createMouseEvent("mouseout", pt.x, pt.y));
        } catch {}
      }
      try {
        targetEl.dispatchEvent(createPointerEvent("pointerover", pt.x, pt.y));
        targetEl.dispatchEvent(createMouseEvent("mouseover", pt.x, pt.y));
      } catch {}
      lastElement = targetEl;
    }

    if (targetEl) {
      try {
        targetEl.dispatchEvent(createPointerEvent("pointermove", pt.x, pt.y));
        targetEl.dispatchEvent(createMouseEvent("mousemove", pt.x, pt.y));
      } catch {}
    }

    const frameDelay = Math.max(6, Math.round(16 / speedMultiplier + (Math.random() * 4 - 2)));
    await sleep(frameDelay);
  }
}

/**
 * Executes a human click:
 * 1. Checks visibility and performs smooth scroll if outside viewport.
 * 2. Moves cursor via natural Bézier trajectory.
 * 3. Pauses for visual acquisition / hover dwell.
 * 4. Dispatches pointerdown + mousedown.
 * 5. Dwells for physical button depression duration (50-110ms).
 * 6. Dispatches pointerup, mouseup, click.
 * 7. Post-click cognitive hesitation before returning.
 */
export async function humanClick(el, options = {}) {
  if (!el) return;

  if (typeof el.getBoundingClientRect === "function") {
    const rect = el.getBoundingClientRect();
    const inView =
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth);

    if (!inView) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      await sleep(gaussianRandom(280, 50, 200, 420));
    }
  }

  const target = getRealisticTargetPoint(el);
  const targetWidth = el.getBoundingClientRect ? el.getBoundingClientRect().width : 30;

  await moveCursorTo(target.clientX, target.clientY, { targetWidth });

  // Hover settle / visual acquisition hesitation
  await sleep(gaussianRandom(80, 25, 45, 140));

  const x = target.clientX;
  const y = target.clientY;

  // Pointer & mouse down
  el.dispatchEvent(createPointerEvent("pointerdown", x, y, { buttons: 1, button: 0, detail: 1 }));
  el.dispatchEvent(createMouseEvent("mousedown", x, y, { buttons: 1, button: 0, detail: 1 }));

  // Key / button dwell time (physical switch actuation)
  await sleep(gaussianRandom(75, 18, 50, 115));

  // Pointer & mouse up + click
  el.dispatchEvent(createPointerEvent("pointerup", x, y, { buttons: 0, button: 0, detail: 1 }));
  el.dispatchEvent(createMouseEvent("mouseup", x, y, { buttons: 0, button: 0, detail: 1 }));
  el.dispatchEvent(createMouseEvent("click", x, y, { buttons: 0, button: 0, detail: 1 }));

  // Cognitive settle delay
  const postDelay = options.postDelay ?? gaussianRandom(220, 50, 140, 360);
  await sleep(postDelay);
}

/**
 * Human hover: smooth trajectory to element + realistic dwell with micro-jitter.
 */
export async function humanHover(el) {
  if (!el) return;
  const target = getRealisticTargetPoint(el);
  const targetWidth = el.getBoundingClientRect ? el.getBoundingClientRect().width : 30;

  await moveCursorTo(target.clientX, target.clientY, { targetWidth });

  const x = target.clientX;
  const y = target.clientY;
  el.dispatchEvent(createPointerEvent("pointerover", x, y));
  el.dispatchEvent(createMouseEvent("mouseover", x, y));
  el.dispatchEvent(createPointerEvent("pointerenter", x, y));
  el.dispatchEvent(createMouseEvent("mouseenter", x, y));

  await sleep(gaussianRandom(380, 80, 250, 650));
}

/**
 * Key mapping helper. Resolves key, code, keyCode.
 */
export function resolveKeyDetails(char) {
  if (KEY_CODES[char] !== undefined) {
    return {
      key: char,
      code: char === " " ? "Space" : char,
      keyCode: KEY_CODES[char],
      which: KEY_CODES[char],
    };
  }
  if (/^[a-zA-Z]$/.test(char)) {
    const upper = char.toUpperCase();
    return {
      key: char,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      which: upper.charCodeAt(0),
    };
  }
  if (/^[0-9]$/.test(char)) {
    return {
      key: char,
      code: `Digit${char}`,
      keyCode: 48 + parseInt(char, 10),
      which: 48 + parseInt(char, 10),
    };
  }
  return {
    key: char,
    code: "Quote",
    keyCode: char.charCodeAt(0),
    which: char.charCodeAt(0),
  };
}

/**
 * Native property setter bypass for React/Vue/Angular controlled inputs.
 */
export function nativeValueSetter(el) {
  if (typeof window === "undefined") return null;
  const proto =
    el instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, "value")?.set;
}

export function placeCaretAtEnd(el) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/**
 * Types text into an element with human keystroke cadence:
 * - Key dwell time: 50-110ms between keydown and keyup.
 * - Flight time: 70-220ms log-normal delay between keys.
 * - Cognitive pauses: space/punctuation boundary delays.
 * - Optional realistic typo + backspace correction (~1.2% chance).
 */
export async function humanType(el, text, options = {}) {
  if (!el) return;
  el.focus();

  const { simulateTypos = true } = options;
  const isContentEditable = !!el.isContentEditable;
  const setter = !isContentEditable ? nativeValueSetter(el) : null;

  // Clear any existing content first — for both branches. Without this, retyping
  // into a contenteditable field the agent already touched (e.g. correcting a
  // previous attempt) appended onto the old text instead of replacing it, unlike
  // the input/textarea branch just below which already clears first.
  let currentText = "";
  if (isContentEditable) {
    el.textContent = "";
    placeCaretAtEnd(el);
  } else if (setter) {
    setter.call(el, "");
  } else {
    el.value = "";
  }

  const str = String(text);

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const isLetter = /^[a-z]$/i.test(ch);
    const lower = ch.toLowerCase();

    // Typo simulation: occasionally press adjacent key, pause, backspace, then correct key
    const shouldTypo =
      simulateTypos &&
      isLetter &&
      str.length > 3 &&
      i > 0 &&
      i < str.length - 1 &&
      QWERTY_ADJACENT[lower] &&
      Math.random() < 0.012;

    if (shouldTypo) {
      const adjacentList = QWERTY_ADJACENT[lower];
      const wrongChar = adjacentList[Math.floor(Math.random() * adjacentList.length)];
      const typoChar = ch === ch.toUpperCase() ? wrongChar.toUpperCase() : wrongChar;

      // 1. Type wrong char
      await emitKeyPress(el, typoChar, isContentEditable, setter, () => {
        currentText += typoChar;
        return currentText;
      });

      // 2. Hesitation recognizing mistake (140 - 280ms)
      await sleep(gaussianRandom(190, 40, 130, 290));

      // 3. Backspace
      const bkDetails = resolveKeyDetails("Backspace");
      el.dispatchEvent(new KeyboardEvent("keydown", { ...bkDetails, bubbles: true, cancelable: true }));
      currentText = currentText.slice(0, -1);
      if (isContentEditable) {
        el.textContent = currentText;
        placeCaretAtEnd(el);
      } else if (setter) {
        setter.call(el, currentText);
      } else {
        el.value = currentText;
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      await sleep(gaussianRandom(65, 15, 40, 95));
      el.dispatchEvent(new KeyboardEvent("keyup", { ...bkDetails, bubbles: true, cancelable: true }));

      // 4. Hesitation before typing correct key (100 - 200ms)
      await sleep(gaussianRandom(130, 30, 80, 210));
    }

    // Emit intended key
    await emitKeyPress(el, ch, isContentEditable, setter, () => {
      currentText += ch;
      return currentText;
    });

    // Keystroke flight time (time until next key is pressed)
    let flightTime = logNormalRandom(110, 32, 60, 240);

    // Human cognitive pauses: spaces and punctuation require longer motor planning
    if (ch === " ") {
      flightTime += gaussianRandom(110, 35, 60, 220);
    } else if (/[.,!?;:]/.test(ch)) {
      flightTime += gaussianRandom(220, 50, 130, 380);
    } else if (ch === ch.toUpperCase() && isLetter) {
      flightTime += gaussianRandom(45, 15, 20, 90);
    }

    await sleep(flightTime);
  }

  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function emitKeyPress(el, ch, isContentEditable, setter, updateTextFn) {
  const keyDetails = resolveKeyDetails(ch);
  const keyOpts = { ...keyDetails, bubbles: true, cancelable: true };

  el.dispatchEvent(new KeyboardEvent("keydown", keyOpts));

  const nextText = updateTextFn();
  if (isContentEditable) {
    el.textContent = nextText;
    placeCaretAtEnd(el);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
  } else {
    if (setter) setter.call(el, nextText);
    else el.value = nextText;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Key dwell time (physical key depression: 45 - 105ms)
  const dwell = gaussianRandom(72, 18, 45, 115);
  await sleep(dwell);

  el.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
}

/**
 * Natural physics-based smooth scrolling with deceleration and wheel events.
 */
export async function humanScroll(targetDistance, options = {}) {
  if (typeof window === "undefined") return;

  const variance = (Math.random() - 0.5) * 0.16;
  const totalDistance = Math.round(targetDistance * (1 + variance));
  const duration = options.duration ?? Math.max(320, Math.min(680, Math.round(Math.abs(totalDistance) * 0.65)));
  const startTime = performance.now();
  let scrolledSoFar = 0;

  return new Promise((resolve) => {
    let lastWheelTime = performance.now();

    function step(now) {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      // Cubic ease-out deceleration curve
      const easeProgress = 1 - Math.pow(1 - progress, 3);
      const targetScroll = Math.round(totalDistance * easeProgress);
      const delta = targetScroll - scrolledSoFar;

      if (delta !== 0) {
        window.scrollBy(0, delta);
        scrolledSoFar = targetScroll;

        if (now - lastWheelTime > 35) {
          try {
            window.dispatchEvent(
              new WheelEvent("wheel", {
                bubbles: true,
                cancelable: true,
                clientX: virtualCursor.x,
                clientY: virtualCursor.y,
                deltaY: delta,
                deltaMode: 0,
              })
            );
          } catch {}
          lastWheelTime = now;
        }
      }

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        // Cognitive reading pause after scrolling to visually scan new items
        const readPause = gaussianRandom(380, 85, 220, 650);
        setTimeout(resolve, readPause);
      }
    }

    requestAnimationFrame(step);
  });
}

/**
 * Human single key press (Enter, Tab, Escape, etc.).
 */
export async function humanPressKey(target, key) {
  if (!target) return;
  const details = resolveKeyDetails(key);
  const keyOpts = { ...details, bubbles: true, cancelable: true };

  target.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
  if (!NON_PRINTABLE_KEYS.has(key)) {
    try {
      target.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
    } catch {}
  }

  // Key dwell
  await sleep(gaussianRandom(70, 18, 45, 110));
  target.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
  await sleep(gaussianRandom(120, 30, 70, 200));
}

/**
 * Human select dropdown option.
 */
export async function humanSelect(selectEl, value) {
  if (!selectEl) return;
  await humanClick(selectEl);
  await sleep(gaussianRandom(180, 40, 120, 280));
  selectEl.value = value;
  selectEl.dispatchEvent(new Event("input", { bubbles: true }));
  selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(gaussianRandom(140, 30, 90, 220));
}

/**
 * Human toggle checkbox or radio.
 */
export async function humanCheck(inputEl, desiredState) {
  if (!inputEl) return;
  if (inputEl.checked !== desiredState) {
    await humanClick(inputEl);
  }
}
