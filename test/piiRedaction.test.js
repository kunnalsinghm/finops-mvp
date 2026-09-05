// test/piiRedaction.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const { redactText, redactValue } = require("../server/piiRedaction");

test("redactText replaces an email address and counts it", () => {
  const { text, counts } = redactText("contact me at jane.doe@example.com please");
  assert.equal(text, "contact me at [REDACTED_EMAIL] please");
  assert.deepEqual(counts, { EMAIL: 1 });
});

test("redactText replaces a US SSN", () => {
  const { text, counts } = redactText("SSN: 123-45-6789 on file");
  assert.equal(text, "SSN: [REDACTED_SSN] on file");
  assert.deepEqual(counts, { SSN: 1 });
});

test("redactText does NOT flag a bare 9-digit number as an SSN (avoids over-redacting order/invoice numbers)", () => {
  const { text, counts } = redactText("invoice number 123456789");
  assert.equal(text, "invoice number 123456789");
  assert.deepEqual(counts, {});
});

test("redactText replaces a valid credit card number (passes Luhn) but leaves a random 16-digit number alone", () => {
  // 4111111111111111 is the standard Visa test number and passes Luhn.
  const valid = redactText("card 4111111111111111 charged");
  assert.equal(valid.text, "card [REDACTED_CREDIT_CARD] charged");
  assert.deepEqual(valid.counts, { CREDIT_CARD: 1 });

  // 16 digits, does not pass Luhn - should be left alone rather than
  // flagged, to avoid constant false positives on IDs/tokens.
  const invalid = redactText("tracking id 1234567890123456");
  assert.equal(invalid.text, "tracking id 1234567890123456");
  assert.deepEqual(invalid.counts, {});
});

test("redactText replaces a hyphenated US phone number", () => {
  const { text, counts } = redactText("call me at 555-123-4567 tomorrow");
  assert.equal(text, "call me at [REDACTED_PHONE] tomorrow");
  assert.deepEqual(counts, { PHONE: 1 });
});

test("redactText replaces an IPv4 address", () => {
  const { text, counts } = redactText("server logged in from 192.168.1.100 today");
  assert.equal(text, "server logged in from [REDACTED_IP_ADDRESS] today");
  assert.deepEqual(counts, { IP_ADDRESS: 1 });
});

test("redactText handles multiple PII types in one string, each counted separately", () => {
  const { text, counts } = redactText(
    "Reach jane@example.com or 555-987-6543, SSN 987-65-4321, from 10.0.0.5"
  );
  assert.match(text, /\[REDACTED_EMAIL\]/);
  assert.match(text, /\[REDACTED_PHONE\]/);
  assert.match(text, /\[REDACTED_SSN\]/);
  assert.match(text, /\[REDACTED_IP_ADDRESS\]/);
  assert.deepEqual(counts, { EMAIL: 1, PHONE: 1, SSN: 1, IP_ADDRESS: 1 });
});

test("redactText leaves clean text with no PII completely unchanged", () => {
  const { text, counts } = redactText("Summarize the quarterly report for the board");
  assert.equal(text, "Summarize the quarterly report for the board");
  assert.deepEqual(counts, {});
});

test("redactText handles empty and non-string input gracefully", () => {
  assert.deepEqual(redactText(""), { text: "", counts: {} });
  assert.deepEqual(redactText(undefined), { text: undefined, counts: {} });
  assert.deepEqual(redactText(null), { text: null, counts: {} });
});

test("redactValue deep-redacts strings inside a nested object, preserving structure", () => {
  const input = {
    model: "gpt-4o",
    messages: [
      { role: "user", content: "my email is bob@example.com" },
      { role: "assistant", content: "got it, no PII here" },
    ],
    meta: { requester_ip: "203.0.113.5" },
  };

  const { value, counts, hasPII } = redactValue(input);

  assert.equal(value.model, "gpt-4o"); // non-PII fields untouched
  assert.equal(value.messages[0].content, "my email is [REDACTED_EMAIL]");
  assert.equal(value.messages[1].content, "got it, no PII here");
  assert.equal(value.meta.requester_ip, "[REDACTED_IP_ADDRESS]");
  assert.equal(hasPII, true);
  assert.deepEqual(counts, { EMAIL: 1, IP_ADDRESS: 1 });
});

test("redactValue reports hasPII:false and empty counts when nothing matches", () => {
  const { value, counts, hasPII } = redactValue({ model: "gpt-4o", messages: [{ role: "user", content: "hello" }] });
  assert.equal(hasPII, false);
  assert.deepEqual(counts, {});
  assert.equal(value.messages[0].content, "hello");
});

test("redactValue handles arrays and primitives at the top level without throwing", () => {
  assert.deepEqual(redactValue(42).value, 42);
  assert.deepEqual(redactValue(null).value, null);
  assert.deepEqual(redactValue(["a@b.com", "clean"]).value, ["[REDACTED_EMAIL]", "clean"]);
});

