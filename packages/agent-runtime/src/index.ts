export interface AgentCapability {
  readonly name: string;
  readonly requiresApproval: boolean;
}

export interface AgentRunRequest {
  readonly operation: string;
  readonly capabilities: readonly AgentCapability[];
}

export interface AgentRuntime {
  run(request: AgentRunRequest): AsyncIterable<unknown>;
}
