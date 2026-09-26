import test from "node:test";
import assert from "node:assert/strict";
import { Vault } from "./redact.js";
import { rehydrateAction } from "./privacyPipeline.js";
import {
  isAllowedOrigin,
  verifyTokenReleasePolicy,
  getSecurityLogs,
  clearSecurityLogs,
} from "./tokenReleasePolicy.js";

// Helper to simulate webpage sink environments and verify zero data exposure
function createWebpageEnvironment(initialFieldValue = "") {
  return {
    domValue: initialFieldValue,
    messagePayloadsReceived: [],
    clipboardContent: null,
    networkRequests: [],
    // Simulate receiving an action payload from the extension
    receiveActionPayload(actionPayload) {
      this.messagePayloadsReceived.push(JSON.parse(JSON.stringify(actionPayload)));
    },
    // Simulate DOM input update
    updateDomInput(val) {
      this.domValue = val;
    },
    // Simulate clipboard copy
    copyToClipboard(text) {
      this.clipboardContent = text;
    },
    // Assert that the raw sensitive secret NEVER appears in any sink
    assertZeroLeak(rawSecret, scenarioName = "") {
      const serializedMessages = JSON.stringify(this.messagePayloadsReceived);
      const domText = String(this.domValue);
      const clipText = String(this.clipboardContent || "");
      const netText = JSON.stringify(this.networkRequests);

      assert.equal(
        serializedMessages.includes(rawSecret),
        false,
        `[LEAK DETECTED in ${scenarioName}]: Raw sensitive value "${rawSecret}" found in message payloads!`,
      );
      assert.equal(
        domText.includes(rawSecret),
        false,
        `[LEAK DETECTED in ${scenarioName}]: Raw sensitive value "${rawSecret}" found in DOM value!`,
      );
      assert.equal(
        clipText.includes(rawSecret),
        false,
        `[LEAK DETECTED in ${scenarioName}]: Raw sensitive value "${rawSecret}" found in clipboard!`,
      );
      assert.equal(
        netText.includes(rawSecret),
        false,
        `[LEAK DETECTED in ${scenarioName}]: Raw sensitive value "${rawSecret}" found in network payloads!`,
      );
    },
  };
}

// Ensure security audit logs never contain raw sensitive values
function assertZeroSecretInLogs(rawSecret) {
  const serializedLogs = JSON.stringify(getSecurityLogs());
  assert.equal(
    serializedLogs.includes(rawSecret),
    false,
    `[SECURITY AUDIT LEAK]: Raw sensitive value "${rawSecret}" was found inside security audit logs!`,
  );
}

// Setup a clean Vault with known test secrets and provenance
function setupTestVault() {
  const vault = new Vault();
  const rawPhone = "9876543210";
  const rawEmail = "priya.sharma@gmail.com";
  const rawAadhaar = "234567890124";

  const phoneToken = vault.tokenFor("PHONE", rawPhone, {
    sourceOrigin: "https://trusted.example.com",
    sourceFieldType: "phone",
  });
  const emailToken = vault.tokenFor("EMAIL", rawEmail, {
    sourceOrigin: "https://trusted.example.com",
    sourceFieldType: "email",
  });
  const aadhaarToken = vault.tokenFor("AADHAAR", rawAadhaar, {
    sourceOrigin: "https://trusted.example.com",
    sourceFieldType: "aadhaar",
  });

  return { vault, rawPhone, rawEmail, rawAadhaar, phoneToken, emailToken, aadhaarToken };
}

// ==============================================================================
// 10 RED-TEAM ATTACK SCENARIOS (P0 Security Policy Verification)
// ==============================================================================

test("Red-Team Attack Scenario 1: PHONE token -> comment box", () => {
  clearSecurityLogs();
  const { vault, rawPhone, phoneToken } = setupTestVault();
  const page = createWebpageEnvironment();

  const commentField = {
    tag: "textarea",
    type: "textarea",
    name: "comments",
    placeholder: "Leave your comments here",
    labelText: "User Comments",
  };
  const action = { type: "type", targetId: "field_comment", text: phoneToken };
  const context = {
    destinationOrigin: "https://trusted.example.com",
    targetFieldMeta: commentField,
  };

  // Run rehydration through centralized security decision
  const result = rehydrateAction(action, vault, context);

  // Check A: Action must be BLOCKED
  assert.equal(result.__securityDecision.allowed, false);
  assert.equal(result.__securityDecision.decision, "BLOCK");
  assert.equal(result.__blocked, true);

  // Check B: Real sensitive value must NEVER reach the webpage or outgoing action
  assert.notEqual(result.text, rawPhone);
  assert.equal(result.text, phoneToken); // remains un-rehydrated safe token

  // Simulate attempted dispatch: since blocked, safe handler does not inject or transmit raw value
  page.receiveActionPayload(result);
  page.assertZeroLeak(rawPhone, "Scenario 1 (PHONE -> Comment Box)");
  assertZeroSecretInLogs(rawPhone);
});

