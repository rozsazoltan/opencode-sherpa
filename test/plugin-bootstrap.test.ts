import { expect, test } from "bun:test";
import {
  registerSherpaBootstrap,
  SHERPA_INSTALL_COMMAND,
  type BootstrapPluginContext,
  type ContextHookEvent,
  type PromptHookEvent,
} from "../plugin/bootstrap.ts";

// Exercise the documented V2 context shape with mocks; the pinned V1 package is not runtime-verified here.
interface SessionFixture {
  readonly id?: unknown;
  readonly sessionID?: unknown;
  readonly projectID?: unknown;
  readonly directory?: unknown;
  readonly parentID?: unknown;
  readonly wrap?: boolean;
  readonly fail?: boolean;
}

function harness(fixtures: Record<string, SessionFixture> = {}) {
  const data = new Map<string, unknown>();
  const prompts: Array<{ sessionID: string; text: string; delivery: "steer" | "queue" }> = [];
  const sessionGets: string[] = [];
  let contextHandler: ((event: ContextHookEvent) => void | Promise<void>) | undefined;
  let promptHandler: ((event: PromptHookEvent) => void | Promise<void>) | undefined;
  let commandHandler: ((input: { sessionID: string; prompt: unknown; delivery: "steer" | "queue" }) => Promise<void>) | undefined;
  let commandName: string | undefined;
  let storageGetFailure = false;
  let storageSetFailure = false;

  const ctx: BootstrapPluginContext = {
    session: {
      get({ sessionID }) {
        sessionGets.push(sessionID);
        const fixture = fixtures[sessionID];
        if (!fixture || fixture.fail) throw new Error("session lookup failed");
        const session = {
          projectID: fixture.projectID ?? "project-a",
          directory: fixture.directory ?? "/workspace/project-a",
          ...(fixture.id === undefined ? {} : { id: fixture.id }),
          ...(fixture.sessionID === undefined ? {} : { sessionID: fixture.sessionID }),
          ...(fixture.parentID === undefined ? {} : { parentID: fixture.parentID }),
        };
        return fixture.wrap ? { data: session } : session;
      },
      hook(
        event: "context" | "prompt",
        handler:
          | ((event: ContextHookEvent) => void | Promise<void>)
          | ((event: PromptHookEvent) => void | Promise<void>),
      ) {
        if (event === "context") contextHandler = handler as (event: ContextHookEvent) => void | Promise<void>;
        else promptHandler = handler as (event: PromptHookEvent) => void | Promise<void>;
      },
      prompt(request) {
        prompts.push(request);
      },
    },
    storage: {
      get(key) {
        if (storageGetFailure) throw new Error("storage unavailable");
        return data.get(key);
      },
      set(key, value) {
        if (storageSetFailure) throw new Error("storage unavailable");
        data.set(key, value);
      },
      remove(key) {
        data.delete(key);
      },
    },
    command: {
      transform(handler) {
        handler({
          add(definition) {
            commandName = definition.name;
            commandHandler = definition.execute;
          },
        });
      },
    },
  };

  registerSherpaBootstrap(ctx);

  return {
    data,
    prompts,
    sessionGets,
    commandName,
    setStorageGetFailure(value: boolean) { storageGetFailure = value; },
    setStorageSetFailure(value: boolean) { storageSetFailure = value; },
    async context(sessionID: string) {
      const event: ContextHookEvent = { sessionID, system: [] };
      await contextHandler?.(event);
      return event.system;
    },
    async reply(sessionID: string, prompt: string) {
      await promptHandler?.({ sessionID, prompt: { text: prompt } });
    },
    async command(sessionID: string, prompt: unknown = { text: "" }) {
      await commandHandler?.({ sessionID, prompt, delivery: "steer" });
    },
  };
}

async function consent(h: ReturnType<typeof harness>, sessionID: string, answer: "yes" | "igen" | "no" | "nem") {
  await h.context(sessionID);
  await h.reply(sessionID, answer);
}

test("session lookup accepts direct records and data wrappers, and reminds root sessions once", async () => {
  const h = harness({
    direct: {},
    wrapped: { wrap: true, projectID: "project-b", directory: "/workspace/project-b" },
  });

  expect((await h.context("direct")).length).toBe(1);
  expect(await h.context("direct")).toEqual([]);
  expect((await h.context("wrapped")).length).toBe(1);
  expect(h.sessionGets).toEqual(["direct", "wrapped"]);
});

test("child sessions and invalid project locations receive no consent reminder", async () => {
  const h = harness({
    child: { parentID: "root" },
    noProject: { projectID: "", directory: "/workspace/project-a" },
    relative: { directory: "project-a" },
    wrongIdentity: { id: "different-session" },
  });

  expect(await h.context("child")).toEqual([]);
  expect(await h.context("noProject")).toEqual([]);
  expect(await h.context("relative")).toEqual([]);
  expect(await h.context("wrongIdentity")).toEqual([]);
});

