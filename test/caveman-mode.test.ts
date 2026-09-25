import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { SessionHooks } from "@opencode/plugin/promise/session";
import { registerCavemanMode } from "../src/caveman-mode.ts";

const CAVEMAN_PACKAGE_ROOT = fileURLToPath(
  new URL(".", import.meta.resolve("caveman-installer/package.json")),
);
const INJECTION_MARKER = "<!-- opencode-sherpa:caveman-mode -->";

interface HookCallbacks {
  prompt: ((input: SessionHooks["prompt"]) => Promise<void> | void) | undefined;
  context: ((input: SessionHooks["context"]) => Promise<void> | void) | undefined;
}

interface HookHarness {
  callbacks: HookCallbacks;
  disposed: string[];
  registration: Registration;
  messages: Map<string, SessionHooks["context"]["messages"]>;
  nextMessageID: number;
}

async function createPayload() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "sherpa-caveman-mode-"));
  const installedRoot = path.join(temporaryRoot, ".sherpa", "caveman", "opencode");
  const pluginDirectory = path.join(installedRoot, "plugins", "caveman");
  await mkdir(path.join(installedRoot, "skills", "caveman"), { recursive: true });
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(path.join(pluginDirectory, "plugin.js"), "throw new Error('installed plugin must not load');\n");

  await Promise.all([
    readFile(path.join(CAVEMAN_PACKAGE_ROOT, "src", "hooks", "caveman-config.js"), "utf8")
      .then((text) => writeFile(path.join(pluginDirectory, "caveman-config.cjs"), text)),
    readFile(path.join(CAVEMAN_PACKAGE_ROOT, "src", "hooks", "caveman-parse.js"), "utf8")
      .then((text) => writeFile(path.join(pluginDirectory, "caveman-parse.cjs"), text)),
    readFile(path.join(CAVEMAN_PACKAGE_ROOT, "skills", "caveman", "SKILL.md"), "utf8")
      .then((text) => writeFile(path.join(installedRoot, "skills", "caveman", "SKILL.md"), text)),
    readFile(path.join(CAVEMAN_PACKAGE_ROOT, "src", "rules", "caveman-activate.md"), "utf8")
      .then((text) => writeFile(path.join(installedRoot, "AGENTS.md"), text)),
  ]);

  return {
    temporaryRoot,
    installedRoot,
    pluginDirectory,
    skillFile: path.join(installedRoot, "skills", "caveman", "SKILL.md"),
    agentsFile: path.join(installedRoot, "AGENTS.md"),
    cleanup: async () => rm(temporaryRoot, { recursive: true, force: true }),
  };
}

async function setupHooks(installedRoot: string, failAt?: "prompt" | "context"): Promise<HookHarness> {
  const callbacks: HookCallbacks = { prompt: undefined, context: undefined };
  const disposed: string[] = [];
  const failure = new Error(`Hook ${failAt ?? "none"} failed.`);
  const context = {
    session: {
      hook: async (name: string, callback: unknown): Promise<Registration> => {
        if (name === failAt) throw failure;
        if (name === "prompt") {
          callbacks.prompt = callback as NonNullable<HookCallbacks["prompt"]>;
        } else if (name === "context") {
          callbacks.context = callback as NonNullable<HookCallbacks["context"]>;
        }
        return { dispose: async () => { disposed.push(name); } };
      },
    },
  } as unknown as Pick<Context, "session">;

  return {
    callbacks,
    disposed,
    registration: await registerCavemanMode(context, installedRoot),
    messages: new Map(),
    nextMessageID: 0,
  };
}

async function sendPrompt(
  harness: HookHarness,
  sessionID: string,
  text: string,
): Promise<SessionHooks["context"]["messages"][number]> {
  if (!harness.callbacks.prompt) throw new Error("Prompt hook was not registered.");
  const messageID = `message-${++harness.nextMessageID}`;
  const prompt: SessionHooks["prompt"] = {
    sessionID: sessionID as SessionHooks["prompt"]["sessionID"],
    messageID: messageID as SessionHooks["prompt"]["messageID"],
    prompt: { text },
    metadata: { existing: "preserved" },
    delivery: "queue",
  };
  await harness.callbacks.prompt(prompt);
  const message = {
    id: messageID,
    role: "user",
    content: [{ type: "text", text }],
    metadata: prompt.metadata,
  } as unknown as SessionHooks["context"]["messages"][number];
  harness.messages.set(sessionID, [...(harness.messages.get(sessionID) ?? []), message]);
  return message;
}

async function injectContext(
  harness: HookHarness,
  sessionID: string,
  system: SessionHooks["context"]["system"] = [],
  messages = harness.messages.get(sessionID) ?? [],
): Promise<SessionHooks["context"]["system"]> {
  if (!harness.callbacks.context) throw new Error("Context hook was not registered.");
  await harness.callbacks.context({
    sessionID: sessionID as SessionHooks["context"]["sessionID"],
    system,
    messages,
  } as SessionHooks["context"]);
  return system;
}

function cavemanParts(system: SessionHooks["context"]["system"]): string[] {
  return system.flatMap((part) =>
    part.type === "text" && part.text.includes(INJECTION_MARKER) ? [part.text] : []);
}