test("Red-Team Attack Scenario 2: PHONE token -> search box", () => {
  clearSecurityLogs();
  const { vault, rawPhone, phoneToken } = setupTestVault();
  const page = createWebpageEnvironment();

  const searchField = {
    tag: "input",
    type: "search",
    name: "q",
    placeholder: "Search entire catalog...",
    labelText: "Search",
  };
  const action = { type: "type", targetId: "field_search", text: phoneToken };
  const context = {
    destinationOrigin: "https://trusted.example.com",
    targetFieldMeta: searchField,
  };

  const result = rehydrateAction(action, vault, context);

  // Check A: Action must be BLOCKED
  assert.equal(result.__securityDecision.allowed, false);
  assert.equal(result.__securityDecision.decision, "BLOCK");
  assert.equal(result.__blocked, true);

  // Check B: Real sensitive value must NEVER reach the webpage
  assert.notEqual(result.text, rawPhone);
  assert.equal(result.text, phoneToken);
  page.receiveActionPayload(result);
  page.assertZeroLeak(rawPhone, "Scenario 2 (PHONE -> Search Box)");
  assertZeroSecretInLogs(rawPhone);
});

test("Red-Team Attack Scenario 3: PHONE token -> generic text box", () => {
  clearSecurityLogs();
  const { vault, rawPhone, phoneToken } = setupTestVault();
  const page = createWebpageEnvironment();

  const genericField = {
    tag: "input",
    type: "text",
    name: "notes",
    placeholder: "Enter details",
    labelText: "",
  };
  const action = { type: "type", targetId: "field_generic", text: phoneToken };
  const context = {
    destinationOrigin: "https://trusted.example.com",
    targetFieldMeta: genericField,
  };

  const result = rehydrateAction(action, vault, context);

  // Check A: Action must be BLOCKED
  assert.equal(result.__securityDecision.allowed, false);
  assert.equal(result.__securityDecision.decision, "BLOCK");
  assert.equal(result.__blocked, true);

  // Check B: Real sensitive value must NEVER reach the webpage
  assert.notEqual(result.text, rawPhone);
  assert.equal(result.text, phoneToken);
  page.receiveActionPayload(result);
  page.assertZeroLeak(rawPhone, "Scenario 3 (PHONE -> Generic Text Box)");
  assertZeroSecretInLogs(rawPhone);
});

test("Red-Team Attack Scenario 4: PHONE token -> misleading/fake phone field on an untrusted origin", () => {
  clearSecurityLogs();
  const { vault, rawPhone, phoneToken } = setupTestVault();
  const page = createWebpageEnvironment();

  // Attack page crafts a perfectly formatted phone field, but runs on an untrusted phishing domain
  const attackerPhoneField = {
    tag: "input",
    type: "tel",
    name: "phone",
    placeholder: "Phone number",
    labelText: "Mobile Phone",
  };
  const action = { type: "type", targetId: "attacker_phone", text: phoneToken };
  const context = {
    destinationOrigin: "https://malicious-phishing-attacker.com",
    targetFieldMeta: attackerPhoneField,
  };

  const result = rehydrateAction(action, vault, context);

  // Check A: Action must be BLOCKED because the origin is untrusted
  assert.equal(result.__securityDecision.allowed, false);
  assert.equal(result.__securityDecision.decision, "BLOCK");
  assert.equal(result.__blocked, true);
  assert.match(result.__securityDecision.reason, /untrusted or unverified/i);

  // Check B: Real sensitive value must NEVER reach the attacking webpage
  assert.notEqual(result.text, rawPhone);
  assert.equal(result.text, phoneToken);
  page.receiveActionPayload(result);
  page.assertZeroLeak(rawPhone, "Scenario 4 (PHONE -> Untrusted Origin Phishing Field)");
  assertZeroSecretInLogs(rawPhone);
});

