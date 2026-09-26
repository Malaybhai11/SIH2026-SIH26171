import test from "node:test";
import assert from "node:assert/strict";
import {
  extractFieldMetadata,
  classifyField,
  detectSensitiveDataTypes,
  isSensitiveDataAllowed,
} from "./fieldCompatibility.js";

test("1. Phone -> Phone field -> ALLOW", () => {
  const phoneFieldTel = { type: "tel", name: "phone", placeholder: "Phone number", labelText: "Mobile Phone" };
  const resTel = isSensitiveDataAllowed("PHONE", phoneFieldTel);
  assert.equal(resTel.allowed, true);

  const phoneFieldText = { type: "text", name: "mobile_no", labelText: "Enter Mobile Number" };
  const resText = isSensitiveDataAllowed("PHONE", phoneFieldText);
  assert.equal(resText.allowed, true);

  const resToken = isSensitiveDataAllowed(detectSensitiveDataTypes("[PHONE_1]"), phoneFieldTel);
  assert.equal(resToken.allowed, true);
});

test("2. Phone -> Generic text field -> BLOCK", () => {
  const genericField = { type: "text", name: "info", placeholder: "Enter information", labelText: "" };
  const res = isSensitiveDataAllowed("PHONE", genericField);
  assert.equal(res.allowed, false);
  assert.match(res.reason, /Privacy protection:/i);
  assert.equal(res.blockedType, "PHONE");

  // Also with raw phone number in detectSensitiveDataTypes
  const types = detectSensitiveDataTypes("9876543210");
  const resRaw = isSensitiveDataAllowed(types, genericField);
  assert.equal(resRaw.allowed, false);
  assert.equal(resRaw.blockedType, "PHONE");
});

test("3. Phone -> Email field -> BLOCK", () => {
  const emailField = { type: "email", name: "email", placeholder: "name@example.com", labelText: "Email Address" };
  const res = isSensitiveDataAllowed("PHONE", emailField);
  assert.equal(res.allowed, false);
  assert.match(res.reason, /Privacy protection:/i);
  assert.equal(res.blockedType, "PHONE");
});

test("4. Email -> Email field -> ALLOW", () => {
  const emailField = { type: "email", name: "user_email", labelText: "Email" };
  const res = isSensitiveDataAllowed("EMAIL", emailField);
  assert.equal(res.allowed, true);

  const emailFieldText = { type: "text", name: "email_address", labelText: "Enter your email" };
  const resText = isSensitiveDataAllowed("EMAIL", emailFieldText);
  assert.equal(resText.allowed, true);

  const resToken = isSensitiveDataAllowed(detectSensitiveDataTypes("[EMAIL_1]"), emailField);
  assert.equal(resToken.allowed, true);
});

test("5. Email -> Generic text field -> BLOCK", () => {
  const genericField = { type: "text", name: "misc", placeholder: "Enter text" };
  const res = isSensitiveDataAllowed("EMAIL", genericField);
  assert.equal(res.allowed, false);
  assert.match(res.reason, /Privacy protection:/i);
  assert.equal(res.blockedType, "EMAIL");

  const types = detectSensitiveDataTypes("test.user@example.com");
  const resRaw = isSensitiveDataAllowed(types, genericField);
  assert.equal(resRaw.allowed, false);
  assert.equal(resRaw.blockedType, "EMAIL");
});

test("6. Email -> Phone field -> BLOCK", () => {
  const phoneField = { type: "tel", name: "phone", labelText: "Mobile Number" };
  const res = isSensitiveDataAllowed("EMAIL", phoneField);
  assert.equal(res.allowed, false);
  assert.match(res.reason, /Privacy protection:/i);
  assert.equal(res.blockedType, "EMAIL");
});

test("7. Aadhaar -> Aadhaar field -> ALLOW", () => {
  const aadhaarField = { type: "text", name: "aadhaar_no", labelText: "Aadhaar Number", placeholder: "12-digit UID" };
  const res = isSensitiveDataAllowed("AADHAAR", aadhaarField);
  assert.equal(res.allowed, true);

  const uidField = { type: "text", name: "uid", labelText: "Enter UID" };
  const resUid = isSensitiveDataAllowed("AADHAAR", uidField);
  assert.equal(resUid.allowed, true);

  const resToken = isSensitiveDataAllowed(detectSensitiveDataTypes("[AADHAAR_1]"), aadhaarField);
  assert.equal(resToken.allowed, true);
});

test("8. Aadhaar -> Generic text field -> BLOCK", () => {
  const genericField = { type: "text", name: "input_val", placeholder: "Type here" };
  const res = isSensitiveDataAllowed("AADHAAR", genericField);
  assert.equal(res.allowed, false);
  assert.match(res.reason, /Privacy protection:/i);
  assert.equal(res.blockedType, "AADHAAR");
});

test("9. Aadhaar -> Email field -> BLOCK", () => {
  const emailField = { type: "email", name: "email", labelText: "Your Email" };
  const res = isSensitiveDataAllowed("AADHAAR", emailField);
  assert.equal(res.allowed, false);
  assert.match(res.reason, /Privacy protection:/i);
  assert.equal(res.blockedType, "AADHAAR");
});

test("10. Sensitive data -> unknown/ambiguous field -> BLOCK", () => {
  const unknownField = { type: "text", name: "f_01", id: "random_id_99" };
  assert.equal(isSensitiveDataAllowed("PHONE", unknownField).allowed, false);
  assert.equal(isSensitiveDataAllowed("EMAIL", unknownField).allowed, false);
  assert.equal(isSensitiveDataAllowed("AADHAAR", unknownField).allowed, false);

  // Comments / Description / Message fields
  const commentsField = { type: "text", name: "comments", placeholder: "Leave a comment", labelText: "Comments" };
  assert.equal(isSensitiveDataAllowed("PHONE", commentsField).allowed, false);
  assert.equal(isSensitiveDataAllowed("EMAIL", commentsField).allowed, false);
  assert.equal(isSensitiveDataAllowed("AADHAAR", commentsField).allowed, false);
});

test("11. Existing non-sensitive autofill behavior -> should continue working", () => {
  const genericField = { type: "text", name: "institution", labelText: "Institution Name" };
  const nonSensitiveTypes = detectSensitiveDataTypes("Gujarat University");
  assert.deepEqual(nonSensitiveTypes, []);

  const res = isSensitiveDataAllowed(nonSensitiveTypes, genericField);
  assert.equal(res.allowed, true);

  const searchField = { type: "search", name: "q", placeholder: "Search articles" };
  const searchTypes = detectSensitiveDataTypes("space exploration");
  assert.equal(isSensitiveDataAllowed(searchTypes, searchField).allowed, true);
});

test("12. User explicitly requesting sensitive data in a generic field -> still BLOCK", () => {
  // Even if the action attempts to type [EMAIL_1] or [PHONE_1] into a generic comment field
  const genericMessageField = {
    tag: "textarea",
    type: "textarea",
    name: "message",
    placeholder: "Write your message here",
  };

  const emailTypes = detectSensitiveDataTypes("priya.sharma@gmail.com", ["EMAIL"]);
  const resEmail = isSensitiveDataAllowed(emailTypes, genericMessageField);
  assert.equal(resEmail.allowed, false);
  assert.match(resEmail.reason, /Privacy protection:/i);

  const phoneTypes = detectSensitiveDataTypes("9876543210", ["PHONE"]);
  const resPhone = isSensitiveDataAllowed(phoneTypes, genericMessageField);
  assert.equal(resPhone.allowed, false);
  assert.match(resPhone.reason, /Privacy protection:/i);
});
