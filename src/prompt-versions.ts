import { Either, Schema } from "effect";

import { hashText, parsePromptLinkingOptions } from "./prompt-link.js";

/**
 * Prompt version attribution: which `AGENTS.md` version and which agent
 * prompt version a generation actually ran with.
 *
 * Everything here is pure. Only names, version numbers, a 12-hex hash prefix,
 * status enums, booleans and counts leave this module; instruction text and
 * paths never do.
 */

const MAX_PROMPT_LENGTH = 256;
const MAX_WALK_DEPTH = 8;
const SHA12_LENGTH = 12;
// Metadata values are written as strings: the Langfuse SDK warns on export
// for every non-string langfuse.observation.metadata.* attribute, and
// Langfuse stores metadata values as strings anyway.
const SCHEMA_VERSION = "1";
const METADATA = "langfuse.observation.metadata";
const HEADER_PREFIX = "Instructions from: ";
// OpenCode v2.1.1: a block is the header, the file content and then a blank
// line before the next header or the date line.
const REGION_END = /\n{2,}(?=Instructions from: |Today's date: )/;
const DELIMITER_SHAPE = /\n{2,}(?:Instructions from: |Today's date: )/;
const HEADER_LINE = /(?:^|\n)Instructions from: ([^\n]*)\n/g;

const PromptVersionsOptionsSchema = Schema.Struct({
  instructions: Schema.Struct({ path: Schema.String, prompt: Schema.String }),
  release: Schema.optional(Schema.Literal("instructions")),
  version: Schema.optional(Schema.Literal("agentPrompt")),
});

const decodePromptVersionsOptions = Schema.decodeUnknownEither(
  PromptVersionsOptionsSchema,
  { onExcessProperty: "error" },
);

export type PromptVersionsConfig = {
  readonly instructionPath: string;
  readonly instructionPrompt: string;
  readonly key: string;
};

const invalid = (reason: string) => ({ _tag: "Invalid", reason }) as const;

// Only an already-normalized absolute path (or one under ~/) is accepted, as
// OpenCode prints the path verbatim in the instruction header.
const expandPath = (path: string, homeDir: string) => {
  const absolute = path.startsWith("/");
  if (!absolute && !path.startsWith("~/")) {
    return undefined;
  }
  const rest = path.slice(absolute ? 1 : 2);
  if (
    rest
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return absolute ? path : `${homeDir.replace(/\/+$/, "")}/${rest}`;
};

// The instruction prompt must not be a name the same instance links agent
// prompts to: one snapshot cannot follow both indexing rules.
const overlapsAgentPrompts = (options: unknown, prompt: string) => {
  const linking = parsePromptLinkingOptions(options);
  if (linking._tag !== "Enabled") {
    return false;
  }
  if (Array.from(linking.agents.values()).includes(prompt)) {
    return true;
  }
  if (linking.agentPrompt === undefined) {
    return false;
  }
  const pattern = linking.agentPrompt
    .split("{agent}")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".+");
  return new RegExp(`^${pattern}$`, "s").test(prompt);
};

export const parsePromptVersionsOptions = (
  options: unknown,
  homeDir: string,
) => {
  const promptVersions: unknown =
    typeof options === "object" && options !== null
      ? Reflect.get(options, "promptVersions")
      : undefined;
  if (promptVersions === undefined || promptVersions === null) {
    return { _tag: "Disabled" } as const;
  }

  const decoded = decodePromptVersionsOptions(promptVersions);
  if (
    Either.isLeft(decoded) ||
    typeof promptVersions !== "object" ||
    Array.isArray(promptVersions)
  ) {
    return invalid("promptVersions has an invalid shape");
  }

  const { path, prompt } = decoded.right.instructions;
  const instructionPath = expandPath(path, homeDir);
  if (instructionPath === undefined) {
    return invalid(
      "promptVersions.instructions.path must be a normalized absolute or ~/ path",
    );
  }
  if (
    prompt.length === 0 ||
    prompt.length > MAX_PROMPT_LENGTH ||
    /[{}\n]/.test(prompt)
  ) {
    return invalid("promptVersions.instructions.prompt is not a usable name");
  }
  if (overlapsAgentPrompts(options, prompt)) {
    return invalid(
      "promptVersions.instructions.prompt overlaps an agent prompt name",
    );
  }

  return {
    _tag: "Enabled",
    instructionPath,
    instructionPrompt: prompt,
    key: JSON.stringify({ path: instructionPath, prompt }),
  } as const satisfies PromptVersionsConfig & { _tag: "Enabled" };
};

export type InstructionScan =
  | {
      readonly status: "found";
      readonly hash: string;
      readonly otherCount: number;
    }
  | {
      readonly status: "absent" | "ambiguous" | "boundary_unknown";
      readonly otherCount: number;
    };

const systemTexts = (system: unknown) =>
  Array.isArray(system)
    ? system.flatMap((part: unknown) => {
        const text: unknown =
          typeof part === "object" && part !== null
            ? Reflect.get(part, "text")
            : undefined;
        return typeof text === "string" ? [text] : [];
      })
    : [];

/**
 * Finds the block of the configured instruction file in the system parts and
 * hashes its normalized content. Other instruction blocks are only counted.
 */
export const scanInstruction = (
  system: unknown,
  path: string,
): InstructionScan => {
  let otherCount = 0;
  let found: { text: string; start: number } | undefined;
  let count = 0;

  for (const text of systemTexts(system)) {
    for (const match of text.matchAll(HEADER_LINE)) {
      if (match[1] !== path) {
        otherCount += 1;
        continue;
      }
      count += 1;
      found = { text, start: match.index + match[0].length };
    }
  }

  if (count === 0 || found === undefined) {
    return { status: "absent", otherCount };
  }
  if (count > 1) {
    return { status: "ambiguous", otherCount };
  }

  const rest = found.text.slice(found.start);
  const end = REGION_END.exec(rest);
  if (end === null) {
    return { status: "boundary_unknown", otherCount };
  }
  return {
    status: "found",
    hash: hashText(rest.slice(0, end.index)),
    otherCount,
  };
};

// The OpenCode v2.1.1 notices that the instruction file changed after the
// session's system prompt was built.
const changeNotices = (path: string) => [
  `The instructions from ${path} changed. Here's the diff:`,
  `The instructions from ${path} no longer apply.`,
  `New instructions apply from:\n${HEADER_PREFIX}${path}\n`,
];

const containsNotice = (
  value: unknown,
  notices: readonly string[],
  depth: number,
): boolean => {
  if (typeof value === "string") {
    return notices.some((notice) => value.includes(notice));
  }
  if (depth >= MAX_WALK_DEPTH || typeof value !== "object" || value === null) {
    return false;
  }
  return (Array.isArray(value) ? value : Object.values(value)).some(
    (item: unknown) => containsNotice(item, notices, depth + 1),
  );
};

export const instructionChanged = (messages: unknown, path: string) =>
  containsNotice(messages, changeNotices(path), 0);

export const hasDelimiterShape = (text: string) => DELIMITER_SHAPE.test(text);

export type AgentsMdResult =
  | {
      readonly status: "matched";
      readonly version: number;
      readonly hash: string;
    }
  | { readonly status: "no_match"; readonly hash: string }
  | {
      readonly status:
        | "absent"
        | "ambiguous"
        | "boundary_unknown"
        | "unavailable";
    };

type AgentPromptStatus =
  | "matched"
  | "not_registered"
  | "no_match"
  | "ambiguous"
  | "unavailable"
  | "disabled";

export type PromptVersionValue = {
  readonly release?: string;
  readonly version?: string;
  readonly agentsMdStatus: AgentsMdResult["status"] | "mixed";
  readonly agentsMdVersion?: number;
  readonly agentsMdChanged: boolean;
  readonly agentsMdSha12?: string;
  readonly agentPromptStatus?: AgentPromptStatus | "mixed";
  readonly otherInstructionCount: number;
};

const agentPromptStatuses: ReadonlySet<string> = new Set<AgentPromptStatus>([
  "matched",
  "not_registered",
  "no_match",
  "ambiguous",
  "unavailable",
  "disabled",
]);

const isAgentPromptStatus = (status: string): status is AgentPromptStatus =>
  agentPromptStatuses.has(status);

const agentPromptValue = (input: {
  agent?: string;
  link?: { status: string; name: string; version?: number };
  linkingEnabled: boolean;
}) => {
  if (input.agent === undefined || input.agent === "") {
    return {};
  }
  if (!input.linkingEnabled || input.link === undefined) {
    // No prompt name applies to this agent (linking off, or the agent is
    // mapped to no prompt).
    return { version: input.agent, agentPromptStatus: "disabled" } as const;
  }
  if (input.link.status === "matched" && input.link.version !== undefined) {
    return {
      version: `${input.link.name}@${input.link.version.toString()}`,
      agentPromptStatus: "matched",
    } as const;
  }
  return {
    version: input.agent,
    agentPromptStatus: isAgentPromptStatus(input.link.status)
      ? input.link.status
      : "unavailable",
  } as const;
};

const agentsMdValue = (
  prompt: string,
  agentsMd: AgentsMdResult,
  changed: boolean,
) => {
  const suffix = changed ? "+changed" : "";
  if (agentsMd.status === "matched") {
    return {
      release: `${prompt}@${agentsMd.version.toString()}${suffix}`,
      agentsMdVersion: agentsMd.version,
      agentsMdSha12: agentsMd.hash.slice(0, SHA12_LENGTH),
    };
  }
  if (agentsMd.status === "no_match") {
    const sha12 = agentsMd.hash.slice(0, SHA12_LENGTH);
    return { release: `${prompt}#${sha12}${suffix}`, agentsMdSha12: sha12 };
  }
  return {};
};

export const buildPromptVersionValue = (input: {
  prompt: string;
  agentsMd: AgentsMdResult;
  changed: boolean;
  otherCount: number;
  agent?: string;
  link?: { status: string; name: string; version?: number };
  linkingEnabled: boolean;
}): PromptVersionValue => ({
  ...agentsMdValue(input.prompt, input.agentsMd, input.changed),
  ...agentPromptValue(input),
  agentsMdStatus: input.agentsMd.status,
  agentsMdChanged: input.changed,
  otherInstructionCount: input.otherCount,
});

// Constant-size fold of the values of several generations. Two distinct
// values already decide "mixed", so no third one is kept.
export type TurnPromptVersionSummary = {
  releases: string[];
  versions: string[];
  first?: PromptVersionValue;
  firstVersioned?: PromptVersionValue;
  lastWithoutRelease?: PromptVersionValue;
  changed: boolean;
  count: number;
  otherInstructionCount: number;
};

export const emptyPromptVersionSummary = (): TurnPromptVersionSummary => ({
  releases: [],
  versions: [],
  changed: false,
  count: 0,
  otherInstructionCount: 0,
});

const addDistinct = (values: string[], value: string) => {
  if (values.length < 2 && !values.includes(value)) {
    values.push(value);
  }
};

export const addToPromptVersionSummary = (
  summary: TurnPromptVersionSummary,
  value: PromptVersionValue,
) => {
  summary.count += 1;
  summary.changed ||= value.agentsMdChanged;
  summary.otherInstructionCount = Math.max(
    summary.otherInstructionCount,
    value.otherInstructionCount,
  );
  if (value.release === undefined) {
    summary.lastWithoutRelease = value;
  } else {
    summary.first ??= value;
    addDistinct(summary.releases, value.release);
  }
  if (value.version !== undefined) {
    summary.firstVersioned ??= value;
    addDistinct(summary.versions, value.version);
  }
};

const releaseOfSummary = (
  summary: TurnPromptVersionSummary,
  prompt: string,
) => {
  const release = summary.releases.at(0);
  if (summary.releases.length > 1) {
    return { release: `${prompt}:mixed`, agentsMdStatus: "mixed" } as const;
  }
  if (release === undefined || summary.first === undefined) {
    return {
      agentsMdStatus: summary.lastWithoutRelease?.agentsMdStatus ?? "absent",
    };
  }
  return {
    release,
    agentsMdStatus: summary.first.agentsMdStatus,
    ...(summary.first.agentsMdVersion === undefined
      ? {}
      : { agentsMdVersion: summary.first.agentsMdVersion }),
    ...(summary.first.agentsMdSha12 === undefined
      ? {}
      : { agentsMdSha12: summary.first.agentsMdSha12 }),
  };
};

const versionOfSummary = (summary: TurnPromptVersionSummary) => {
  const version = summary.versions.at(0);
  if (summary.versions.length > 1) {
    return { version: "mixed", agentPromptStatus: "mixed" } as const;
  }
  if (version === undefined) {
    return {};
  }
  return {
    version,
    ...(summary.firstVersioned?.agentPromptStatus === undefined
      ? {}
      : { agentPromptStatus: summary.firstVersioned.agentPromptStatus }),
  };
};

export const promptVersionSummaryValue = (
  summary: TurnPromptVersionSummary,
  prompt: string,
): PromptVersionValue | undefined =>
  summary.count === 0
    ? undefined
    : {
        ...releaseOfSummary(summary, prompt),
        ...versionOfSummary(summary),
        agentsMdChanged: summary.changed,
        otherInstructionCount: summary.otherInstructionCount,
      };

export const combinePromptVersionValues = (
  values: readonly PromptVersionValue[],
  prompt: string,
) => {
  const summary = emptyPromptVersionSummary();
  for (const value of values) {
    addToPromptVersionSummary(summary, value);
  }
  return promptVersionSummaryValue(summary, prompt);
};

export const promptVersionAttributes = (
  value: PromptVersionValue,
): Record<string, string> => ({
  ...(value.release === undefined ? {} : { "langfuse.release": value.release }),
  ...(value.version === undefined ? {} : { "langfuse.version": value.version }),
  ...(value.agentsMdVersion === undefined
    ? {}
    : { [`${METADATA}.agentsMdVersion`]: value.agentsMdVersion.toString() }),
  [`${METADATA}.agentsMdStatus`]: value.agentsMdStatus,
  [`${METADATA}.agentsMdChanged`]: value.agentsMdChanged.toString(),
  ...(value.agentsMdSha12 === undefined
    ? {}
    : { [`${METADATA}.agentsMdSha12`]: value.agentsMdSha12 }),
  ...(value.agentPromptStatus === undefined
    ? {}
    : { [`${METADATA}.agentPromptStatus`]: value.agentPromptStatus }),
  [`${METADATA}.otherInstructionCount`]: value.otherInstructionCount.toString(),
  [`${METADATA}.promptVersionsSchema`]: SCHEMA_VERSION,
});

// What a span gets when its window cannot be decided from the history.
export const unavailablePromptVersionAttributes = {
  [`${METADATA}.agentsMdStatus`]: "unavailable",
  [`${METADATA}.promptVersionsSchema`]: SCHEMA_VERSION,
} as const;

/**
 * The single writer of every prompt version attribute, so a span is provably
 * stamped at most once (tests spy on `write`).
 */
export const promptVersionStamp = {
  write(
    span: {
      setAttributes(
        attributes: Record<string, string | number | boolean>,
      ): unknown;
    },
    attributes: Record<string, string | number | boolean>,
  ) {
    span.setAttributes(attributes);
  },
};
