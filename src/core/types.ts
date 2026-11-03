import { z } from "zod";

export const CompensateSchema = z.object({
  canonical_id: z.string(),
  input: z.unknown().optional(),
});

export const StepSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  canonical_id: z.string(),
  input: z.unknown().default({}),
  sideEffect: z.boolean().default(false),
  compensate: CompensateSchema.optional(),
});

export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  executor: z.enum(["mock", "swytchcode", "github"]).default("mock"),
  inputs: z.record(z.string(), z.unknown()).default({}),
  steps: z.array(StepSchema).min(1),
});

export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowStep = z.infer<typeof StepSchema>;

export type ExecutorName = "mock" | "swytchcode" | "github";

export type StepError = {
  category?: string;
  message: string;
  retryable?: boolean;
  suggestedAction?: string;
  raw?: unknown;
};

export type ExecResult =
  | { ok: true; output: unknown }
  | { ok: false; error: StepError };

export interface Executor {
  name: ExecutorName;
  mock: boolean;
  exec(canonicalId: string, input: unknown, ctx: { dryRun: boolean }): Promise<ExecResult>;
}

export type Context = {
  inputs: Record<string, unknown>;
  steps: Record<string, { input: unknown; output: unknown }>;
};

export type SnapshotStatus = "ok" | "error" | "skipped" | "injected";

export type Snapshot = {
  schema: 1;
  runId: string;
  workflowId: string;
  /** position inside the run's hash chain (compensation snapshots make this differ from stepIndex) */
  seq: number;
  stepIndex: number;
  stepId: string;
  canonicalId: string;
  startedAt: string;
  durationMs: number;
  input: unknown;
  resolvedInput: unknown;
  status: SnapshotStatus;
  output?: unknown;
  error?: StepError;
  sideEffect: boolean;
  executor: ExecutorName;
  mock: boolean;
  contextAfter: Context;
  prevHash: string | null;
  hash: string;
};

export type Manifest = {
  runId: string;
  workflowId: string;
  createdAt: string;
  parentRunId?: string;
  replayFromStep?: number;
  overrides?: string[];
  executor: ExecutorName;
  mock: boolean;
  steps: { index: number; id: string; canonicalId: string; sideEffect: boolean }[];
  outcome: "ok" | "failed";
  failedStep?: number;
  /** extra (not in the original spec): lets replay be self-contained */
  workflow: Workflow;
  inputs: Record<string, unknown>;
  executorCalls?: number;
  injectedSteps?: number;
};

export class TmError extends Error {
  constructor(
    message: string,
    public code: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = "TmError";
  }
}

export class InterpolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterpolationError";
  }
}