test("Red-Team Attack Scenario 5: EMAIL token -> generic text field", () => {
  clearSecurityLogs();
  const { vault, rawEmail, emailToken } = setupTestVault();
  const page = createWebpageEnvironment();

  const genericField = {
    tag: "input",
    type: "text",
    name: "input_val",
    placeholder: "Type whatever",
  };
  const action = { type: "type", targetId: "field_generic", text: emailToken };
  const context = {
    destinationOrigin: "https://trusted.example.com",
    targetFieldMeta: genericField,
  };

  const result = rehydrateAction(action, vault, context);

  // Check A: Action must be BLOCKED
  assert.equal(result.__securityDecision.allowed, false);
  assert.equal(result.__securityDecision.decision, "BLOCK");
  assert.equal(result.__blocked, true);

  // Check B: Real sensitive value must NEVER reach the webpage
  assert.notEqual(result.text, rawEmail);
  assert.equal(result.text, emailToken);
  page.receiveActionPayload(result);
  page.assertZeroLeak(rawEmail, "Scenario 5 (EMAIL -> Generic Text Field)");
  assertZeroSecretInLogs(rawEmail);
});

test("Red-Team Attack Scenario 6: EMAIL token -> comment field", () => {
  clearSecurityLogs();
  const { vault, rawEmail, emailToken } = setupTestVault();
  const page = createWebpageEnvironment();

  const commentField = {
    tag: "textarea",
    name: "feedback",
    placeholder: "Your feedback",
    labelText: "Leave feedback message",
  };
  const action = { type: "type", targetId: "field_feedback", text: emailToken };
  const context = {
    destinationOrigin: "https://trusted.example.com",
    targetFieldMeta: commentField,
  };

  const result = rehydrateAction(action, vault, context);

  // Check A: Action must be BLOCKED
  assert.equal(result.__securityDecision.allowed, false);
  assert.equal(result.__securityDecision.decision, "BLOCK");
  assert.equal(result.__blocked, true);

  // Check B: Real sensitive value must NEVER reach the webpage
  assert.notEqual(result.text, rawEmail);
  assert.equal(result.text, emailToken);
  page.receiveActionPayload(result);
  page.assertZeroLeak(rawEmail, "Scenario 6 (EMAIL -> Comment Field)");
  assertZeroSecretInLogs(rawEmail);
});

test("Red-Team Attack Scenario 7: AADHAAR token -> search field", () => {
  clearSecurityLogs();
  const { vault, rawAadhaar, aadhaarToken } = setupTestVault();
  const page = createWebpageEnvironment();

  const searchField = {
    tag: "input",
    type: "search",
    name: "search_query",
    placeholder: "Search citizen directory",
  };
  const action = { type: "type", targetId: "field_search", text: aadhaarToken };
  const context = {
    destinationOrigin: "https://trusted.example.com",
    targetFieldMeta: searchField,
  };

  const result = rehydrateAction(action, vault, context);

  // Check A: Action must be BLOCKED
  assert.equal(result.__securityDecision.allowed, false);
  assert.equal(result.__securityDecision.decision, "BLOCK");
  assert.equal(result.__blocked, true);

  // Check B: Real sensitive value must NEVER reach the webpage
  assert.notEqual(result.text, rawAadhaar);
  assert.equal(result.text, aadhaarToken);
  page.receiveActionPayload(result);
  page.assertZeroLeak(rawAadhaar, "Scenario 7 (AADHAAR -> Search Field)");
  assertZeroSecretInLogs(rawAadhaar);
});

test("Red-Team Attack Scenario 8: AADHAAR token -> generic text field", () => {
  clearSecurityLogs();
  const { vault, rawAadhaar, aadhaarToken } = setupTestVault();
  const page = createWebpageEnvironment();

  const genericField = {
    tag: "input",
    type: "text",
    name: "misc",
    placeholder: "Enter details",
  };
  const action = { type: "type", targetId: "field_misc", text: aadhaarToken };
  const context = {
    destinationOrigin: "https://trusted.example.com",
    targetFieldMeta: genericField,
  };

  const result = rehydrateAction(action, vault, context);

  // Check A: Action must be BLOCKED
  assert.equal(result.__securityDecision.allowed, false);
  assert.equal(result.__securityDecision.decision, "BLOCK");
  assert.equal(result.__blocked, true);

  // Check B: Real sensitive value must NEVER reach the webpage
  assert.notEqual(result.text, rawAadhaar);
  assert.equal(result.text, aadhaarToken);
  page.receiveActionPayload(result);
  page.assertZeroLeak(rawAadhaar, "Scenario 8 (AADHAAR -> Generic Text Field)");
  assertZeroSecretInLogs(rawAadhaar);
});

