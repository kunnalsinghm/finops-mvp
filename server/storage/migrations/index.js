// The ordered list of migrations. Append new ones here; never reorder, renumber
// or edit an applied one (its source is checksummed - see ../migrator.js).
module.exports = [
  require("./0002_api_keys_allow_background"),
  require("./0003_usage_events_key_id"),
  require("./0004_usage_events_project_cost_center"),
  require("./0005_tag_rules"),
  require("./0006_anomaly_alert_state"),
  require("./0007_api_keys_rotation_recommended"),
  require("./0008_tool_governance_and_shadow_extensions"),
  require("./0009_api_keys_allow_pii_bypass"),
  require("./0010_users_email_and_reset_tokens"),
  require("./0011_usage_events_user_time_index"),
];
