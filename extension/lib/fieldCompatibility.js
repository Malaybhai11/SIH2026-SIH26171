// Privacy-aware Field Compatibility Engine
//
// Ensures that sensitive personal data (e.g. Phone, Email, Aadhaar, PAN, UPI, Card, etc.)
// can ONLY be inserted into webpage fields that explicitly and unambiguously request that
// specific category of information. Generic fields, textareas, comments/message boxes,
// and mismatched fields are strictly blocked (Fail-Closed default).

import { detectRuleSpans, aadhaarValid, luhnValid } from "./redact.js";

// Specific negative indicator keywords that indicate a general-purpose,
// narrative, or commentary text field that must NEVER receive sensitive identifiers.
const NEGATIVE_INDICATORS_RE =
  /\b(comment|comments|message|messages|description|feedback|query|queries|remark|remarks|review|reviews|note|notes|bio|about|instruction|instructions|search|post|body|reason)\b/i;

// Regex patterns to detect positive evidence for each sensitive data category
const FIELD_PATTERNS = {
  PHONE: /\b(phone|mobile|telephone|tel|cell|cellphone|contact\s*(no|num|number)?|phone\s*(no|num|number)?|mobile\s*(no|num|number)?)\b/i,
  EMAIL: /\b(e-?mail|email\s*address|e-?mail\s*address|e-?mail\s*id|mail\s*id)\b/i,
  AADHAAR: /\b(aadh?aa?r|uid|unique\s*identification(\s*number)?|aadhar\s*(no|num|number)?|aadhaar\s*(no|num|number)?)\b/i,
  PAN: /\b(pan|pan\s*card|pan\s*(no|num|number)?|permanent\s*account\s*number)\b/i,
  UPI: /\b(upi|vpa|upi\s*id|virtual\s*payment\s*address)\b/i,
  CARD: /\b(card\s*number|card\s*no|credit\s*card|debit\s*card|cardholder|card\s*num)\b/i,
  CVV: /\b(cvv|cvc|csc|security\s*code|card\s*verification)\b/i,
  PASSWORD: /\b(password|passwd|pwd|passcode|pin)\b/i,
  DOB: /\b(dob|d\.o\.b|date\s*of\s*birth|birth\s*date|birthday)\b/i,
  BANK_ACCOUNT: /\b(bank\s*account|account\s*number|account\s*no|a\/c\s*no|a\/c\s*number|acct\s*no)\b/i,
  GSTIN: /\b(gst|gstin|gst\s*number|gst\s*no)\b/i,
  PASSPORT: /\b(passport|passport\s*(no|number)?)\b/i,
  VOTER_ID: /\b(voter\s*id|epic\s*(no|number)?|voter\s*card)\b/i,
  DRIVING_LICENSE: /\b(driving\s*licen[sc]e|dl\s*(no|number)?)\b/i,
  SSN: /\b(ssn|social\s*security(\s*number)?)\b/i,
  PINCODE: /\b(pincode|pin\s*code|postal\s*code|zip|zipcode|zip\s*code)\b/i,
  ADDRESS: /\b(address|street\s*address|residential\s*address|house\s*no|flat\s*no)\b/i,
  NAME: /\b(name|fullname|full\s*name|first\s*name|last\s*name|applicant\s*name|candidate\s*name|student\s*name|customer\s*name)\b/i,
};

// Regex patterns to recognize raw sensitive values if text was passed un-tokenized
const RAW_PATTERNS = {
  EMAIL: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
  PHONE: /^(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}$/,
  PAN: /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/,
  UPI: /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}@(?:ok)?[A-Za-z]{2,15}$/i,
};

/**
 * Normalizes a sensitive type string to canonical category.
 */
