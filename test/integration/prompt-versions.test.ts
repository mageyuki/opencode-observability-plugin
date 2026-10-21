import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  addToPromptVersionSummary,
  buildPromptVersionValue,
  combinePromptVersionValues,
  emptyPromptVersionSummary,
  hasDelimiterShape,
  instructionChanged,
  parsePromptVersionsOptions,
  promptVersionAttributes,
  promptVersionSummaryValue,
  scanInstruction,
  type PromptVersionValue,
} from "../../src/prompt-versions.js";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const PROMPT = "policy/AGENTS";
const P = "/h/.config/opencode/AGENTS.md";
const B = "# Policy\nline\n";
const HASH_B = sha256("# Policy\nline");
const header = (path: string) => `Instructions from: ${path}\n`;
const textParts = (...texts: string[]) =>
  texts.map((text) => ({ type: "text", text }));

const PV = {
  instructions: { path: "~/.config/opencode/AGENTS.md", prompt: PROMPT },
};

const parse = (promptVersions: unknown, extra: object = {}) =>
  parsePromptVersionsOptions({ promptVersions, ...extra }, "/h");

describe("parsePromptVersionsOptions", () => {
  test("is disabled without promptVersions", () => {
    expect(parsePromptVersionsOptions(undefined, "/h")._tag).toBe("Disabled");
    expect(parsePromptVersionsOptions({}, "/h")._tag).toBe("Disabled");
    expect(parse(null)._tag).toBe("Disabled");
  });

  test("expands ~/ with the injected home directory", () => {
    const parsed = parse(PV);
    expect(parsed).toMatchObject({
      _tag: "Enabled",
      instructionPath: "/h/.config/opencode/AGENTS.md",
      instructionPrompt: PROMPT,
    });
  });

  test("gives the explicit defaults the same key", () => {
    const implicit = parse(PV);
    const explicit = parse({
      ...PV,
      release: "instructions",
      version: "agentPrompt",
    });
    expect(implicit._tag).toBe("Enabled");
    expect(explicit._tag).toBe("Enabled");
    if (implicit._tag === "Enabled" && explicit._tag === "Enabled") {
      expect(explicit.key).toBe(implicit.key);
    }
  });

  const withPath = (path: string) => ({
    instructions: { path, prompt: PROMPT },
  });
  const withPrompt = (prompt: string) => ({
    instructions: { path: "/a/AGENTS.md", prompt },
  });

  test.each([
    ["true", true],
    ["a string", "x"],
    ["an array", []],
    ["an empty object", {}],
    ["an unknown top key", { ...PV, extra: 1 }],
    [
      "instructions with an extra key",
      { instructions: { ...PV.instructions, extra: 1 } },
    ],
    ["path ~", withPath("~")],
    ["path ~user/a", withPath("~user/a")],
    ["path rel/a", withPath("rel/a")],
    ["path $HOME/a", withPath("$HOME/a")],
    ["path /a/../b", withPath("/a/../b")],
    ["path /a/./b", withPath("/a/./b")],
    ["path /a//b", withPath("/a//b")],
    ["path /a/b/", withPath("/a/b/")],
    ["path ~/a/../b", withPath("~/a/../b")],
    ["an empty path", withPath("")],
    ["an empty prompt", withPrompt("")],
    ["a prompt with {", withPrompt("a{b")],
    ["a prompt with a newline", withPrompt("a\nb")],
    ["a 257-char prompt", withPrompt("p".repeat(257))],
    ["release x", { ...PV, release: "x" }],
    ["version x", { ...PV, version: "x" }],
  ])("rejects %s", (_name, value) => {
    expect(parse(value)._tag).toBe("Invalid");
  });

  test("accepts a 256-char prompt", () => {
    expect(parse(withPrompt("p".repeat(256)))._tag).toBe("Enabled");
  });

  test("rejects a prompt that overlaps the agent prompt names", () => {
    expect(
      parse(withPrompt("agents/AGENTS"), {
        promptLinking: { agentPrompt: "agents/{agent}" },
      })._tag,
    ).toBe("Invalid");
    expect(
      parse(withPrompt(PROMPT), {
        promptLinking: { agents: { x: PROMPT } },
      })._tag,
    ).toBe("Invalid");
    expect(
      parse(withPrompt(PROMPT), {
        promptLinking: { agentPrompt: "agents/{agent}" },
      })._tag,
    ).toBe("Enabled");
  });

  test("does not check the overlap against invalid promptLinking", () => {
    expect(
      parse(withPrompt("agents/AGENTS"), {
        promptLinking: { agentPrompt: "agents/{agent}", unknown: true },
      })._tag,
    ).toBe("Enabled");
  });

  test("names no input value in the reason", () => {
    const parsed = parse(withPath("rel/a"));
    expect(parsed._tag).toBe("Invalid");
    if (parsed._tag === "Invalid") {
      expect(parsed.reason).not.toContain("rel/a");
    }
  });
});

