# Jev routing trial

The composer has a **Jev trial** button beside the model picker. Open it, review
or edit the task description, and choose **Ask Jev**. The result suggests an
existing tool, Luna, Terra or Astra. It never switches models or starts a run.
Choose a model yourself, then send the message normally.

## Configuration and devices

Configure the T3 **server**, not the browser. The server reads `TYPESAFE_API_KEY`
from its environment or `~/.config/typesafe/dev.env`. Keep that file private and
outside the repository. Do not use a `VITE_` variable for the key.

Desktop and phone browsers connected to the same updated server use the same
key and route service. A separate PC server needs its own configuration and
updated build. The native mobile app does not have this trial UI. Do not load
the official hosted frontend and expect a private fork's UI changes to appear.

The custom fork must incorporate upstream updates and build its own releases
to retain this feature. An official binary update does not contain this code.
The existing `custom-desktop-nightly.yml` builds Linux; this feature does not
add Windows release automation or restore upstream synchronization.

## Privacy and failure behavior

- Only the previewed description is sent after an explicit click. No automatic
  request on typing, popup opening or message submission.
- The new service sends no attachments, repository files or chat history.
- The server blocks obvious contacts, credentials, resume content and
  continuation requests before accessing the key or network. This is a basic
  filter, not a guarantee that arbitrary private information can be detected.
  Review the description before sending it to TypeSafe.
- Requests use the fixed TypeSafe endpoint and `jev-1.13.0`, with a 15-second
  timeout, no retries or redirects, one active request and a two-second gap.
- Vendor failures return a generic status. No raw vendor response or key goes
  to the browser. Existing app observability gets method names, not task text.
- Missing configuration, uncertain recommendations or service failures never
  interfere with ordinary model selection or message sending.
- Editing the description clears its old recommendation. Closing the popup
  discards the result but does not undo an already sent API request.

## Evaluating the trial

Use **Good fit**, **Too weak** or **Too much** after considering a suggestion.
**Export trial feedback** downloads the last 100 ratings from this browser.
Records contain time, recommended lane, confidence, selected model family and
rating. They exclude task text and custom model names; they are not synced
between devices. Low confidence is labeled tentative, not a measured guarantee.

Compare suggestions on real, nonprivate tasks and check whether the cheaper
choice actually finishes correctly without retries. This trial does not measure
subscription quota or claim cost savings. Automatic routing is a later change
that needs evidence from these results, especially for long-running threads.

## Verification

The service and contracts have synthetic tests for input bounds, safe outputs,
missing keys, blocking, malformed responses, failure, throttling and concurrent
requests. Feedback tests verify that arbitrary fields cannot enter exports.
The web build, `vp check` and `vp run typecheck` are required.

See [browser verification](../evidence/jev-trial/README.md) for screenshots and
the limits of the isolated, synthetic end-to-end check.