export function normalizeCategory(type) {
  if (!type) return null;
  const upper = String(type).toUpperCase().trim();
  if (upper === "TEL" || upper === "MOBILE" || upper === "PHONE") return "PHONE";
  if (upper === "EMAIL" || upper === "MAIL") return "EMAIL";
  if (upper === "AADHAAR" || upper === "AADHAR" || upper === "UID") return "AADHAAR";
  if (upper === "PAN") return "PAN";
  if (upper === "UPI") return "UPI";
  if (upper === "CC" || upper === "CARD" || upper === "CREDIT_CARD") return "CARD";
  if (upper === "CVV") return "CVV";
  if (upper === "PASSWORD") return "PASSWORD";
  if (upper === "DOB") return "DOB";
  if (upper === "BANK_ACCOUNT") return "BANK_ACCOUNT";
  if (upper === "GSTIN") return "GSTIN";
  if (upper === "PASSPORT") return "PASSPORT";
  if (upper === "VOTER_ID") return "VOTER_ID";
  if (upper === "DRIVING_LICENSE") return "DRIVING_LICENSE";
  if (upper === "SSN") return "SSN";
  if (upper === "PINCODE") return "PINCODE";
  if (upper === "ADDRESS") return "ADDRESS";
  if (upper === "NAME") return "NAME";
  return upper;
}

/**
 * Extracts metadata from a target webpage element or accepts an existing metadata object.
 */
export function extractFieldMetadata(el) {
  if (!el) return null;

  // If already a plain metadata object (e.g. from unit tests), normalize and return
  if (typeof el === "object" && !("tagName" in el) && ("type" in el || "labelText" in el || "name" in el)) {
    return {
      tag: (el.tag || "input").toLowerCase(),
      type: (el.type || "text").toLowerCase(),
      name: (el.name || "").toLowerCase(),
      id: (el.id || "").toLowerCase(),
      autocomplete: (el.autocomplete || "").toLowerCase(),
      placeholder: (el.placeholder || "").toLowerCase(),
      ariaLabel: (el.ariaLabel || "").toLowerCase(),
      labelText: (el.labelText || "").toLowerCase(),
    };
  }

  const tag = (el.tagName || "").toLowerCase();
  const type = (el.type || (tag === "textarea" ? "textarea" : "text")).toLowerCase();
  const name = (el.name || (el.getAttribute ? el.getAttribute("name") : "") || "").toLowerCase();
  const id = (el.id || (el.getAttribute ? el.getAttribute("id") : "") || "").toLowerCase();
  const autocomplete = (el.getAttribute ? el.getAttribute("autocomplete") || "" : "").toLowerCase();
  const placeholder = (el.placeholder || (el.getAttribute ? el.getAttribute("placeholder") : "") || "").toLowerCase();
  const ariaLabel = (el.getAttribute ? el.getAttribute("aria-label") || "" : "").toLowerCase();

  // Associated label text resolution
  let labelText = "";
  if (el.labels && el.labels.length) {
    labelText = Array.from(el.labels).map((l) => l.textContent || "").join(" ");
  }
  if (!labelText && el.getAttribute && el.getAttribute("aria-labelledby") && typeof document !== "undefined") {
    const ids = el.getAttribute("aria-labelledby").split(/\s+/);
    labelText = ids.map((id) => document.getElementById(id)?.textContent || "").join(" ");
  }
  if (!labelText && el.id && typeof document !== "undefined") {
    try {
      const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (labelEl) labelText = labelEl.textContent || "";
    } catch {}
  }
  if (!labelText && el.closest) {
    const parentLabel = el.closest("label");
    if (parentLabel) {
      labelText = parentLabel.textContent || "";
    }
  }
  if (!labelText && el.closest && typeof document !== "undefined") {
    const container = el.closest(".form-group, .form-item, .field, [class*='field'], [class*='form-group'], tr");
    if (container) {
      const nearbyLabel = container.querySelector("label, .label, [class*='label']");
      if (nearbyLabel && nearbyLabel !== el) {
        labelText = nearbyLabel.textContent || "";
      }
    }
  }
  labelText = labelText.toLowerCase().trim();

  return {
    tag,
    type,
    name,
    id,
    autocomplete,
    placeholder,
    ariaLabel,
    labelText,
  };
}