describe("scanInstruction", () => {
  const block = `${header(P)}${B}`;

  test("hashes the region of the configured block", () => {
    expect(
      scanInstruction(textParts(`catalog\n\n${block}\n\nToday's date: Wed`), P),
    ).toEqual({ status: "found", hash: HASH_B, otherCount: 0 });
  });

  test("scans only the configured path among several blocks", () => {
    const other = `${header("/x/AGENTS.md")}other\n`;
    expect(
      scanInstruction(
        textParts(`catalog\n\n${block}\n\n${other}\n\nToday's date: Wed`),
        P,
      ),
    ).toEqual({ status: "found", hash: HASH_B, otherCount: 1 });
    expect(
      scanInstruction(
        textParts(`catalog\n\n${other}\n\n${block}\n\nToday's date: Wed`),
        P,
      ),
    ).toEqual({ status: "found", hash: HASH_B, otherCount: 1 });
  });

  test("is absent without the header", () => {
    expect(
      scanInstruction(textParts("catalog\n\nToday's date: Wed"), P).status,
    ).toBe("absent");
  });

  test("is ambiguous with two headers for the path", () => {
    expect(
      scanInstruction(
        textParts(
          `${block}\n\nToday's date: Wed`,
          `${block}\n\nToday's date: Wed`,
        ),
        P,
      ).status,
    ).toBe("ambiguous");
  });

  test("is boundary_unknown without a terminator", () => {
    expect(scanInstruction(textParts(`catalog\n\n${block}`), P).status).toBe(
      "boundary_unknown",
    );
  });

  test("gives a CRLF body the same hash", () => {
    const crlf = `${header(P)}${B.replace(/\n/g, "\r\n")}`;
    expect(
      scanInstruction(textParts(`${crlf}\n\nToday's date: Wed`), P),
    ).toEqual({ status: "found", hash: HASH_B, otherCount: 0 });
  });

  test("is absent for an unusable system", () => {
    expect(scanInstruction("not an array", P).status).toBe("absent");
    expect(scanInstruction([{ type: "image" }, 3, null], P).status).toBe(
      "absent",
    );
  });
});

describe("instructionChanged", () => {
  // The notice forms of OpenCode v2.1.1 (confirmed against the binary's
  // templates and live trace shape, see the PR description).
  const nested = (text: string) => [
    { role: "user", content: [{ type: "text", text: `x\n${text}\ny` }] },
  ];

  test("detects the change notices for the configured path", () => {
    expect(
      instructionChanged(
        nested(`The instructions from ${P} changed. Here's the diff:`),
        P,
      ),
    ).toBe(true);
    expect(
      instructionChanged(
        nested(`The instructions from ${P} no longer apply.`),
        P,
      ),
    ).toBe(true);
    expect(
      instructionChanged(
        nested(`New instructions apply from:\n${header(P)}body`),
        P,
      ),
    ).toBe(true);
  });

  test("ignores notices for another path and non-objects", () => {
    expect(
      instructionChanged(
        nested(
          "The instructions from /other/AGENTS.md changed. Here's the diff:",
        ),
        P,
      ),
    ).toBe(false);
    expect(
      instructionChanged(
        nested(`New instructions apply from:\n${header("/other/AGENTS.md")}`),
        P,
      ),
    ).toBe(false);
    expect(instructionChanged(42, P)).toBe(false);
    expect(instructionChanged(undefined, P)).toBe(false);
  });
});

describe("hasDelimiterShape", () => {
  test("detects a blank line before a header or the date", () => {
    expect(hasDelimiterShape("a\n\nInstructions from: /x")).toBe(true);
    expect(hasDelimiterShape("a\n\nToday's date: x")).toBe(true);
    expect(hasDelimiterShape("Instructions from: /x")).toBe(false);
  });
});

