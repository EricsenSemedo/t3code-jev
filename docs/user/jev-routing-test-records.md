# Jev routing test records

When this server evaluates a Jev route, it keeps a local JSONL test record at
`<stateDir>/jev-routing-test-records.jsonl`. The state directory is normally
`<T3 home>/userdata` (or the configured development state directory). Copy the
file to your review dashboard to inspect recommendations and submitted models.

Each line is schema version 1 and contains only routing and turn metadata:
server timestamps, server-issued correlation IDs, route/status/confidence and
assessment/escalation scalar values,
whether an API request was attempted, reported input-token count, and accepted
command/thread/message IDs plus model and effort. It never records prompts,
message history, attachments, tool data, credential values, prompt hashes, or
client timestamps. The file retains the latest 1,000 records within 1 MiB.

`submitted` entries with `routingObserved: true` are correlated to a Jev
request that this server issued for the same authenticated session. Entries
with `routingObserved: false` are accepted turns with no recognized
correlation; they do not say whether auto-select was disabled. This includes
native mobile submissions: the native composer does not currently make the web
Jev routing request. Web-on-phone can make it for eligible turns when auto-select
is enabled and Personal is the primary environment. A `failed` route record means an unavailable route result; use its
`apiRequested` flag to distinguish preflight skips from a request that could
not produce a usable answer.

These are best-effort observations, not a durable audit log. Disk errors, an overloaded
writer, or an abrupt server exit can lose records. Correlations and submission deduplication
last up to ten minutes in memory and reset when the server restarts. A linked
submission records the accepted model selection; it does not prove the model
completed the task or that Jev improved the outcome. Shadow mode records the
recommendation without applying it.

The previous lane and effort come from the routing request; the submitted model
and effort are included only when explicitly present in the accepted command.
