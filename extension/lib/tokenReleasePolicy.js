// Token Release Policy & Origin Security Engine
//
// Enforces P0 security requirements for sensitive token release:
// 1. Provenance verification: Every token must have verified origin metadata in the Vault.
// 2. Destination origin verification: Destination webpage origin must be allowed by trust policy.
// 3. Destination field verification: Field must semantically match the sensitive token type.
// 4. Centralized decision: Fail-closed before real sensitive values are ever released.
// 5. Security logging: Audit every decision without ever logging raw sensitive values.

import { classifyField, isSensitiveDataAllowed, normalizeCategory, extractFieldMetadata } from "./fieldCompatibility.js";

// Trusted domains recognized by the project's trust policy (from SITE_CONFIGS and KNOWN_SITES)
export const TRUSTED_DOMAINS = Object.freeze([
  "chatgpt.com",
  "google.com",
  "youtube.com",
  "mail.google.com",
  "github.com",
  "amazon.com",
  "wikipedia.org",
  "en.wikipedia.org",
  "reddit.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "news.ycombinator.com",
  "maps.google.com",
]);

// Dynamic trust registry for user-approved origins and runtime additions
const dynamicAllowedOrigins = new Set();

export function addTrustedOrigin(origin) {
  if (origin && typeof origin === "string") {
    try {
      const u = new URL(origin);
      dynamicAllowedOrigins.add(u.origin.toLowerCase());
    } catch {
      dynamicAllowedOrigins.add(origin.toLowerCase());
    }
  }
}

export function clearDynamicTrustedOrigins() {
  dynamicAllowedOrigins.clear();
}

/**
 * Checks whether an origin is a localhost / loopback address.
 */
function isLocalhost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local")
  );
}

/**
 * Verifies if the destination origin is allowed by the project's trust policy.
 * Fail-closed: invalid, unknown, or ambiguous origins return false.
 *
 * @param {string} destOrigin - The origin of the target webpage (e.g. "https://example.com")
 * @param {string} [sourceOrigin] - Optional source origin from token provenance
 * @param {string[]} [customAllowed=[]] - Additional caller-specified allowed origins
 * @returns {boolean}
 */
export function isAllowedOrigin(destOrigin, sourceOrigin = null, customAllowed = []) {
  if (!destOrigin || typeof destOrigin !== "string") return false;

  let url;
  try {
    url = new URL(destOrigin);
  } catch {
    return false;
  }

  // Strictly enforce http/https protocols (reject file:, data:, about:, javascript:, etc.)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  const originClean = url.origin.toLowerCase();
  const hostname = url.hostname.toLowerCase();

  // 1. Dynamic / caller-allowed list
  if (dynamicAllowedOrigins.has(originClean) || dynamicAllowedOrigins.has(hostname)) {
    return true;
  }
  for (const allowed of customAllowed) {
    if (!allowed) continue;
    try {
      const allowedUrl = new URL(allowed);
      if (originClean === allowedUrl.origin.toLowerCase()) return true;
    } catch {
      if (hostname === allowed.toLowerCase() || hostname.endsWith(`.${allowed.toLowerCase()}`)) return true;
    }
  }

  // 2. Localhost / loopback demo environments
  if (isLocalhost(hostname)) {
    return true;
  }

  // 3. Same-origin release: if the token originated from this exact webpage origin
  if (sourceOrigin && sourceOrigin !== "user_prompt") {
    try {
      const srcUrl = new URL(sourceOrigin);
      if (srcUrl.origin.toLowerCase() === originClean) return true;
    } catch {}
  }

  // 4. Recognized project domains
  for (const domain of TRUSTED_DOMAINS) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      return true;
    }
  }

  return false;
}

// In-memory security decision audit log
const SECURITY_LOGS = [];

/**
 * Validates that a string does not contain an obvious raw PII value.
 * Used to ensure security logs NEVER leak raw sensitive data.
 */
function assertNoRawSensitiveData(text) {
  if (typeof text !== "string") return;
  // Aadhaar 12-digit pattern
  if (/\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/.test(text)) {
    throw new Error("Security Violation: Attempted to log raw Aadhaar number!");
  }
  // Phone 10-digit pattern
  if (/(?<!\w)(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/.test(text)) {
    throw new Error("Security Violation: Attempted to log raw phone number!");
  }
  // Raw email pattern
  if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(text)) {
    throw new Error("Security Violation: Attempted to log raw email address!");
  }
}

/**
 * Logs a sensitive-data release decision.
 * Never stores or exposes raw sensitive values.
 */
export function logSecurityDecision({
  tokenId,
  type,
  destinationOrigin,
  fieldClassification,
  decision, // "ALLOW" | "BLOCK" | "USER_DECISION"
  reason,
  timestamp = Date.now(),
}) {
  const normType = normalizeCategory(type) || type || "UNKNOWN";
  const cleanReason = String(reason || "");
  const cleanOrigin = destinationOrigin ? String(destinationOrigin) : "unknown";

  // Enforce zero raw sensitive values in log fields
  assertNoRawSensitiveData(cleanReason);

  const entry = {
    tokenId: String(tokenId || "unknown"),
    type: normType,
    destinationOrigin: cleanOrigin,
    fieldClassification: Array.isArray(fieldClassification)
      ? fieldClassification
      : fieldClassification instanceof Set
        ? [...fieldClassification]
        : [],
    decision: decision || "BLOCK",
    reason: cleanReason,
    timestamp,
  };

  SECURITY_LOGS.push(entry);
  if (SECURITY_LOGS.length > 500) SECURITY_LOGS.shift();
  return entry;
}

export function getSecurityLogs() {
  return [...SECURITY_LOGS];
}

export function clearSecurityLogs() {
  SECURITY_LOGS.length = 0;
}

