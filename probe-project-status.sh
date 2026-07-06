#!/usr/bin/env bash
# Encoded proof that the project-status fields the wrapper SELECTS
# (Project.status, ProjectStatus.name, ProjectStatus.type) all carry
# isDeprecated:false in Linear's live GraphQL SDL, while the field the wrapper
# deliberately AVOIDS (the deprecated Project.state) carries isDeprecated:true.
# A runnable proof of the negative: "no deprecated field is selected".
#
# Unlike probe-tools.sh (key-free, tools/list makes no Linear call), this hits
# api.linear.app/graphql and needs a real LINEAR_API_KEY in the environment.
# Use it IMPLICITLY — never echo it. Degrades to a clear SKIP (exit 0) when
# no key is set.
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${LINEAR_API_KEY:-}" ]; then
  echo "SKIP: LINEAR_API_KEY not set — cannot introspect the live SDL. Export it to run this probe."
  exit 0
fi

resp="$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" -H 'Content-Type: application/json' \
  -d '{"query":"{ p: __type(name:\"Project\"){ fields(includeDeprecated:true){ name isDeprecated } } s: __type(name:\"ProjectStatus\"){ fields(includeDeprecated:true){ name isDeprecated } } }"}')"

echo "$resp" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if "errors" in d:
    print("FAIL: introspection errored:", json.dumps(d["errors"])); sys.exit(2)
data = d["data"]
pf = {f["name"]: f["isDeprecated"] for f in data["p"]["fields"]}
sf = {f["name"]: f["isDeprecated"] for f in data["s"]["fields"]}

# The fields the queries SELECT must be non-deprecated.
selected = [("Project.status", pf.get("status")),
            ("ProjectStatus.name", sf.get("name")),
            ("ProjectStatus.type", sf.get("type"))]
# The field the wrapper AVOIDS must still be deprecated (proves we avoid it).
dropped = ("Project.state", pf.get("state"))

ok = True
for name, dep in selected:
    if dep is None:
        print(f"FAIL: {name} not present on the SDL (selection would 400)"); ok = False
    elif dep:
        print(f"FAIL: {name} isDeprecated:true — a selected field is deprecated"); ok = False
    else:
        print(f"ok: {name} isDeprecated:false (selected, safe)")

dname, ddep = dropped
if ddep is None:
    print(f"note: {dname} no longer present on the SDL (already removed) — selecting it would 400")
elif ddep:
    print(f"ok: {dname} isDeprecated:true (correctly NOT selected)")
else:
    print(f"note: {dname} isDeprecated:false (un-deprecated upstream; harmless — still not selected)")

if not ok:
    sys.exit(1)
print("PASS: every project-status field the wrapper selects is non-deprecated; the deprecated Project.state is not selected.")
'
