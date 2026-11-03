const quote = (value) => JSON.stringify(String(value).replaceAll('\\', '/'));
export function runtimeConfig({ name, accountId, entry, assets }) {
  return `name = ${quote(name)}
account_id = ${quote(accountId)}
main = ${quote(entry)}
compatibility_date = "2026-08-14"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
no_bundle = true
find_additional_modules = true
workers_dev = false
[[rules]]
type = "ESModule"
globs = ["**/*.mjs", "**/*.js"]
fallthrough = true
[version_metadata]
binding = "CF_VERSION_METADATA"
[assets]
directory = ${quote(assets)}
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/", "/login"]
[[durable_objects.bindings]]
name = "DSH_EDGE_INSTANCE"
class_name = "DshEdgeInstance"
[[durable_objects.bindings]]
name = "PIN_AUTH"
class_name = "PinAuth"
[[migrations]]
tag = "v1"
new_sqlite_classes = ["DshEdgeInstance"]
[[migrations]]
tag = "pin-v1"
new_sqlite_classes = ["PinAuth"]
[vars]
DSH_EDGE_ATTACHMENT_STORAGE = "temporary-do"
`;
}
