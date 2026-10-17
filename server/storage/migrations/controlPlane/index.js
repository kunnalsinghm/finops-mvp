// The ordered list of migrations for the CONTROL-PLANE schema (multi-tenant
// mode, Postgres only; tenants, api_keys, users, invites). Same rules as
// ../README.md: append, never reorder, renumber or edit an applied one.
//
// Version 1 is the frozen baseline: schema.controlPlane.js as it stood when
// the control plane became versioned. Do not edit that file again; add a
// numbered file here instead. Each migration only needs `up.postgres`.
module.exports = [
  require("./0002_tenants_schema_status"),
];