test("project decision and reminder marker persist across plugin instances", async () => {
  const first = harness({ root: {} });
  expect((await first.context("root")).length).toBe(1);
  await first.reply("root", "yes");

  const second = harness({ root: {} });
  for (const [key, value] of first.data) second.data.set(key, value);
  expect(await second.context("root")).toEqual([]);
  await second.command("root");
  expect(second.prompts.at(-1)?.text).toContain("pnpm add github:");
  expect(second.commandName).toBe(SHERPA_INSTALL_COMMAND);
});

test("only exact standalone yes or igen records project consent", async () => {
  for (const answer of ["yes", "igen"] as const) {
    const h = harness({ root: {} });
    await h.context("root");
    await h.reply("root", `please ${answer}`);
    await h.reply("root", answer.toUpperCase());
    await h.command("root");
    expect(h.prompts.at(-1)?.text).toContain("not approved");

    await h.reply("root", answer);
    await h.command("root");
    expect(h.prompts.at(-1)?.text).toContain("pnpm add github:rozsazoltan/opencode-sherpa#e26316eeb7cdf83e6d77090c7aadcd7c13961753");
  }
});

test("exact no or nem declines, and exact consent is ignored before session reminder", async () => {
  for (const answer of ["no", "nem"] as const) {
    const h = harness({ root: {} });
    await h.reply("root", "yes");
    await h.context("root");
    await h.reply("root", answer);
    await h.command("root");
    expect(h.prompts.at(-1)?.text).toContain("not approved");
  }
});

test("consent is scoped to both project ID and absolute project directory", async () => {
  const h = harness({
    first: { projectID: "shared-id", directory: "/workspace/first" },
    second: { projectID: "shared-id", directory: "/workspace/second" },
  });
  await consent(h, "first", "yes");

  await h.command("first");
  expect(h.prompts.at(-1)?.text).toContain("pnpm add github:");

  await h.command("second");
  expect(h.prompts.at(-1)?.text).toContain("not approved");
});

test("lookup and storage failures fail closed without repeating reminders", async () => {
  const lookupFailure = harness({ broken: { fail: true } });
  expect(await lookupFailure.context("broken")).toEqual([]);
  expect(await lookupFailure.context("broken")).toEqual([]);

  const storageFailure = harness({ root: {} });
  storageFailure.setStorageGetFailure(true);
  expect(await storageFailure.context("root")).toEqual([]);
  await storageFailure.command("root");
  expect(storageFailure.prompts.at(-1)?.text).toContain("not approved");

  const markerWriteFailure = harness({ root: {} });
  markerWriteFailure.setStorageSetFailure(true);
  expect(await markerWriteFailure.context("root")).toEqual([]);
  expect(await markerWriteFailure.context("root")).toEqual([]);
});

test("failed consent persistence never authorizes installation", async () => {
  const h = harness({ root: {} });
  await h.context("root");
  h.setStorageSetFailure(true);
  await h.reply("root", "yes");
  await h.command("root");

  expect(h.prompts.at(-1)?.text).toContain("not approved");
});

test("sherpa-install only requests fixed permissioned sequence through session.prompt", async () => {
  const h = harness({ root: {} });
  await consent(h, "root", "yes");
  await h.command("root");

  expect(h.prompts).toHaveLength(1);
  expect(h.prompts[0]?.text).toContain("ordinary permissioned shell tools only");
  expect(h.prompts[0]?.text).toContain("Run commands in this session's verified project directory");
  expect(h.prompts[0]?.text).toContain("pnpm add github:rozsazoltan/opencode-sherpa#e26316eeb7cdf83e6d77090c7aadcd7c13961753");
  expect(h.prompts[0]?.text).toContain("Only if step 1 succeeds, run `pnpm exec sherpa sync`.");
  expect(h.prompts[0]?.text).toContain("may run dependency lifecycle scripts");
  expect(h.prompts[0]?.text).toContain("Do not use -g or -w");
  expect(h.prompts[0]?.text).not.toContain("sherpa install");
});

test("command asks for consent when undecided and does not interpolate invocation text", async () => {
  const h = harness({ root: {} });
  await h.command("root");
  expect(h.prompts.at(-1)?.text).toContain("not approved");

  await consent(h, "root", "yes");
  await h.command("root", { text: "--global; run rm -rf /" });
  expect(h.prompts.at(-1)?.text).toContain("pnpm add github:");
  expect(h.prompts.at(-1)?.text).not.toContain("rm -rf /");
});
