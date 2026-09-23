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
// ChargeCategory, Tags, BillingCurrency, SubAccountId/Name, and (for API
// rows only, when the client declared X-Client-Region) RegionId/RegionName -
// self-reported, same caveat as dataResidency.js, but real data rather than
// a placeholder now that it's tracked. GPU rows still leave region null;
// there's no equivalent concept for a self-hosted cluster.

const { getUsageEventsRaw, csvEscape } = require("./data");
const { getGpuEventsExpanded } = require("./gpuUsage");

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
  if (row.project_id) tags.project_id = row.project_id;
  if (row.cost_center) tags.cost_center = row.cost_center;
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
    // Self-reported (X-Client-Region), same caveat as dataResidency.js -
    // trivially spoofable by whoever holds the key, but a real mapping now
    // that this is actually tracked, so an honest null would be wrong here.
    RegionId: row.client_region || null,
    RegionName: row.client_region || null,
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

// GPU/self-hosted inference rows (see gpuUsage.js) mapped into the SAME
// FOCUS shape as API rows, so a single export mixes both cost sources
// under one consistent schema - that's the actual point of a "unified"
// cost view. ConsumedQuantity/ConsumedUnit are left null for GPU rows,
// same "honest null over fake value" principle as the rest of this file -
// utilization_pct is a RATE, not a consumed quantity, and this codebase
// doesn't track GPU-hours, so there's no real quantity to report here.
function toFocusRowFromGpu(expandedRow) {
  const period = billingPeriodFor(expandedRow.event_time);
  const tags = {
    cluster_name: expandedRow.cluster_name,
    ...(expandedRow.gpu_type ? { gpu_type: expandedRow.gpu_type } : {}),
    ...(expandedRow.split_method ? { split_allocation_method: expandedRow.split_method } : {}),
  };

  return {
    AvailabilityZone: null,
    BilledCost: expandedRow.allocated_cost_usd,
    BillingAccountId: null,
    BillingAccountName: null,
    BillingCurrency: "USD",
    BillingPeriodEnd: period.end,
    BillingPeriodStart: period.start,
    ChargeCategory: "Usage",
    ChargeClass: null,
    ChargeDescription: expandedRow.split_method
      ? `GPU cluster '${expandedRow.cluster_name}' - allocated share (${expandedRow.split_method})`
      : `GPU cluster '${expandedRow.cluster_name}'`,
    ChargeFrequency: "Usage-Based",
    ChargePeriodEnd: expandedRow.event_time,
    ChargePeriodStart: expandedRow.event_time,
    CommitmentDiscountCategory: null,
    CommitmentDiscountId: null,
    CommitmentDiscountName: null,
    CommitmentDiscountStatus: null,
    CommitmentDiscountType: null,
    ConsumedQuantity: null,
    ConsumedUnit: null,
    ContractedCost: null,
    ContractedUnitPrice: null,
    EffectiveCost: expandedRow.allocated_cost_usd,
    InvoiceIssuer: null,
    ListCost: null,
    ListUnitPrice: null,
    PricingCategory: "On-Demand",
    PricingQuantity: null,
    PricingUnit: null,
    Provider: "self-hosted",
    Publisher: "self-hosted",
    RegionId: null,
    RegionName: null,
    ResourceId: expandedRow.cluster_name,
    ResourceName: expandedRow.cluster_name,
    ResourceType: "GPU Cluster",
    ServiceCategory: "Compute",
    ServiceName: expandedRow.gpu_type || "GPU",
    SkuId: `self-hosted:${expandedRow.cluster_name}`,
    SkuPriceId: null,
    SubAccountId: expandedRow.allocated_team,
    SubAccountName: expandedRow.allocated_team,
    Tags: Object.keys(tags).length ? JSON.stringify(tags) : null,
  };
}

async function exportFocus({ from, to, format = "json", db } = {}) {
  const rawRows = await getUsageEventsRaw({ from, to, db });
  const apiFocusRows = toFocusRows(rawRows);

  const gpuExpandedRows = await getGpuEventsExpanded({ from, to, db });
  const gpuFocusRows = gpuExpandedRows.map(toFocusRowFromGpu);

  const focusRows = [...apiFocusRows, ...gpuFocusRows];

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

module.exports = { exportFocus, toFocusRows, toFocusRow, toFocusRowFromGpu, FOCUS_COLUMNS, billingPeriodFor, buildTags };