/**
 * Centralized Token Release Verification Gate.
 *
 * TOKEN RELEASE = valid provenance
 *                 AND allowed destination origin
 *                 AND matching destination field semantics
 *
 * @param {object} params
 * @param {string} params.token - Token identifier (e.g. "[PHONE_1]")
 * @param {string} params.tokenType - Inferred or explicit category (e.g. "PHONE")
 * @param {object} params.vault - The Vault instance holding tokens and provenance
 * @param {string} params.destinationOrigin - Destination webpage origin
 * @param {object|Element} [params.targetFieldMeta] - Metadata or element for target field
 * @param {boolean} [params.userApproved=false] - Whether explicit user override was given
 * @param {string[]} [params.customAllowedOrigins=[]] - Additional allowed origins
 * @returns {{ allowed: boolean, decision: string, reason: string, blockedToken?: string, blockedType?: string, fieldClassification?: string[] }}
 */
export function verifyTokenReleasePolicy({
  token,
  tokenType,
  vault,
  destinationOrigin,
  targetFieldMeta = null,
  userApproved = false,
  customAllowedOrigins = [],
}) {
  const normType = normalizeCategory(tokenType) || tokenType || "UNKNOWN";

  // 1. Provenance check
  const prov = vault?.getProvenance ? vault.getProvenance(token) : null;
  const hasValidProv = vault?.hasValidProvenance ? vault.hasValidProvenance(token) : false;

  if (!hasValidProv) {
    const reason = `Privacy protection: Token ${token} lacks valid provenance metadata in Vault.`;
    logSecurityDecision({
      tokenId: token,
      type: normType,
      destinationOrigin,
      fieldClassification: [],
      decision: "BLOCK",
      reason,
    });
    return {
      allowed: false,
      decision: "BLOCK",
      reason,
      blockedToken: token,
      blockedType: normType,
    };
  }

  // 2. Destination origin check
  const originAllowed = isAllowedOrigin(destinationOrigin, prov.sourceOrigin, customAllowedOrigins);
  if (!originAllowed) {
    if (userApproved) {
      const reason = `Token release to origin "${destinationOrigin}" authorized via explicit user override.`;
      logSecurityDecision({
        tokenId: token,
        type: normType,
        destinationOrigin,
        fieldClassification: [],
        decision: "USER_DECISION",
        reason,
      });
      return {
        allowed: true,
        decision: "USER_DECISION",
        reason,
        fieldClassification: [],
      };
    }
    const reason = `Privacy protection: Destination origin "${destinationOrigin}" is untrusted or unverified.`;
    logSecurityDecision({
      tokenId: token,
      type: normType,
      destinationOrigin,
      fieldClassification: [],
      decision: "BLOCK",
      reason,
    });
    return {
      allowed: false,
      decision: "BLOCK",
      reason,
      blockedToken: token,
      blockedType: normType,
    };
  }

  // 3. Destination field compatibility check
  const meta = extractFieldMetadata(targetFieldMeta);
  if (!meta) {
    if (userApproved) {
      const reason = `Token release authorized via explicit user override for unidentified field.`;
      logSecurityDecision({
        tokenId: token,
        type: normType,
        destinationOrigin,
        fieldClassification: [],
        decision: "USER_DECISION",
        reason,
      });
      return {
        allowed: true,
        decision: "USER_DECISION",
        reason,
        fieldClassification: [],
      };
    }
    const reason = `Privacy protection: Target field cannot be identified or is invalid.`;
    logSecurityDecision({
      tokenId: token,
      type: normType,
      destinationOrigin,
      fieldClassification: [],
      decision: "BLOCK",
      reason,
    });
    return {
      allowed: false,
      decision: "BLOCK",
      reason,
      blockedToken: token,
      blockedType: normType,
    };
  }

  const fieldMatch = isSensitiveDataAllowed(normType, meta);
  const fieldClasses = classifyField(meta);

  if (!fieldMatch.allowed) {
    if (userApproved) {
      const reason = `Token release authorized via explicit user override.`;
      logSecurityDecision({
        tokenId: token,
        type: normType,
        destinationOrigin,
        fieldClassification: fieldClasses,
        decision: "USER_DECISION",
        reason,
      });
      return {
        allowed: true,
        decision: "USER_DECISION",
        reason,
        fieldClassification: [...fieldClasses],
      };
    }
    const reason = fieldMatch.reason || `Privacy protection: Field does not semantically match sensitive type ${normType}.`;
    logSecurityDecision({
      tokenId: token,
      type: normType,
      destinationOrigin,
      fieldClassification: fieldClasses,
      decision: "BLOCK",
      reason,
    });
    return {
      allowed: false,
      decision: "BLOCK",
      reason,
      blockedToken: token,
      blockedType: normType,
      fieldClassification: [...fieldClasses],
    };
  }

  // 4. Explicit user override vs standard policy match
  if (userApproved) {
    const reason = `Token release authorized via explicit user override.`;
    logSecurityDecision({
      tokenId: token,
      type: normType,
      destinationOrigin,
      fieldClassification: fieldClasses,
      decision: "USER_DECISION",
      reason,
    });
    return {
      allowed: true,
      decision: "USER_DECISION",
      reason,
      fieldClassification: [...fieldClasses],
    };
  }

  // Standard verified release
  const reason = `Token release verified: valid provenance, trusted origin, and matching field semantics.`;
  logSecurityDecision({
    tokenId: token,
    type: normType,
    destinationOrigin,
    fieldClassification: fieldClasses,
    decision: "ALLOW",
    reason,
  });

  return {
    allowed: true,
    decision: "ALLOW",
    reason,
    fieldClassification: [...fieldClasses],
  };
}
