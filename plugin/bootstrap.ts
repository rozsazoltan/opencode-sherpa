export const SHERPA_INSTALL_COMMAND = "sherpa-install";
export const SHERPA_UPGRADE_COMMAND = "sherpa-upgrade";

const PROJECT_STATE_PREFIX = "sherpa-bootstrap:v1:project:";
const SESSION_REMINDER_PREFIX = "sherpa-bootstrap:v1:session:";
const ACCEPTED = "v1:accepted";
const DECLINED = "v1:declined";
const REMINDED = "v1:reminded";

const CONSENT_REMINDER =
  "Would you like to enable OpenCode Sherpa for this project? It can add or upgrade the pinned Sherpa CLI dependency, which edits package.json and the package-manager lockfile and may run dependency lifecycle scripts. Reply exactly yes to consent or no to decline. Nothing installs automatically.";

const CONSENT_REQUIRED_NOTICE =
  "Sherpa bootstrap is not approved for this project. Do not install anything. To approve, reply exactly yes after the project consent reminder; to decline, reply no.";

const INSTALL_REQUEST = [
  "The user explicitly approved Sherpa bootstrap for this project. Use ordinary permissioned shell tools only; do not bypass or suppress shell permission checks.",
  "Run commands in this session's verified project directory. Do not run globally or at workspace root. Stop if pnpm is missing or a workspace conflict makes the project target ambiguous. Do not use -g or -w, and do not interpolate user-supplied command arguments.",
  "Run exactly this sequence:",
  "1. `pnpm add github:rozsazoltan/opencode-sherpa#e26316eeb7cdf83e6d77090c7aadcd7c13961753`",
  "2. Only if step 1 succeeds, run `pnpm exec sherpa sync`.",
  "The add command changes package.json and the lockfile, and may run dependency lifecycle scripts. Stop if step 1 fails. Do not substitute commands or run any additional install command.",
].join("\n");

const UPGRADE_REQUEST = [
  "The user explicitly invoked /sherpa-upgrade and already approved Sherpa for this project. Use ordinary permissioned shell tools only; do not bypass or suppress shell permission checks.",
  "Run commands in this session's verified project directory. Do not run globally or at workspace root. Stop if pnpm is missing or a workspace conflict makes the project target ambiguous. Do not use -g or -w, and do not interpolate user-supplied command arguments.",
  "First verify package.json has `opencode-sherpa` in `dependencies` and its value points to `github:rozsazoltan/opencode-sherpa#<commit>`; otherwise stop and explain that Sherpa is not installed from the expected source. Do not change unrelated dependencies.",
  "Resolve the current master commit with `git ls-remote https://github.com/rozsazoltan/opencode-sherpa.git refs/heads/master`. Continue only if output contains exactly one 40-character hexadecimal commit SHA. Do not use the branch name as the package spec.",
  "Then run exactly this sequence:",
  "1. `pnpm add github:rozsazoltan/opencode-sherpa#<resolved-40-character-commit-SHA>`.",
  "2. Only if step 1 succeeds, run `pnpm exec sherpa sync`.",
  "The add command updates the Sherpa dependency and lockfile, and may run dependency lifecycle scripts. Stop if step 1 fails. Do not substitute commands or run any additional install command.",
].join("\n");

type StorageResult = unknown | Promise<unknown>;

export interface BootstrapStorage {
  get(key: string): StorageResult;
  set(key: string, value: unknown): StorageResult;
  remove(key: string): StorageResult;
}

interface HookBaseEvent {
  readonly sessionID: string;
}

export interface ContextHookEvent extends HookBaseEvent {
  readonly system: Array<{ readonly type: "text"; readonly text: string }>;
}

export interface PromptHookEvent extends HookBaseEvent {
  readonly prompt: { readonly text: string };
}

interface CommandInvocation {
  readonly sessionID: string;
  readonly prompt: unknown;
  readonly delivery: "steer" | "queue";
}

interface CommandDefinition {
  readonly name: string;
  readonly description: string;
  execute(input: CommandInvocation): Promise<void>;
}

export interface BootstrapPluginContext {
  readonly session: {
    get(input: { readonly sessionID: string }): Promise<unknown> | unknown;
    hook(event: "context", handler: (event: ContextHookEvent) => void | Promise<void>): void;
    hook(event: "prompt", handler: (event: PromptHookEvent) => void | Promise<void>): void;
    prompt(input: { readonly sessionID: string; readonly text: string; readonly delivery: "steer" | "queue" }): Promise<unknown> | unknown;
  };
  readonly storage: BootstrapStorage;
  readonly command: {
    transform(handler: (editor: { add(definition: CommandDefinition): void }) => void): unknown;
  };
}

interface VerifiedSession {
  readonly projectID: string;
  readonly directory: string;
  readonly isChild: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isAbsoluteDirectory(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value);
}

