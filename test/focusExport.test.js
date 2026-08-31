// test/focusExport.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const { toFocusRow, toFocusRows, FOCUS_COLUMNS, billingPeriodFor, buildTags } = require("../server/focusExport");

function sampleRow(overrides = {}) {
  return {
    event_time: "2026-03-15T10:30:00.000Z",
    provider: "openai",
    model: "gpt-4o-mini",
    team: "growth",
    environment: "production",
    git_branch: "main",
    input_tokens: 500,
    output_tokens: 150,
    cost_usd: 0.0042,
    ...overrides,
  };
}

test("toFocusRow maps BilledCost and EffectiveCost from cost_usd", () => {
  const row = toFocusRow(sampleRow());
  assert.equal(row.BilledCost, 0.0042);
  assert.equal(row.EffectiveCost, 0.0042);
});

test("toFocusRow maps Provider, Publisher, and ServiceName correctly", () => {
  const row = toFocusRow(sampleRow());
  assert.equal(row.Provider, "openai");
  assert.equal(row.Publisher, "openai");
  assert.equal(row.ServiceName, "gpt-4o-mini");
});

test("toFocusRow sums input and output tokens into ConsumedQuantity", () => {
  const row = toFocusRow(sampleRow({ input_tokens: 500, output_tokens: 150 }));
  assert.equal(row.ConsumedQuantity, 650);
  assert.equal(row.ConsumedUnit, "Tokens");
});

test("toFocusRow builds a composite SkuId from provider and model", () => {
  const row = toFocusRow(sampleRow());
  assert.equal(row.SkuId, "openai:gpt-4o-mini");
});

test("toFocusRow sets non-applicable columns to null, not fake values", () => {
  const row = toFocusRow(sampleRow());
  assert.equal(row.RegionId, null);
  assert.equal(row.ResourceId, null);
  assert.equal(row.CommitmentDiscountType, null);
  assert.equal(row.ContractedCost, null);
});

test("toFocusRow encodes team/environment/git_branch into the Tags key-value JSON", () => {
  const row = toFocusRow(sampleRow());
  const tags = JSON.parse(row.Tags);
  assert.equal(tags.team, "growth");
  assert.equal(tags.environment, "production");
  assert.equal(tags.git_branch, "main");
});

test("toFocusRow sets Tags to null when no team/environment/git_branch present", () => {
  const row = toFocusRow(sampleRow({ team: null, environment: null, git_branch: null }));
  assert.equal(row.Tags, null);
});

test("billingPeriodFor returns the first and first-of-next-month for a given date", () => {
  const { start, end } = billingPeriodFor("2026-03-15T10:30:00.000Z");
  assert.equal(start, "2026-03-01T00:00:00.000Z");
  assert.equal(end, "2026-04-01T00:00:00.000Z");
});

test("billingPeriodFor handles December -> January year rollover", () => {
  const { start, end } = billingPeriodFor("2026-12-25T00:00:00.000Z");
  assert.equal(start, "2026-12-01T00:00:00.000Z");
  assert.equal(end, "2027-01-01T00:00:00.000Z");
});

test("billingPeriodFor returns nulls for an invalid date", () => {
  const { start, end } = billingPeriodFor("not-a-date");
  assert.equal(start, null);
  assert.equal(end, null);
});

test("toFocusRows produces one output row per input row, preserving order", () => {
  const rows = [sampleRow({ model: "gpt-4o-mini" }), sampleRow({ model: "gpt-4o" })];
  const result = toFocusRows(rows);
  assert.equal(result.length, 2);
  assert.equal(result[0].ServiceName, "gpt-4o-mini");
  assert.equal(result[1].ServiceName, "gpt-4o");
});

test("FOCUS_COLUMNS matches the keys produced by toFocusRow exactly", () => {
  const row = toFocusRow(sampleRow());
  const rowKeys = Object.keys(row).sort();
  const expectedKeys = [...FOCUS_COLUMNS].sort();
  assert.deepEqual(rowKeys, expectedKeys, "toFocusRow output keys must match FOCUS_COLUMNS exactly");
});