/**
 * Classifies a target field to determine which sensitive data categories it is
 * explicitly intended to receive.
 *
 * @param {object} meta - Field metadata from extractFieldMetadata
 * @returns {Set<string>} Set of supported sensitive category names (e.g. Set {"PHONE"})
 */
export function classifyField(meta) {
  const allowedCategories = new Set();
  if (!meta) return allowedCategories;

  const combinedSemanticText = `${meta.labelText} ${meta.ariaLabel} ${meta.placeholder} ${meta.name} ${meta.id}`;
  const isNegative = NEGATIVE_INDICATORS_RE.test(combinedSemanticText);

  // 1. Phone / Mobile
  const phoneExplicit = meta.type === "tel" || meta.autocomplete === "tel" || meta.autocomplete.startsWith("tel-");
  if (phoneExplicit || (!isNegative && FIELD_PATTERNS.PHONE.test(combinedSemanticText))) {
    allowedCategories.add("PHONE");
  }

  // 2. Email
  const emailExplicit = meta.type === "email" || meta.autocomplete === "email";
  if (emailExplicit || (!isNegative && FIELD_PATTERNS.EMAIL.test(combinedSemanticText))) {
    allowedCategories.add("EMAIL");
  }

  // 3. Aadhaar
  if (!isNegative && FIELD_PATTERNS.AADHAAR.test(combinedSemanticText)) {
    allowedCategories.add("AADHAAR");
  }

  // 4. PAN
  if (!isNegative && FIELD_PATTERNS.PAN.test(combinedSemanticText)) {
    allowedCategories.add("PAN");
  }

  // 5. UPI
  if (!isNegative && FIELD_PATTERNS.UPI.test(combinedSemanticText)) {
    allowedCategories.add("UPI");
  }

  // 6. Credit / Debit Card
  const cardExplicit = meta.autocomplete.startsWith("cc-");
  if (cardExplicit || (!isNegative && FIELD_PATTERNS.CARD.test(combinedSemanticText))) {
    allowedCategories.add("CARD");
  }

  // 7. CVV
  if (meta.autocomplete === "cc-csc" || (!isNegative && FIELD_PATTERNS.CVV.test(combinedSemanticText))) {
    allowedCategories.add("CVV");
  }

  // 8. Password
  if (meta.type === "password" || meta.autocomplete.includes("password") || FIELD_PATTERNS.PASSWORD.test(combinedSemanticText)) {
    allowedCategories.add("PASSWORD");
  }

  // 9. DOB
  if (meta.type === "date" || meta.autocomplete.startsWith("bday") || (!isNegative && FIELD_PATTERNS.DOB.test(combinedSemanticText))) {
    allowedCategories.add("DOB");
  }

  // 10. Bank Account
  if (!isNegative && FIELD_PATTERNS.BANK_ACCOUNT.test(combinedSemanticText)) {
    allowedCategories.add("BANK_ACCOUNT");
  }

  // 11. GSTIN
  if (!isNegative && FIELD_PATTERNS.GSTIN.test(combinedSemanticText)) {
    allowedCategories.add("GSTIN");
  }

  // 12. Passport
  if (!isNegative && FIELD_PATTERNS.PASSPORT.test(combinedSemanticText)) {
    allowedCategories.add("PASSPORT");
  }

  // 13. Voter ID
  if (!isNegative && FIELD_PATTERNS.VOTER_ID.test(combinedSemanticText)) {
    allowedCategories.add("VOTER_ID");
  }

  // 14. Driving License
  if (!isNegative && FIELD_PATTERNS.DRIVING_LICENSE.test(combinedSemanticText)) {
    allowedCategories.add("DRIVING_LICENSE");
  }

  // 15. SSN
  if (!isNegative && FIELD_PATTERNS.SSN.test(combinedSemanticText)) {
    allowedCategories.add("SSN");
  }

  // 16. Pincode
  if (meta.autocomplete === "postal-code" || (!isNegative && FIELD_PATTERNS.PINCODE.test(combinedSemanticText))) {
    allowedCategories.add("PINCODE");
  }

  // 17. Address
  const addressExplicit = meta.autocomplete === "street-address" || meta.autocomplete.startsWith("address-line");
  if (addressExplicit || (!isNegative && FIELD_PATTERNS.ADDRESS.test(combinedSemanticText))) {
    allowedCategories.add("ADDRESS");
  }

  // 18. Name
  const nameExplicit = meta.autocomplete === "name" || meta.autocomplete === "given-name" || meta.autocomplete === "family-name";
  if (nameExplicit || (!isNegative && FIELD_PATTERNS.NAME.test(combinedSemanticText))) {
    allowedCategories.add("NAME");
  }

  return allowedCategories;
}