test("Red-Team Attack Scenario 9: Sensitive token -> unknown/ambiguous field", () => {
  clearSecurityLogs();
  const { vault, rawPhone, phoneToken } = setupTestVault();
  const page = createWebpageEnvironment();

  const ambiguousField = {
    tag: "input",
    type: "text",
    name: "f_xyz_01",
    id: "random_id_999",
  };
  const action = { type: "type", targetId: "field_ambiguous", text: phoneToken };
  const context = {
    destinationOrigin: "https://trusted.example.com",
    targetFieldMeta: ambiguousField,
  };

  const result = rehydrateAction(action, vault, context);

  // Check A: Action must be BLOCKED (Fail-Closed default)
  assert.equal(result.__securityDecision.allowed, false);
  assert.equal(result.__securityDecision.decision, "BLOCK");
  assert.equal(result.__blocked, true);

  // Check B: Real sensitive value must NEVER reach the webpage
  assert.notEqual(result.text, rawPhone);
  assert.equal(result.text, phoneToken);
  page.receiveActionPayload(result);
  page.assertZeroLeak(rawPhone, "Scenario 9 (Sensitive Token -> Ambiguous Field)");
  assertZeroSecretInLogs(rawPhone);
});

test("Red-Team Attack Scenario 10: Sensitive token -> untrusted origin requesting an otherwise matching field", () => {
  clearSecurityLogs();
  const { vault, rawEmail, rawAadhaar, emailToken, aadhaarToken } = setupTestVault();
  const page = createWebpageEnvironment();

  // Attacker site provides matching email and aadhaar fields
  const matchingEmailField = {
    tag: "input",
    type: "email",
    name: "email",
    labelText: "Email Address",
  };
  const matchingAadhaarField = {
    tag: "input",
    type: "text",
    name: "aadhaar",
    labelText: "Enter Aadhaar UID",
  };

  const fillFormAction = {
    type: "fill_form",
    fields: [
      { targetId: "f_email", text: emailToken },
      { targetId: "f_aadhaar", text: aadhaarToken },
    ],
  };

  const context = {
    destinationOrigin: "https://evil-data-broker-harvest.net", // Untrusted origin!
    targetFields: {
      f_email: matchingEmailField,
      f_aadhaar: matchingAadhaarField,
    },
  };

  const result = rehydrateAction(fillFormAction, vault, context);

  // Check A: Action must be BLOCKED on origin grounds despite field match
  assert.equal(result.__securityDecision.allowed, false);
  assert.equal(result.__securityDecision.decision, "BLOCK");
  assert.equal(result.__blocked, true);

  // Check B: Real sensitive values must NEVER reach the attacking webpage
  assert.notEqual(result.fields[0].text, rawEmail);
  assert.notEqual(result.fields[1].text, rawAadhaar);
  assert.equal(result.fields[0].text, emailToken);
  assert.equal(result.fields[1].text, aadhaarToken);

  page.receiveActionPayload(result);
  page.assertZeroLeak(rawEmail, "Scenario 10 (Email to Untrusted Origin)");
  page.assertZeroLeak(rawAadhaar, "Scenario 10 (Aadhaar to Untrusted Origin)");
  assertZeroSecretInLogs(rawEmail);
  assertZeroSecretInLogs(rawAadhaar);
});

// ==============================================================================
// VERIFICATION OF ALLOWED RELEASES & USER OVERRIDE FLOWS
// ==============================================================================

test("Valid Token Release: PHONE -> phone field on trusted origin -> ALLOW", () => {
  clearSecurityLogs();
  const { vault, rawPhone, phoneToken } = setupTestVault();
  const page = createWebpageEnvironment();

  const phoneField = {
    tag: "input",
    type: "tel",
    name: "mobile",
    labelText: "Mobile Phone Number",
  };
  const action = { type: "type", targetId: "phone_field", text: phoneToken };
  const context = {
    destinationOrigin: "https://trusted.example.com",
    targetFieldMeta: phoneField,
  };

  const result = rehydrateAction(action, vault, context);

  assert.equal(result.__securityDecision.allowed, true);
  assert.equal(result.__securityDecision.decision, "ALLOW");
  assert.equal(result.text, rawPhone); // Real value released safely when ALL checks pass

  page.receiveActionPayload(result);
  page.updateDomInput(result.text);
  assert.equal(page.domValue, rawPhone);
  assertZeroSecretInLogs(rawPhone);
});

