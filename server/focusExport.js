// focusExport.js - transforms usage_events into FOCUS-conformant rows.
//
// HONEST SCOPE NOTE: FOCUS (FinOps Open Cost and Usage Specification) v1.0
// defines 43 columns designed for cloud infrastructure billing (compute,
// storage, commitments, regions, resources). This app tracks LLM API spend,
// which doesn't have most of those concepts - there's no region, no
// resource ID, no commitment discounts, no list-price-vs-effective-price
// distinction. Columns that don't apply are set to null per FOCUS's own
// null-handling rules (see attributes/null-handling in the spec), NOT
// filled with placeholder/fake values - a fake ResourceId would be worse
// than an honest null, since it would silently corrupt any cross-provider
// analysis someone runs on the exported file.
//
// Columns that DO have a real mapping: BilledCost, EffectiveCost (same
// value here, since no discounts are modeled), ChargePeriodStart/End,
// BillingPeriodStart/End, ServiceCategory, ServiceName, Provider,
// Publisher, SkuId, ConsumedQuantity/Unit, PricingQuantity/Unit,
// ChargeCategory, Tags, BillingCurrency, SubAccountId/Name.

const { getUsageEventsRaw, csvEscape } = require("./data");

const FOCUS_COLUMNS = [
  "AvailabilityZone",
  "BilledCost",
  "BillingAccountId",
  "BillingAccountName",
  "BillingCurrency",
  "BillingPeriodEnd",
  "BillingPeriodStart",
  "ChargeCategory",
  "ChargeClass",
  "ChargeDescription",
  "ChargeFrequency",
  "ChargePeriodEnd",
  "ChargePeriodStart",
  "CommitmentDiscountCategory",
  "CommitmentDiscountId",
  "CommitmentDiscountName",
  "CommitmentDiscountStatus",
  "CommitmentDiscountType",
  "ConsumedQuantity",
  "ConsumedUnit",
  "ContractedCost",
  "ContractedUnitPrice",
  "EffectiveCost",
  "InvoiceIssuer",
  "ListCost",
  "ListUnitPrice",
  "PricingCategory",
  "PricingQuantity",
  "PricingUnit",
  "Provider",
  "Publisher",
  "RegionId",
  "RegionName",
  "ResourceId",
  "ResourceName",
  "ResourceType",
  "ServiceCategory",
  "ServiceName",
  "SkuId",
  "SkuPriceId",
  "SubAccountId",
  "SubAccountName",
  "Tags",
];

// FOCUS's month boundaries for BillingPeriodStart/End - the calendar month
// containing the event, formatted per FOCUS's date/time attribute (ISO 8601).
function billingPeriodFor(eventTimeIso) {
  const d = new Date(eventTimeIso);
  if (isNaN(d.getTime())) return { start: null, end: null };
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

// FOCUS's Tags column uses a key-value format: {"key":"value",...} as a
// JSON string, per the spec's key-value-format attribute.
function buildTags(row) {
  const tags = {};
  if (row.team) tags.team = row.team;
  if (row.environment) tags.environment = row.environment;
  if (row.git_branch) tags.git_branch = row.git_branch;
  return Object.keys(tags).length ? JSON.stringify(tags) : null;
}

function toFocusRow(row) {
  const period = billingPeriodFor(row.event_time);
  const totalTokens = (row.input_tokens || 0) + (row.output_tokens || 0);

  return {
    AvailabilityZone: null,
    BilledCost: row.cost_usd,
    BillingAccountId: null,
    BillingAccountName: null,
    BillingCurrency: "USD",
    BillingPeriodEnd: period.end,
    BillingPeriodStart: period.start,
    ChargeCategory: "Usage",
    ChargeClass: null,
    ChargeDescription: `${row.provider}/${row.model} - ${totalTokens} tokens`,
    ChargeFrequency: "Usage-Based",
    ChargePeriodEnd: row.event_time,
    ChargePeriodStart: row.event_time,
    CommitmentDiscountCategory: null,
    CommitmentDiscountId: null,
    CommitmentDiscountName: null,
    CommitmentDiscountStatus: null,
    CommitmentDiscountType: null,
    ConsumedQuantity: totalTokens,
    ConsumedUnit: "Tokens",
    ContractedCost: null,
    ContractedUnitPrice: null,
    EffectiveCost: row.cost_usd,
    InvoiceIssuer: null,
    ListCost: null,
    ListUnitPrice: null,
    PricingCategory: "On-Demand",
    PricingQuantity: 1000,
    PricingUnit: "1K tokens",
    Provider: row.provider,
    Publisher: row.provider,
    RegionId: null,
    RegionName: null,
    ResourceId: null,
    ResourceName: null,
    ResourceType: null,
    ServiceCategory: "AI and Machine Learning",
    ServiceName: row.model,
    SkuId: `${row.provider}:${row.model}`,
    SkuPriceId: null,
    SubAccountId: row.team || null,
    SubAccountName: row.team || null,
    Tags: buildTags(row),
  };
}

function toFocusRows(rawRows) {
  return rawRows.map(toFocusRow);
}

function exportFocus({ from, to, format = "json" } = {}) {
  const rawRows = getUsageEventsRaw({ from, to });
  const focusRows = toFocusRows(rawRows);

  if (format === "csv") {
    if (!focusRows.length) return FOCUS_COLUMNS.join(",");
    const lines = [FOCUS_COLUMNS.join(",")];
    for (const row of focusRows) {
      lines.push(FOCUS_COLUMNS.map((col) => csvEscape(row[col])).join(","));
    }
    return lines.join("\n");
  }

  return focusRows; // json
}

module.exports = { exportFocus, toFocusRows, toFocusRow, FOCUS_COLUMNS, billingPeriodFor, buildTags };
