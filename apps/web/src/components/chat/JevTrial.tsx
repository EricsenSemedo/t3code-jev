import type { EnvironmentId, TaskRouteSuggestion } from "@t3tools/contracts";
import { useId, useRef, useState } from "react";
import { FlaskConicalIcon, LoaderCircleIcon } from "lucide-react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  appendTrialRecord,
  JEV_TRIAL_STORAGE_KEY,
  readTrialRecords,
  trialModelFamily,
  type TrialFeedback,
} from "./jevTrialFeedback";

const LANE_LABELS = { code: "Use an existing tool", luna: "Luna", terra: "Terra", astra: "Astra" };
const REASONS = {
  deterministic: "A known command or calculation should handle this.",
  transformation: "This looks like a small, clearly specified edit or text-processing task.",
  implementation: "This looks like a bounded code change or debugging task.",
  complex: "This appears to need deeper investigation or judgment.",
};
const STATUS_LABELS = {
  not_configured: "Jev is not configured on this server yet.",
  unavailable: "Jev is unavailable. You can keep working with your selected model.",
};

export function JevTrialPanel({
  initialTask,
  selectedModel,
  suggest,
}: {
  initialTask: string;
  selectedModel: string;
  suggest: (task: string) => Promise<TaskRouteSuggestion>;
}) {
  const [task, setTask] = useState(initialTask.slice(0, 4000));
  const taskInputId = useId();
  const [result, setResult] = useState<TaskRouteSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const requestId = useRef(0);
  const inFlight = useRef(false);
  const selectedAtRequest = useRef(selectedModel);

  async function requestSuggestion() {
    if (!task.trim() || inFlight.current) return;
    inFlight.current = true;
    const id = ++requestId.current;
    selectedAtRequest.current = selectedModel;
    setBusy(true);
    setResult(null);
    setFeedback(null);
    try {
      const next = await suggest(task.trim());
      if (id === requestId.current) setResult(next);
    } catch {
      if (id === requestId.current) setResult({ status: "unavailable" });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function saveFeedback(value: TrialFeedback) {
    if (result?.status !== "ready" || feedback !== null) return;
    try {
      const updated = appendTrialRecord(localStorage.getItem(JEV_TRIAL_STORAGE_KEY), {
        time: Date.now(),
        lane: result.lane,
        confidence: result.confidence,
        selected: trialModelFamily(selectedAtRequest.current),
        feedback: value,
      });
      localStorage.setItem(JEV_TRIAL_STORAGE_KEY, updated);
      setFeedback("Saved on this device. Your task text is not saved in the trial log.");
    } catch {
      setFeedback("This browser could not save feedback.");
    }
  }

  function exportFeedback() {
    try {
      const records = readTrialRecords(localStorage.getItem(JEV_TRIAL_STORAGE_KEY));
      const url = URL.createObjectURL(
        new Blob([JSON.stringify({ version: 1, records }, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "jev-trial-results.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setFeedback("This browser could not export feedback.");
    }
  }

  return (
    <section className="space-y-3" aria-label="Jev model recommendation trial">
      <div>
        <h3 className="text-sm font-semibold">Jev trial</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Get a second opinion on which model fits. Your selected model stays in control.
        </p>
      </div>
      <div className="block space-y-1.5 text-xs">
        <label htmlFor={taskInputId} className="font-medium">
          Task description
        </label>
        <textarea
          id={taskInputId}
          className="min-h-24 w-full resize-y rounded-md border border-input bg-background p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={task}
          maxLength={4000}
          rows={4}
          placeholder="Describe a task without private details…"
          onChange={(event) => {
            requestId.current += 1;
            setTask(event.target.value);
            setResult(null);
            setFeedback(null);
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {task.length.toLocaleString()} / 4,000 characters
        {initialTask.length > 4000
          ? " · Long drafts start with the first 4,000 characters. Edit before sending."
          : ""}
      </p>
      <p className="text-xs text-muted-foreground">
        Only this description is sent to TypeSafe when you click below. Leave out personal details.
        Chat history and attachments are not sent.
      </p>
      <Button
        size="sm"
        type="button"
        disabled={!task.trim()}
        aria-disabled={busy || !task.trim()}
        onClick={() => void requestSuggestion()}
      >
        {busy ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : (
          <FlaskConicalIcon className="size-3.5" />
        )}
        {busy ? "Checking…" : "Ask Jev"}
      </Button>
      <div aria-live="polite" aria-atomic="true">
        {result?.status === "ready" ? (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <p className="text-sm font-semibold">
              {result.confidence < 0.6 ? "Tentative suggestion" : "Suggestion"} ·{" "}
              {LANE_LABELS[result.lane]}
            </p>
            <p className="text-xs text-muted-foreground">{REASONS[result.reason]}</p>
            <p className="text-xs">
              No model was changed. This recommendation uses only the description above.
            </p>
            <div className="flex flex-wrap gap-1.5" aria-label="Rate this suggestion">
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-disabled={feedback !== null}
                onClick={() => saveFeedback("good_fit")}
              >
                Good fit
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-disabled={feedback !== null}
                onClick={() => saveFeedback("too_weak")}
              >
                Too weak
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-disabled={feedback !== null}
                onClick={() => saveFeedback("too_much")}
              >
                Too much
              </Button>
            </div>
          </div>
        ) : result ? (
          <p className="text-xs text-muted-foreground">
            {result.status === "blocked"
              ? result.reason === "continuation"
                ? "This looks like a continuation. Keep the current model, or describe a new, self-contained task."
                : "This may contain private details. Rewrite it as a general task description before sending."
              : STATUS_LABELS[result.status]}
          </p>
        ) : null}
        {feedback ? <p className="mt-2 text-xs text-muted-foreground">{feedback}</p> : null}
      </div>
      <Button type="button" variant="ghost" size="xs" onClick={exportFeedback}>
        Export trial feedback
      </Button>
    </section>
  );
}

export function JevTrial({
  environmentId,
  draft,
  selectedModel,
  disabled,
  open,
  onOpenChange,
}: {
  environmentId: EnvironmentId;
  draft: string;
  selectedModel: string;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const recommend = useAtomCommand(serverEnvironment.suggestTaskRoute, {
    reportFailure: false,
    reportDefect: false,
  });
  async function suggest(task: string): Promise<TaskRouteSuggestion> {
    const result = await recommend({ environmentId, input: { task } });
    return result._tag === "Success" ? result.value : { status: "unavailable" };
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            className="shrink-0 gap-1.5 text-muted-foreground"
          />
        }
      >
        <FlaskConicalIcon className="size-3.5" />
        <span>Jev trial</span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-[min(360px,calc(100vw-24px))]">
        {open ? (
          <JevTrialPanel initialTask={draft} selectedModel={selectedModel} suggest={suggest} />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