/**
 * Detects sensitive data categories from text, explicit token types, or rule inspection.
 *
 * @param {string} text - The text being inserted (raw or pre-rehydration)
 * @param {string[]} [explicitTypes=[]] - Any token types tracked during token rehydration (e.g. ["EMAIL"])
 * @returns {string[]} Array of detected canonical category names (e.g. ["EMAIL"])
 */
export function detectSensitiveDataTypes(text = "", explicitTypes = []) {
  const types = new Set();

  // 1. Explicit token types passed along from rehydration
  for (const t of explicitTypes) {
    const c = normalizeCategory(t);
    if (c) types.add(c);
  }

  if (typeof text !== "string" || !text.trim()) {
    return [...types];
  }

  // 2. Token pattern detection within text itself: [TYPE_n]
  const tokenMatches = text.matchAll(/\[([A-Z_]+)_\d+\]/g);
  for (const m of tokenMatches) {
    const c = normalizeCategory(m[1]);
    if (c) types.add(c);
  }

  // 3. Fast exact regex checks for common single values
  const trimmed = text.trim();
  if (RAW_PATTERNS.EMAIL.test(trimmed)) types.add("EMAIL");
  if (RAW_PATTERNS.PHONE.test(trimmed)) types.add("PHONE");
  if (RAW_PATTERNS.PAN.test(trimmed)) types.add("PAN");
  if (RAW_PATTERNS.UPI.test(trimmed) && !/@(?:gmail|yahoo|outlook|hotmail)\./i.test(trimmed)) types.add("UPI");
  if (aadhaarValid(trimmed)) types.add("AADHAAR");
  if (luhnValid(trimmed)) types.add("CARD");

  // 4. Rule spans inspection
  const spans = detectRuleSpans(text);
  for (const s of spans) {
    const c = normalizeCategory(s.type);
    if (c) types.add(c);
  }

  return [...types];
}

/**
 * Checks whether sensitive data is allowed to be inserted into the target field.
 *
 * Enforces Fail-Closed Privacy:
 * - If non-sensitive text is passed, it is allowed.
 * - If sensitive data is present, the target field MUST exhibit positive semantic evidence
 *   requesting that exact category of data.
 * - Generic inputs, textareas, comments/message fields, or cross-type mismatches are BLOCKED.
 *
 * @param {string|string[]} dataType - Category name or array of category names
 * @param {Element|object} targetField - Target DOM element or field metadata object
 * @returns {{ allowed: boolean, reason?: string, blockedType?: string }}
 */
export function isSensitiveDataAllowed(dataType, targetField) {
  const categories = (Array.isArray(dataType) ? dataType : [dataType])
    .map(normalizeCategory)
    .filter(Boolean);

  // If no sensitive data category was identified, insertion is safe and allowed
  if (categories.length === 0) {
    return { allowed: true };
  }

  const meta = extractFieldMetadata(targetField);
  if (!meta) {
    return {
      allowed: false,
      reason: "Privacy protection: Target field cannot be identified or is invalid.",
      blockedType: categories[0],
    };
  }

  const intendedCategories = classifyField(meta);

  // Verify that EVERY sensitive category being inserted has positive evidence in the field
  for (const cat of categories) {
    if (!intendedCategories.has(cat)) {
      return {
        allowed: false,
        reason: "Privacy protection: This information cannot be inserted because the selected field does not appear to request this type of data.",
        blockedType: cat,
      };
    }
  }

  return { allowed: true };
}
