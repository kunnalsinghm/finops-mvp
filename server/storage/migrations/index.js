// The ordered list of migrations. Append new ones here; never reorder, renumber
// or edit an applied one (its source is checksummed - see ../migrator.js).
module.exports = [
  require("./0002_api_keys_allow_background"),
  require("./0003_usage_events_key_id"),
];
