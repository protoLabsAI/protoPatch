import { ClawpatchError } from "../errors.js";
import { runCommandArgs } from "../exec.js";
import { providerExitCode } from "../provider-errors.js";
import { safeProviderPreview } from "../provider-json.js";
import { parseOrThrow, parseReviewOutput } from "../provider-output.js";
import { providerTimeoutMs } from "../provider-runtime.js";
import {
  agentMapJsonSchema,
  fixPlanJsonSchema,
  reviewJsonSchema,
  revalidateJsonSchema,
} from "../provider-schema.js";
import type { PartitionedReviewOutput, Provider, ProviderOptions } from "../provider-types.js";
import {
  AgentMapOutput,
  FixPlanOutput,
  RevalidateOutput,
  agentMapOutputSchema,
  fixPlanOutputSchema,
  revalidateOutputSchema,
} from "../types.js";
import { acpxFailureMessage, acpxPromptRetries, buildAcpxPrompt, extractAcpxJson } from "./acpx.js";

const PROTO_DEFAULT_MODEL = "protolabs/reasoning";
const PROTO_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const PROTO_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u;

function protoTimeoutMs(): number {
  return providerTimeoutMs("CLAWPATCH_PROTO_TIMEOUT_MS", PROTO_DEFAULT_TIMEOUT_MS);
}

function protoAgentCommand(options: ProviderOptions): string {
  // Build the inner `proto --acp` invocation acpx hands off to. protoCLI
  // honors `-m <model>` for model selection. We prefer options.model
  // (per-invocation CLI override), then CLAWPATCH_PROTO_MODEL env, then the
  // package default.
  const model = options.model ?? process.env["CLAWPATCH_PROTO_MODEL"] ?? PROTO_DEFAULT_MODEL;
  // The command is one string that acpx splits itself, so anything beyond a
  // plain model id (whitespace, quotes, `;`, `$()`) could add arguments or
  // commands of its own. Model ids are `provider/name:tag@version` shaped.
  if (!PROTO_MODEL_PATTERN.test(model)) {
    throw new ClawpatchError(
      `proto provider: refusing model ${JSON.stringify(model)} — a model id may only contain letters, digits and . _ : / @ + -`,
      2,
      "invalid-model",
    );
  }
  return `proto --acp -m ${model}`;
}

function buildProtoAcpxArgs(
  root: string,
  options: ProviderOptions,
  permission: "read" | "approve",
): string[] {
  const permFlag = permission === "read" ? "--approve-reads" : "--approve-all";
  const args = [
    "--agent",
    protoAgentCommand(options),
    "--cwd",
    root,
    permFlag,
    "--format",
    "json",
    "--json-strict",
    "--suppress-reads",
  ];
  const promptRetries = acpxPromptRetries();
  if (permission === "read" && promptRetries > 0) {
    args.push("--prompt-retries", String(promptRetries));
  }
  args.push("exec", "--file", "-");
  return args;
}

async function runProtoJson<T>(
  root: string,
  prompt: string,
  options: ProviderOptions,
  schema: object,
  permission: "read" | "approve",
  parseOutput: (output: unknown) => T,
): Promise<T> {
  const args = buildProtoAcpxArgs(root, options, permission);
  const result = await runCommandArgs(
    "acpx",
    args,
    root,
    buildAcpxPrompt(prompt, schema, permission),
    { trimOutput: false, timeoutMs: protoTimeoutMs() },
  );
  if (result.exitCode !== 0) {
    // Reuse acpxFailureMessage — the underlying CLI is acpx; the failure
    // shape (auth, timeout, JSON-parse) is identical. The caller can tell
    // from the prefix on the message that this came through the proto
    // provider.
    const baseMessage = acpxFailureMessage(result.stdout, result.stderr, result.exitCode);
    throw new ClawpatchError(
      baseMessage.replace(/^acpx provider failed/, "proto provider failed"),
      providerExitCode(result.stdout, result.stderr),
      "provider-failure",
    );
  }
  const json = extractAcpxJson(result.stdout);
  if (json === null) {
    throw new ClawpatchError(
      `proto: response was not parseable JSON (preview=${safeProviderPreview(result.stdout)})`,
      4,
      "provider-failure",
    );
  }
  return parseOutput(json);
}

export const protoProvider: Provider = {
  name: "proto",
  async check(root: string): Promise<string> {
    // Confirm both ends of the wire: acpx (the ACP driver) and proto (the
    // agent it'll spawn). check() is allowed to spend a few ms but not LLM
    // tokens — versions are enough.
    const acpxR = await runCommandArgs("acpx", ["--version"], root);
    if (acpxR.exitCode !== 0) {
      throw new ClawpatchError(
        "acpx CLI not available (needed to drive proto via ACP). Install: npm install -g acpx@latest",
        4,
        "provider-auth",
      );
    }
    const protoR = await runCommandArgs("proto", ["--version"], root);
    if (protoR.exitCode !== 0) {
      throw new ClawpatchError(
        "proto CLI not available. Install: npm install -g @protolabsai/proto",
        4,
        "provider-auth",
      );
    }
    return `acpx=${acpxR.stdout.trim()} proto=${protoR.stdout.trim()}`;
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    return runProtoJson(root, prompt, options, agentMapJsonSchema, "read", (output) =>
      parseOrThrow(agentMapOutputSchema, output, "proto agent-map"),
    );
  },
  async review(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<PartitionedReviewOutput> {
    return runProtoJson(root, prompt, options, reviewJsonSchema, "read", (output) =>
      parseReviewOutput(output),
    );
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    return runProtoJson(root, prompt, options, fixPlanJsonSchema, "approve", (output) =>
      parseOrThrow(fixPlanOutputSchema, output, "proto fix-plan"),
    );
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    return runProtoJson(root, prompt, options, revalidateJsonSchema, "read", (output) =>
      parseOrThrow(revalidateOutputSchema, output, "proto revalidate"),
    );
  },
};

export const protoTesting = { buildProtoAcpxArgs, protoAgentCommand, protoTimeoutMs };