const matched = (version: number, hash = HASH_B) =>
  ({ status: "matched", version, hash }) as const;

describe("buildPromptVersionValue", () => {
  const base = {
    prompt: PROMPT,
    changed: false,
    otherCount: 0,
    linkingEnabled: true,
  };

  test("names the matched versions", () => {
    expect(
      buildPromptVersionValue({
        ...base,
        agentsMd: matched(51),
        agent: "reviewer",
        link: { status: "matched", name: "agents/reviewer", version: 12 },
      }),
    ).toEqual({
      release: "policy/AGENTS@51",
      version: "agents/reviewer@12",
      agentsMdStatus: "matched",
      agentsMdVersion: 51,
      agentsMdChanged: false,
      agentsMdSha12: HASH_B.slice(0, 12),
      agentPromptStatus: "matched",
      otherInstructionCount: 0,
    });
  });

  test("marks a changed instruction", () => {
    const value = buildPromptVersionValue({
      ...base,
      agentsMd: matched(51),
      changed: true,
    });
    expect(value.release).toBe("policy/AGENTS@51+changed");
    expect(value.agentsMdChanged).toBe(true);
  });

  test("names an unregistered body by its hash", () => {
    expect(
      buildPromptVersionValue({
        ...base,
        agentsMd: { status: "no_match", hash: HASH_B },
      }).release,
    ).toBe(`policy/AGENTS#${HASH_B.slice(0, 12)}`);
  });

  test.each(["absent", "boundary_unknown", "unavailable"] as const)(
    "leaves release unset for %s",
    (status) => {
      const value = buildPromptVersionValue({ ...base, agentsMd: { status } });
      expect(value.release).toBeUndefined();
      expect(value.agentsMdStatus).toBe(status);
    },
  );

  test("names an unlinked agent by name only", () => {
    expect(
      buildPromptVersionValue({
        ...base,
        agentsMd: matched(1),
        agent: "build",
        link: { status: "not_registered", name: "agents/build" },
      }),
    ).toMatchObject({ version: "build", agentPromptStatus: "not_registered" });
    expect(
      buildPromptVersionValue({
        ...base,
        agentsMd: matched(1),
        agent: "build",
        linkingEnabled: false,
      }),
    ).toMatchObject({ version: "build", agentPromptStatus: "disabled" });
  });

  test("leaves version unset without an agent", () => {
    const value = buildPromptVersionValue({ ...base, agentsMd: matched(1) });
    expect(value.version).toBeUndefined();
    expect(value.agentPromptStatus).toBeUndefined();
  });
});

const value = (
  release: string | undefined,
  extra: Partial<PromptVersionValue> = {},
): PromptVersionValue => ({
  ...(release === undefined ? {} : { release }),
  agentsMdStatus: release === undefined ? "absent" : "matched",
  ...(release === undefined
    ? {}
    : { agentsMdVersion: 51, agentsMdSha12: HASH_B.slice(0, 12) }),
  agentsMdChanged: release?.endsWith("+changed") ?? false,
  otherInstructionCount: 0,
  ...extra,
});