function modeRules(system: SessionHooks["context"]["system"]): string {
  return cavemanParts(system)[0] ?? "";
}

test("keeps modes session-scoped and injects one active level plus sandbox AGENTS rules", async () => {
  const payload = await createPayload();
  try {
    const harness = await setupHooks(payload.installedRoot);
    const sessionA = await injectContext(harness, "session-a");
    expect(cavemanParts(sessionA)).toHaveLength(0);

    await sendPrompt(harness, "session-a", "/caveman ultra");
    const activeA = await injectContext(harness, "session-a", sessionA);
    const activeText = modeRules(activeA);
    expect(cavemanParts(activeA)).toHaveLength(1);
    expect(activeText).toContain(INJECTION_MARKER);
    expect(activeText).toContain("Switch level: /caveman");
    expect(activeText).toContain("| **ultra** |");
    expect(activeText).not.toContain("| **full** |");
    expect(activeText).toContain("Respond terse like smart caveman");

    await injectContext(harness, "session-a", activeA);
    expect(cavemanParts(activeA)).toHaveLength(1);

    const sessionB = await injectContext(harness, "session-b");
    expect(cavemanParts(sessionB)).toHaveLength(0);
    await sendPrompt(harness, "session-b", "activate caveman");
    const activeB = await injectContext(harness, "session-b", sessionB);
    expect(modeRules(activeB)).toContain("| **full** |");
    expect(modeRules(activeB)).not.toContain("| **ultra** |");
    expect(modeRules(activeA)).toContain("| **ultra** |");

    await sendPrompt(harness, "session-a", "/caveman off");
    await injectContext(harness, "session-a", activeA);
    expect(cavemanParts(activeA)).toHaveLength(0);
    expect(cavemanParts(activeB)).toHaveLength(1);

    await harness.registration.dispose();
    expect(harness.disposed).toEqual(["context", "prompt"]);
  } finally {
    await payload.cleanup();
  }
});

test("uses the upstream parser for templates, natural language, guards, and unresolved modes", async () => {
  const payload = await createPayload();
  try {
    const harness = await setupHooks(payload.installedRoot);
    await sendPrompt(harness, "session", "What is caveman mode?");
    await sendPrompt(harness, "session", 'Please explain the phrase "activate caveman".');
    await sendPrompt(harness, "session", "Don't activate caveman.");
    await sendPrompt(harness, "session", "/caveman not-a-real-level");
    expect(cavemanParts(await injectContext(harness, "session"))).toHaveLength(0);

    await sendPrompt(harness, "session", 'Activate caveman mode: wenyan-lite\n\nIf no level given, use full. If "off", deactivate.');
    const wenyan = await injectContext(harness, "session");
    expect(modeRules(wenyan)).toContain("| **wenyan-lite** |");
    expect(modeRules(wenyan)).not.toContain("| **full** |");

    await sendPrompt(harness, "session", "Generate a commit message for the current staged changes.");
    await sendPrompt(harness, "session", "/caveman-compress");
    await sendPrompt(harness, "session", "/caveman invalid-level");
    expect(modeRules(await injectContext(harness, "session"))).toContain("| **wenyan-lite** |");

    await sendPrompt(harness, "session", 'The docs say "stop caveman" but that is only an example.');
    expect(modeRules(await injectContext(harness, "session"))).toContain("| **wenyan-lite** |");

    await sendPrompt(harness, "session", "Please stop caveman.");
    expect(cavemanParts(await injectContext(harness, "session"))).toHaveLength(0);
    await harness.registration.dispose();
  } finally {
    await payload.cleanup();
  }
});

test("binds mode to the admitted prompt rather than a later queued change", async () => {
  const payload = await createPayload();
  try {
    const harness = await setupHooks(payload.installedRoot);
    const first = await sendPrompt(harness, "session", "/caveman lite");
    const system = await injectContext(harness, "session", [], [first]);
    expect(modeRules(system)).toContain("| **lite** |");
    expect(first.metadata).toMatchObject({ existing: "preserved" });

    const off = await sendPrompt(harness, "session", "/caveman off");
    await injectContext(harness, "session", system, [first]);
    expect(modeRules(system)).toContain("| **lite** |");
    expect(cavemanParts(system)).toHaveLength(1);

    const synthetic = { id: "synthetic", role: "user", metadata: {} } as unknown as typeof first;
    expect(modeRules(await injectContext(harness, "session", [], [first, synthetic]))).toContain("| **lite** |");
    expect(cavemanParts(await injectContext(harness, "session", [], [first, off]))).toHaveLength(0);
    expect(modeRules(await injectContext(harness, "session", [], [first]))).toContain("| **lite** |");

    const next = await sendPrompt(harness, "session", "ordinary request");
    expect(cavemanParts(await injectContext(harness, "session", [], [first, off, next]))).toHaveLength(0);
    const other = await sendPrompt(harness, "other-session", "/caveman ultra");
    expect(modeRules(await injectContext(harness, "other-session", [], [other]))).toContain("| **ultra** |");
    expect(cavemanParts(await injectContext(harness, "session", [], [first, off, next]))).toHaveLength(0);

    // A compaction checkpoint without an identifiable user prompt must not
    // inherit a newer queued mode, even if the session default is active.
    const later = await sendPrompt(harness, "session", "/caveman full");
    expect(cavemanParts(await injectContext(harness, "session", [], [synthetic]))).toHaveLength(0);
    expect(modeRules(await injectContext(harness, "session", [], [later]))).toContain("| **full** |");
    await harness.registration.dispose();
  } finally {
    await payload.cleanup();
  }
});

