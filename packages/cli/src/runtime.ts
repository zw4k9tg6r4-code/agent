import {
  createAgentRunner,
  type AgentCoreOptions,
} from "@agent/core";
import {
  DefaultPermissionEvaluator,
} from "@agent/policy";
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderConfig,
} from "@agent/providers";
import {
  createBuiltinTools,
  FileCheckpointStore,
} from "@agent/tools";
import type {
  AgentDependencies,
  AgentRunner,
  CheckpointStore,
  ModelProvider,
  PermissionConfirmer,
  PermissionEvaluator,
  SessionEventStore,
  Tool,
} from "@agent/contracts";

import { loadProviderProfile, type AgentConfig } from "./config.js";

export type { AgentCoreOptions } from "@agent/core";

export interface ProviderConstructor {
  new (config: OpenAICompatibleProviderConfig): ModelProvider;
}

export interface PermissionEvaluatorConstructor {
  new (): PermissionEvaluator;
}

export interface CheckpointStoreConstructor {
  new (): CheckpointStore;
}

export interface RuntimeModules {
  readonly OpenAICompatibleProvider: ProviderConstructor;
  readonly DefaultPermissionEvaluator: PermissionEvaluatorConstructor;
  readonly FileCheckpointStore: CheckpointStoreConstructor;
  readonly createBuiltinTools: () => readonly Tool[];
  readonly createAgentRunner: (
    dependencies: AgentDependencies,
    options?: AgentCoreOptions,
  ) => AgentRunner;
}

export interface RuntimeFactoryInput {
  readonly config: AgentConfig;
  readonly sessions: SessionEventStore;
  readonly confirmations: PermissionConfirmer;
}

export interface RuntimeBundle {
  readonly runner: AgentRunner;
  readonly checkpoints: CheckpointStore;
}

export interface CliRuntimeFactory {
  create(input: RuntimeFactoryInput): Promise<RuntimeBundle>;
  createCheckpointStore(): Promise<CheckpointStore>;
}

export const DEFAULT_RUNTIME_MODULES: RuntimeModules = {
  createAgentRunner,
  OpenAICompatibleProvider,
  createBuiltinTools,
  DefaultPermissionEvaluator,
  FileCheckpointStore,
};

export class ProductionRuntimeFactory implements CliRuntimeFactory {
  readonly #modules: RuntimeModules;

  constructor(modules: RuntimeModules = DEFAULT_RUNTIME_MODULES) {
    this.#modules = modules;
  }

  async create(input: RuntimeFactoryInput): Promise<RuntimeBundle> {
    const profile = await loadProviderProfile(input.config.provider.profileId);
    const provider = new this.#modules.OpenAICompatibleProvider({
      baseUrl: profile.baseUrl,
      model: input.config.provider.model,
      apiKeyEnvVar: profile.apiKeyEnv,
      requestTimeoutMs: input.config.provider.requestTimeoutMs,
      maxRetries: input.config.provider.maxRetries,
    });
    const checkpoints = new this.#modules.FileCheckpointStore();
    const dependencies: AgentDependencies = {
      provider,
      tools: this.#modules.createBuiltinTools(),
      permissions: new this.#modules.DefaultPermissionEvaluator(),
      confirmations: input.confirmations,
      sessions: input.sessions,
      checkpoints,
    };
    return {
      runner: this.#modules.createAgentRunner(dependencies, {
        enabledSkills: input.config.skills,
      }),
      checkpoints,
    };
  }

  async createCheckpointStore(): Promise<CheckpointStore> {
    return new this.#modules.FileCheckpointStore();
  }
}
