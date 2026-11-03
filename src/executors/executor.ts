import path from "node:path";
import type { Executor, ExecutorName } from "../core/types";
import type { Store } from "../core/store";
import { MockExecutor, type MockState } from "./mock";
import { SwytchcodeExecutor } from "./swytchcode";
import { GitHubExecutor } from "./github";

export function mockDbFile(store: Store): string {
  return path.join(store.root, ".mock-db.json");
}

export function createExecutor(name: ExecutorName, store: Store, cwd?: string, mockState?: MockState): Executor {
  if (name === "mock") return new MockExecutor(mockDbFile(store), mockState);
  if (name === "github") return new GitHubExecutor();
  return new SwytchcodeExecutor(cwd);
}

export function mockLedger(store: Store) {
  return new MockExecutor(mockDbFile(store)).ledger();
}
