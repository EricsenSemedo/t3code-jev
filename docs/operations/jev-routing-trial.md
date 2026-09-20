# Automatic GPT model selection

Turn on **Auto-select model** beside the normal composer controls. Sending a prompt then asks
Jev to choose among the ready GPT models for the selected Codex provider. The confirmed choice
is used for that turn; switching the toggle off restores manual selection. The default is off.

Only the current prompt is sent to TypeSafe. Conversation history, files, attachments, selected
context, and application profile data are excluded. The local screening rules skip recognizable
contacts, credentials, private-resume requests, and continuation-only messages. This is a
best-effort filter, not a guarantee that arbitrary sensitive prose is detected; keep the toggle
off for sensitive prompts. Prompts exceeding the routing limit retain the selected model.

The server reads `TYPESAFE_API_KEY` from its environment or the fixed local
`~/.config/typesafe/dev.env` file. The key stays server-side. On desktop, classification uses
Personal's local backend even when the task runs on a connected environment.

## Selection policy

The priority is completing the task correctly, then reducing usage among suitable models:

- Luna handles clear transformations, extraction, or evaluation against a fixed objective rubric.
- Terra handles ordinary implementation, bounded debugging, and straightforward test harnesses.
- Sol handles difficult but bounded analysis, code changes, or judgment-heavy review.
- Astra handles the hardest work across multiple steps, tools, or systems.

These workload priors follow [OpenAI's model guidance](https://learn.chatgpt.com/docs/models),
checked September 20, 2026. They are starting heuristics, not measured guarantees. The selector
only uses models the current provider actually offers. It retains the selected model when
routing is uncertain, unavailable, blocked, or unsuitable for the submission type. Routing does
not enable Fast processing or change providers.

[TypeSafe's confidence value](https://docs.typesafe.ai/confidence) describes concentration of
its choice distribution. It does not measure the chance that the chosen model will complete
the task. Evaluate route choices and downstream task success separately. API token prices
are not equivalent to ChatGPT subscription quota, and a cheaper model may require more attempts.
Do not report numeric savings without measuring comparable completed tasks.

## Verification

Use synthetic prompts for live API checks. Test unavailable models, failed or uncertain
responses, private-input screening, and actual turn dispatch using the returned model.
Tests must also verify that the toggle-off path makes no routing request and that a failed
classification preserves the normal submission path. Never use private chat history as a
routing benchmark.
