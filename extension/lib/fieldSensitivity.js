// One definition of "sensitive form field", shared by the DOM payload (value is never
// serialised) and the pixel layer (field is always black-boxed). Keeping them in one
// place is what stops the two layers from disagreeing — a CVV hidden in pixels but
// sent as text is still a leak.

const SENSITIVE_FIELD_RE =
  /pass(word|wd|code)?|pwd|\bpin\b|otp|one.?time|cvv|cvc|csc|card.?(no|num)|cc-?(number|csc|exp|name)|expir|aadh?aa?r|\bpan\b|ssn|account.?(no|num)|ifsc|upi|dob|birth/i;
const SENSITIVE_AUTOCOMPLETE = new Set([
  "current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-name",
  "bday", "bday-day", "bday-month", "bday-year",
]);
// Fields whose VALUE is personal (name, email, phone, address...). Boxed when filled.
const PERSONAL_AUTOCOMPLETE_RE = /^(name|given-name|family-name|additional-name|email|tel|tel-national|street-address|address-line\d|postal-code|username)$/;

/** @returns {"PASSWORD"|"CARD"|"OTP"|"DOB"|"SENSITIVE_FIELD"|"PERSONAL_FIELD"|null} */
export function fieldKind(el) {
  const type = (el.type || "").toLowerCase();
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/).pop();
  const labelText = el.labels?.length ? [...el.labels].map((l) => l.textContent).join(" ") : "";
  const hay = `${el.name || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""} ${el.placeholder || ""} ${labelText}`;
  if (type === "password") return "PASSWORD";
  if (SENSITIVE_AUTOCOMPLETE.has(ac)) return ac.startsWith("cc") ? "CARD" : ac === "one-time-code" ? "OTP" : ac.includes("password") ? "PASSWORD" : "DOB";
  if (SENSITIVE_FIELD_RE.test(hay)) return "SENSITIVE_FIELD";
  if (PERSONAL_AUTOCOMPLETE_RE.test(ac) || type === "email" || type === "tel") return "PERSONAL_FIELD";
  return null;
}

/** Sensitive = value must never leave the device, even tokenised. */
export function isSensitiveField(el) {
  const k = fieldKind(el);
  return !!k && k !== "PERSONAL_FIELD";
}