function unwrapSession(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (!Object.hasOwn(value, "data")) return value;
  return isRecord(value.data) ? value.data : undefined;
}

function validateSession(value: unknown, expectedSessionID: string): VerifiedSession | undefined {
  const session = unwrapSession(value);
  if (!session) return undefined;

  for (const identityField of ["id", "sessionID"] as const) {
    if (Object.hasOwn(session, identityField) && session[identityField] !== expectedSessionID) return undefined;
  }
  const projectID = session.projectID;
  const directory = session.directory;
  const parentID = session.parentID;
  if (typeof projectID !== "string" || projectID.trim() === "" || hasControlCharacters(projectID)) return undefined;
  if (typeof directory !== "string" || !isAbsoluteDirectory(directory) || hasControlCharacters(directory)) return undefined;
  if (parentID !== undefined && (typeof parentID !== "string" || parentID.trim() === "")) return undefined;

  return { projectID, directory, isChild: parentID !== undefined };
}

function projectKey(session: VerifiedSession): string {
  return `${PROJECT_STATE_PREFIX}${encodeURIComponent(session.projectID)}:${encodeURIComponent(session.directory)}`;
}

function reminderKey(sessionID: string): string {
  return `${SESSION_REMINDER_PREFIX}${encodeURIComponent(sessionID)}`;
}

function exactConsent(prompt: string): "accepted" | "declined" | undefined {
  const answer = prompt.trim();
  if (answer === "yes") return "accepted";
  if (answer === "no") return "declined";
  return undefined;
}

export function registerSherpaBootstrap(ctx: BootstrapPluginContext): void {
  const contextEventsSeen = new Set<string>();

  const getSession = async (sessionID: string): Promise<VerifiedSession | undefined> => {
    try {
      return validateSession(await ctx.session.get({ sessionID }), sessionID);
    } catch {
      return undefined;
    }
  };

  const getDecision = async (key: string): Promise<"accepted" | "declined" | "undecided" | "invalid"> => {
    try {
      const value = await ctx.storage.get(key);
      if (value === undefined) return "undecided";
      if (value === ACCEPTED) return "accepted";
      if (value === DECLINED) return "declined";
      return "invalid";
    } catch {
      return "invalid";
    }
  };

  ctx.session.hook("context", async (event) => {
    const sessionID = event.sessionID;
    if (typeof sessionID !== "string" || sessionID.trim() === "" || !Array.isArray(event.system) || contextEventsSeen.has(sessionID)) return;
    // Claim session in memory before any await, so parallel context events cannot duplicate reminders.
    contextEventsSeen.add(sessionID);

    const session = await getSession(sessionID);
    if (!session || session.isChild) return;

    const key = projectKey(session);
    if (await getDecision(key) !== "undecided") return;

    const sessionMarkerKey = reminderKey(sessionID);
    try {
      const marker = await ctx.storage.get(sessionMarkerKey);
      if (marker !== undefined) return;
      await ctx.storage.set(sessionMarkerKey, REMINDED);
    } catch {
      return;
    }

    event.system.push({ type: "text", text: CONSENT_REMINDER });
  });

  ctx.session.hook("prompt", async (event) => {
    const sessionID = event.sessionID;
    if (typeof sessionID !== "string" || sessionID.trim() === "" || typeof event.prompt?.text !== "string") return;
    const consent = exactConsent(event.prompt.text);
    if (!consent) return;

    const session = await getSession(sessionID);
    if (!session || session.isChild) return;

    const key = projectKey(session);
    if (await getDecision(key) !== "undecided") return;

    try {
      if (await ctx.storage.get(reminderKey(sessionID)) !== REMINDED) return;
      await ctx.storage.set(key, consent === "accepted" ? ACCEPTED : DECLINED);
    } catch {
      // Consent write failures must never authorize an install.
    }
  });

  ctx.command.transform((editor) => {
    editor.add({
      name: SHERPA_INSTALL_COMMAND,
      description: "Install and sync project-local Sherpa after explicit project consent.",
      execute: async (input) => requestProjectCommand(input, INSTALL_REQUEST),
    });
    editor.add({
      name: SHERPA_UPGRADE_COMMAND,
      description: "Upgrade project-local Sherpa to the latest master commit and sync it.",
      execute: async (input) => requestProjectCommand(input, UPGRADE_REQUEST),
    });
  });

  async function requestProjectCommand(
    { sessionID, delivery }: CommandInvocation,
    request: string,
  ): Promise<void> {
    const session = await getSession(sessionID);
    let text = CONSENT_REQUIRED_NOTICE;
    if (session && !session.isChild) {
      const decision = await getDecision(projectKey(session));
      if (decision === "accepted") text = request;
    }

    try {
      await ctx.session.prompt({ sessionID, text, delivery });
    } catch {
      // Prompt delivery failure does not trigger a shell action or alter consent.
    }
  }
}