test("Valid Token Release: EMAIL -> email field on trusted origin -> ALLOW", () => {
  clearSecurityLogs();
  const { vault, rawEmail, emailToken } = setupTestVault();
  const page = createWebpageEnvironment();

  const emailField = {
    tag: "input",
    type: "email",
    name: "email",
    labelText: "Work Email",
  };
  const action = { type: "type", targetId: "email_field", text: emailToken };
  const context = {
    destinationOrigin: "https://mail.google.com",
    targetFieldMeta: emailField,
  };

  const result = rehydrateAction(action, vault, context);

  assert.equal(result.__securityDecision.allowed, true);
  assert.equal(result.__securityDecision.decision, "ALLOW");
  assert.equal(result.text, rawEmail);

  page.receiveActionPayload(result);
  page.updateDomInput(result.text);
  assert.equal(page.domValue, rawEmail);
  assertZeroSecretInLogs(rawEmail);
});

test("Valid Token Release: AADHAAR -> Aadhaar field on trusted origin -> ALLOW", () => {
  clearSecurityLogs();
  const { vault, rawAadhaar, aadhaarToken } = setupTestVault();
  const page = createWebpageEnvironment();

  const aadhaarField = {
    tag: "input",
    type: "text",
    name: "aadhaar_no",
    labelText: "Enter 12-digit Aadhaar UID",
    placeholder: "Aadhaar Number",
  };
  const action = { type: "type", targetId: "uid_field", text: aadhaarToken };
  const context = {
    destinationOrigin: "http://localhost:8000",
    targetFieldMeta: aadhaarField,
  };

  const result = rehydrateAction(action, vault, context);

  assert.equal(result.__securityDecision.allowed, true);
  assert.equal(result.__securityDecision.decision, "ALLOW");
  assert.equal(result.text, rawAadhaar);

  page.receiveActionPayload(result);
  page.updateDomInput(result.text);
  assert.equal(page.domValue, rawAadhaar);
  assertZeroSecretInLogs(rawAadhaar);
});

test("User Override: Blocked release authorized via explicit user decision -> USER_DECISION", () => {
  clearSecurityLogs();
  const { vault, rawPhone, phoneToken } = setupTestVault();

  const genericField = {
    tag: "input",
    type: "text",
    name: "other_field",
    labelText: "Other",
  };
  const action = { type: "type", targetId: "f1", text: phoneToken };

  // Step 1: Without user approval -> strictly BLOCKED
  const blockedResult = rehydrateAction(action, vault, {
    destinationOrigin: "https://trusted.example.com",
    targetFieldMeta: genericField,
    userApproved: false,
  });
  assert.equal(blockedResult.__securityDecision.allowed, false);
  assert.equal(blockedResult.__securityDecision.decision, "BLOCK");
  assert.equal(blockedResult.text, phoneToken);

  // Step 2: With explicit user override -> authorized as USER_DECISION
  const userApprovedResult = rehydrateAction(action, vault, {
    destinationOrigin: "https://trusted.example.com",
    targetFieldMeta: genericField,
    userApproved: true,
  });
  assert.equal(userApprovedResult.__securityDecision.allowed, true);
  assert.equal(userApprovedResult.__securityDecision.decision, "USER_DECISION");
  assert.equal(userApprovedResult.text, rawPhone);
  assertZeroSecretInLogs(rawPhone);
});

test("Provenance Integrity: Token without provenance metadata is strictly BLOCKED", () => {
  clearSecurityLogs();
  const vault = new Vault();
  // Manually insert value without provenance
  vault.values.set("[PHONE_99]", "9876543210");

  const action = { type: "type", targetId: "f_phone", text: "[PHONE_99]" };
  const phoneField = { type: "tel", name: "phone", labelText: "Mobile" };

  const result = rehydrateAction(action, vault, {
    destinationOrigin: "https://trusted.example.com",
    targetFieldMeta: phoneField,
  });

  assert.equal(result.__securityDecision.allowed, false);
  assert.equal(result.__securityDecision.decision, "BLOCK");
  assert.match(result.__securityDecision.reason, /provenance/i);
  assert.equal(result.text, "[PHONE_99]");
  assertZeroSecretInLogs("9876543210");
});