test("keeps an off prompt off when a later queued prompt activates the mode", async () => {
  const payload = await createPayload();
  try {
    const harness = await setupHooks(payload.installedRoot);
    const original = await sendPrompt(harness, "session", "identical text");
    const activating = await sendPrompt(harness, "session", "/caveman full");
    expect(cavemanParts(await injectContext(harness, "session", [], [original]))).toHaveLength(0);
    expect(modeRules(await injectContext(harness, "session", [], [original, activating]))).toContain("| **full** |");
    const independent = await sendPrompt(harness, "session", "/caveman-review");
    expect(modeRules(await injectContext(harness, "session", [], [independent]))).toContain("| **full** |");
    await harness.registration.dispose();
  } finally {
    await payload.cleanup();
  }
});

test("uses isolated full as the explicit default and reads only the installed payload", async () => {
  const payload = await createPayload();
  const previousDefault = process.env.CAVEMAN_DEFAULT_MODE;
  const previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const outsideSkills = path.join(payload.temporaryRoot, "outside", "skills", "caveman");
  try {
    await mkdir(outsideSkills, { recursive: true });
    await writeFile(path.join(outsideSkills, "SKILL.md"), "OUTSIDE USER RULES MUST NOT LOAD.\n");
    process.env.CAVEMAN_DEFAULT_MODE = "ultra";
    process.env.CLAUDE_PLUGIN_ROOT = path.dirname(path.dirname(outsideSkills));

    const harness = await setupHooks(payload.installedRoot);
    await sendPrompt(harness, "session", "activate caveman");
    const system = await injectContext(harness, "session");
    expect(process.env.CLAUDE_PLUGIN_ROOT).toBe(path.dirname(path.dirname(outsideSkills)));
    const injected = modeRules(system);
    expect(injected).toContain("| **full** |");
    expect(injected).not.toContain("| **ultra** |");
    expect(injected).not.toContain("OUTSIDE USER RULES MUST NOT LOAD");
    expect(await readFile(payload.agentsFile, "utf8")).toContain("Respond terse like smart caveman");
    expect(await readFile(payload.skillFile, "utf8")).toContain("| **ultra** |");
    expect(cavemanParts(system)).toHaveLength(1);
    await harness.registration.dispose();
  } finally {
    if (previousDefault === undefined) delete process.env.CAVEMAN_DEFAULT_MODE;
    else process.env.CAVEMAN_DEFAULT_MODE = previousDefault;
    if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
    await payload.cleanup();
  }
});

test("rejects invalid payload exports and symlinked installed rules", async () => {
  const payload = await createPayload();
  const context = { session: { hook: async () => ({ dispose: async () => {} }) } } as unknown as Pick<Context, "session">;
  try {
    await writeFile(path.join(payload.pluginDirectory, "caveman-parse.cjs"), "module.exports = {};\n");
    await expect(registerCavemanMode(context, payload.installedRoot)).rejects.toThrow("Pinned Caveman parser has invalid required exports.");

    await rm(path.join(payload.pluginDirectory, "caveman-parse.cjs"));
    await readFile(path.join(CAVEMAN_PACKAGE_ROOT, "src", "hooks", "caveman-parse.js"), "utf8")
      .then((source) => writeFile(path.join(payload.pluginDirectory, "caveman-parse.cjs"), source));
    const outsideFile = path.join(payload.temporaryRoot, "outside-skill.md");
    await writeFile(outsideFile, "not in the installed root");
    await rm(payload.skillFile);
    await symlink(outsideFile, payload.skillFile);
    await expect(registerCavemanMode(context, payload.installedRoot)).rejects.toThrow("Caveman runtime payload paths must not be symlinks.");
  } finally {
    await payload.cleanup();
  }
});

test("disposes the prompt hook if context hook registration fails", async () => {
  const payload = await createPayload();
  try {
    const failure = new Error("context registration failed");
    const callbacks: HookCallbacks = { prompt: undefined, context: undefined };
    const disposed: string[] = [];
    const context = {
      session: {
        hook: async (name: string, callback: unknown): Promise<Registration> => {
          if (name === "context") throw failure;
          callbacks.prompt = callback as NonNullable<HookCallbacks["prompt"]>;
          return { dispose: async () => { disposed.push(name); } };
        },
      },
    } as unknown as Pick<Context, "session">;

    await expect(registerCavemanMode(context, payload.installedRoot)).rejects.toBe(failure);
    expect(callbacks.prompt).toBeDefined();
    expect(disposed).toEqual(["prompt"]);
  } finally {
    await payload.cleanup();
  }
});
