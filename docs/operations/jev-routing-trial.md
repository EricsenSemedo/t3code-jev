# Automatic GPT model selection

Turn on **Auto-select** beside the composer controls. Before an eligible new turn, Jev
assesses the task and recent context, then the client selects a supported Codex model and
reasoning effort. The toggle defaults to off. Turning it off restores manual selection.
Web and the desktop client share this behavior; the native mobile composer does not yet
expose auto-selection. Other providers and multi-model submissions keep their normal selection.

## Continuations and escalation

Ordinary continuations keep the current model and effort. A retry can move to a stronger
available model when the assessment finds evidence that stronger reasoning will help, such
as repeated unsuccessful fixes or a discovered design mistake. A prior assistant attempt
must be present in the supplied history. At the strongest model,
it can increase reasoning effort. A retry never automatically lowers either setting.
An outage or unavailable external dependency keeps the selection; a more expensive model
cannot repair the environment.

Fresh, independent tasks can use a cheaper model when both model and task-relationship
confidence reach 0.85. When the reported context is at least
100,000 tokens, or relevant attachments/context were excluded from the routing input,
automatic downgrades are suppressed. This is a conservative heuristic, not a measured
cache-cost calculation. Routing never enables Fast processing or changes providers.

Routing runs only before a new turn. Messages steering an already-running turn keep its
selection. The selector does not monitor work continuously, interrupt agents, or launch
retries on its own. Model, effort, task-relationship, and escalation judgments have separate
gates; an unavailable, malformed, or uncertain response preserves the applicable selection.
The selected model and effort are persisted through normal thread settings. A selection
notification includes the chosen reasoning effort when available.

## Context sent to TypeSafe

With Auto-select enabled, routing sends:

- The current typed prompt (up to 4,000 characters).
- Up to four recent, non-streaming user/assistant messages, limited to 1,000 characters each.
- Up to four activity summaries from the latest turn, limited to 240 characters each.
- The current model lane/effort, latest turn state, reported context size, and whether relevant
  attachment/context content was excluded.

Older text outside those bounded excerpts, reasoning messages, system messages, raw tool
payloads, attachments, and application profile data are excluded. Recognizable contacts,
credentials, and private-resume text anywhere in the supplied excerpts block the entire
routing request before TypeSafe access. Screening is best effort; keep Auto-select off for
sensitive conversations. A short follow-up can now use the supplied recent exchange instead
of being categorically skipped. Older prompt-only clients retain their original screening.

The server reads `TYPESAFE_API_KEY` from its environment or the fixed local
`~/.config/typesafe/dev.env` file. The key stays server-side. Desktop classification uses
Personal's local backend. Auto-selection is skipped for threads on other connected
environments, so their conversation history is not forwarded through the primary server. Both client
and classification backend need the contextual-routing update; a new client receiving an
older context-blind response retains the selected model.

## Evaluation and shadow mode

Set `T3CODE_JEV_ROUTING_MODE=shadow` in the classification server's environment before
starting it, then enable Auto-select. Jev evaluates the same eligible submissions, but the
server suppresses its recommendations so all clients retain the manually selected model
and effort. Unset the variable and restart the server to apply recommendations again.

Server logs named `task-routing.jev.suggestion` record recommendation metadata: proposed
lane/effort, current lane where known, task assessment, confidence, escalation probability,
input-token count, and apply/shadow mode. They contain no prompt or context text. These are
recommendations, not evidence of what the client ultimately dispatched or of task success.
Use the thread's actual selection and verification results when comparing outcomes.

Start with synthetic or explicitly reviewed examples. Compare completion, corrections,
retries, actual token/cache usage, and latency against a fixed-model baseline on comparable
tasks. Do not replay private histories as a benchmark without explicit authorization.

[TypeSafe confidence](https://docs.typesafe.ai/confidence) measures concentration of the
choice distribution, not the chance a coding task will succeed. Thresholds and model
workload priors require evaluation on representative work. API prices do not establish
ChatGPT subscription-quota savings, and cheaper models may need more attempts.
