// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type TaskRouteSuggestion as TaskRouteSuggestionResult,
  type TaskRouteSuggestionInput as TaskRouteSuggestionRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-1.13.0";
const REQUEST_TIMEOUT_MS = 15_000;
const MIN_REQUEST_INTERVAL_MS = 2_000;

const JevChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.Literals(["code", "luna", "terra", "astra"]),
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});

const JevResponse = Schema.Struct({
  answers: Schema.Struct({ route: JevChoiceAnswer }),
  usage: Schema.Struct({ input_tokens: Schema.optional(Schema.Int) }),
});

const isJevResponse = Schema.is(JevResponse);

const reasonForLane = {
  code: "deterministic",
  luna: "transformation",
  terra: "implementation",
  astra: "complex",
} as const;

export interface JevFetchResponse {
  readonly ok: boolean;
  json: () => Promise<unknown>;
}

export interface JevTaskRouteSuggestionDependencies {
  readonly getEnvironmentVariable?: (name: string) => string | undefined;
  readonly readFile?: (path: string) => Promise<string>;
  readonly configPath?: string;
  readonly fetch?: (input: string, init: RequestInit) => Promise<JevFetchResponse>;
  readonly now?: () => number;
}

function sensitiveInputReason(task: string): "sensitive_input" | "continuation" | undefined {
  if (
    /\b(?:continue|continuation|same as (?:above|before)|previous (?:message|turn)|as discussed)\b/i.test(
      task,
    )
  ) {
    return "continuation";
  }
  if (
    /\b(?:api[_ -]?key|access[_ -]?token|secret|password|credential|(?:private )?resume|curriculum vitae|\bcv\b|contact (?:details|information)|email address)\b/i.test(
      task,
    ) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(task) ||
    /\b(?:\+?\d[\d .()-]{7,}\d)\b/.test(task) ||
    /\b(?:sk|pk)[_-][A-Za-z0-9_-]{12,}\b|\b(?:AIza|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/.test(task)
  ) {
    return "sensitive_input";
  }
  return undefined;
}

function readKeyFromEnv(contents: string): string | undefined {
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null) continue;
    const value = (match[1] ?? "").replace(/^(?:"|')|(?:"|')$/g, "").trim();
    if (value.length > 0) return value;
  }
  return undefined;
}

function confidenceForChoice(response: typeof JevResponse.Type): number {
  return response.answers.route.confidence;
}

export interface JevTaskRouteSuggestionService {
  readonly suggest: (input: TaskRouteSuggestionRequest) => Effect.Effect<TaskRouteSuggestionResult>;
}

export const make = Effect.fn("JevTaskRouteSuggestion.make")(function* (
  dependencies: JevTaskRouteSuggestionDependencies = {},
) {
  const semaphore = yield* Semaphore.make(1);
  const lastRequestedAt = yield* Ref.make<number | null>(null);
  const getEnvironmentVariable =
    dependencies.getEnvironmentVariable ?? ((name) => process.env[name]);
  const readFile = dependencies.readFile ?? ((path) => NodeFSP.readFile(path, "utf8"));
  const configPath =
    dependencies.configPath ?? NodePath.join(NodeOS.homedir(), ".config/typesafe/dev.env");
  // @effect-diagnostics globalFetch:off
  const send = dependencies.fetch ?? ((input, init) => fetch(input, init));
  const now = dependencies.now ?? Date.now;

  const loadApiKey = Effect.fn("JevTaskRouteSuggestion.loadApiKey")(function* () {
    const fromEnvironment = getEnvironmentVariable("TYPESAFE_API_KEY")?.trim();
    if (fromEnvironment !== undefined && fromEnvironment.length > 0) {
      return Option.some(fromEnvironment);
    }
    const fromFile = yield* Effect.tryPromise({
      try: () => readFile(configPath),
      catch: () => undefined,
    }).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    return Option.flatMap(fromFile, (contents) => {
      const key = readKeyFromEnv(contents);
      return key === undefined ? Option.none() : Option.some(key);
    });
  });

  const suggest = Effect.fn("JevTaskRouteSuggestion.suggest")(function* (
    input: TaskRouteSuggestionRequest,
  ) {
    const blocked = sensitiveInputReason(input.task);
    if (blocked !== undefined) return { status: "blocked", reason: blocked } as const;

    const apiKey = yield* loadApiKey();
    if (Option.isNone(apiKey)) return { status: "not_configured" } as const;

    const request = Effect.gen(function* () {
      const allowed = yield* Ref.modify(lastRequestedAt, (previous) => {
        const requestedAt = now();
        return previous === null || requestedAt - previous >= MIN_REQUEST_INTERVAL_MS
          ? ([true, requestedAt] as const)
          : ([false, previous] as const);
      });
      if (!allowed) return { status: "unavailable" } as const;

      const response = yield* Effect.tryPromise({
        try: () =>
          send(JEV_ENDPOINT, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: {
              authorization: `Bearer ${apiKey.value}`,
              "content-type": "application/json",
            },
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            body: JSON.stringify({
              state: input.task,
              model: JEV_MODEL,
              questions: {
                route: {
                  type: "choice",
                  instructions: "Select the recommended coding-agent lane for this task.",
                  criteria: {
                    code: "Exact calculation or already specified command; no editing, investigation, or model needed.",
                    luna: "Small, well-specified CSS or code edit, documentation task, extraction, or formatting transformation.",
                    terra:
                      "Bounded engineering work needing implementation, debugging, or ordinary investigation.",
                    astra:
                      "Ambiguous, architectural, security-sensitive, or cross-cutting work needing deep judgment or coordination.",
                  },
                },
              },
            }),
          }),
        catch: () => undefined,
      }).pipe(Effect.option);
      if (Option.isNone(response) || !response.value.ok) return { status: "unavailable" } as const;

      const body = yield* Effect.tryPromise({
        try: () => response.value.json(),
        catch: () => undefined,
      }).pipe(Effect.option);
      if (Option.isNone(body) || !isJevResponse(body.value))
        return { status: "unavailable" } as const;

      const inputTokens = body.value.usage.input_tokens;
      return {
        status: "ready",
        lane: body.value.answers.route.choice,
        reason: reasonForLane[body.value.answers.route.choice],
        confidence: confidenceForChoice(body.value),
        inputTokens: inputTokens !== undefined && inputTokens >= 0 ? inputTokens : null,
      } as const;
    });

    return yield* semaphore
      .withPermitsIfAvailable(1)(request)
      .pipe(Effect.map(Option.getOrElse(() => ({ status: "unavailable" }) as const)));
  });

  return { suggest } satisfies JevTaskRouteSuggestionService;
});