describe("combinePromptVersionValues", () => {
  test("keeps equal values", () => {
    expect(
      combinePromptVersionValues(
        [value("policy/AGENTS@51"), value("policy/AGENTS@51")],
        PROMPT,
      ),
    ).toEqual(value("policy/AGENTS@51"));
  });

  test("combines changed and unchanged values into mixed", () => {
    const combined = combinePromptVersionValues(
      [value("policy/AGENTS@51"), value("policy/AGENTS@51+changed")],
      PROMPT,
    );
    expect(combined).toMatchObject({
      release: "policy/AGENTS:mixed",
      agentsMdStatus: "mixed",
      agentsMdChanged: true,
    });
    expect(combined?.agentsMdVersion).toBeUndefined();
    expect(combined?.agentsMdSha12).toBeUndefined();
  });

  test("mixes two versions", () => {
    expect(
      combinePromptVersionValues(
        [
          value("policy/AGENTS@51", {
            version: "agents/a@1",
            agentPromptStatus: "matched",
          }),
          value("policy/AGENTS@51", {
            version: "build",
            agentPromptStatus: "not_registered",
          }),
        ],
        PROMPT,
      ),
    ).toMatchObject({ version: "mixed", agentPromptStatus: "mixed" });
  });

  test("ignores values without release for the release", () => {
    expect(
      combinePromptVersionValues(
        [value(undefined), value("policy/AGENTS@51"), value(undefined)],
        PROMPT,
      )?.release,
    ).toBe("policy/AGENTS@51");
    const none = combinePromptVersionValues(
      [
        value(undefined, { agentsMdStatus: "absent" }),
        value(undefined, { agentsMdStatus: "boundary_unknown" }),
      ],
      PROMPT,
    );
    expect(none?.release).toBeUndefined();
    expect(none?.agentsMdStatus).toBe("boundary_unknown");
  });

  test("is undefined for no values", () => {
    expect(combinePromptVersionValues([], PROMPT)).toBeUndefined();
  });

  test("equals the fold of the summary", () => {
    const values = [
      value(undefined),
      value("policy/AGENTS@51", { version: "build" }),
      value("policy/AGENTS@52"),
    ];
    const summary = emptyPromptVersionSummary();
    for (const item of values) {
      addToPromptVersionSummary(summary, item);
    }
    expect(combinePromptVersionValues(values, PROMPT)).toEqual(
      promptVersionSummaryValue(summary, PROMPT),
    );
  });
});

describe("TurnPromptVersionSummary", () => {
  test("keeps the summary constant-size", () => {
    const at7 = value("policy/AGENTS@7");
    const at8 = value("policy/AGENTS@8");
    const mixed = emptyPromptVersionSummary();
    for (let index = 0; index < 10_000; index += 1) {
      addToPromptVersionSummary(mixed, index % 2 === 0 ? at7 : at8);
    }
    expect(mixed.releases.length).toBe(2);
    expect(mixed.count).toBe(10_000);
    expect(promptVersionSummaryValue(mixed, PROMPT)?.release).toBe(
      "policy/AGENTS:mixed",
    );

    const same = emptyPromptVersionSummary();
    for (let index = 0; index < 10_000; index += 1) {
      addToPromptVersionSummary(same, at7);
    }
    expect(same.releases).toEqual(["policy/AGENTS@7"]);
    expect(promptVersionSummaryValue(same, PROMPT)?.release).toBe(
      "policy/AGENTS@7",
    );
  });
});

describe("promptVersionAttributes", () => {
  const METADATA = "langfuse.observation.metadata";

  test("writes exactly the defined keys", () => {
    const full = promptVersionAttributes(
      buildPromptVersionValue({
        prompt: PROMPT,
        agentsMd: matched(51),
        changed: false,
        otherCount: 2,
        agent: "reviewer",
        link: { status: "matched", name: "agents/reviewer", version: 12 },
        linkingEnabled: true,
      }),
    );
    expect(Object.keys(full).sort()).toEqual(
      [
        "langfuse.release",
        "langfuse.version",
        `${METADATA}.agentsMdVersion`,
        `${METADATA}.agentsMdStatus`,
        `${METADATA}.agentsMdChanged`,
        `${METADATA}.agentsMdSha12`,
        `${METADATA}.agentPromptStatus`,
        `${METADATA}.otherInstructionCount`,
        `${METADATA}.promptVersionsSchema`,
      ].sort(),
    );
    expect(full).toMatchObject({
      [`${METADATA}.agentsMdVersion`]: "51",
      [`${METADATA}.agentsMdChanged`]: "false",
      [`${METADATA}.otherInstructionCount`]: "2",
      [`${METADATA}.promptVersionsSchema`]: "1",
    });
    // Every value is a string: the Langfuse SDK warns on export for any
    // non-string langfuse.observation.metadata.* attribute.
    for (const item of Object.values(full)) {
      expect(typeof item).toBe("string");
      expect(item.length).toBeLessThanOrEqual(64);
    }

    const bare = promptVersionAttributes(
      buildPromptVersionValue({
        prompt: PROMPT,
        agentsMd: { status: "absent" },
        changed: false,
        otherCount: 0,
        linkingEnabled: true,
      }),
    );
    expect(Object.keys(bare).sort()).toEqual(
      [
        `${METADATA}.agentsMdStatus`,
        `${METADATA}.agentsMdChanged`,
        `${METADATA}.otherInstructionCount`,
        `${METADATA}.promptVersionsSchema`,
      ].sort(),
    );
  });
});
