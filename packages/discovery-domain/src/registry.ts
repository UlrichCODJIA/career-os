import type {
  RejectSourceCandidate,
  SourceCandidateImport,
  SourcePatch,
  SourcePolicyCreate,
  SourcePolicyPatch,
  VerifySourceCandidate,
} from "@career-os/contracts";

export interface RegistryMutationContext {
  actorId: string;
  idempotencyKey: string;
}

export interface RegistryStore {
  importCandidates(context: RegistryMutationContext, command: SourceCandidateImport): Promise<unknown>;
  createPolicy(context: RegistryMutationContext, command: SourcePolicyCreate): Promise<unknown>;
  verifyCandidate(context: RegistryMutationContext, candidateId: string, command: VerifySourceCandidate): Promise<unknown>;
  rejectCandidate(context: RegistryMutationContext, candidateId: string, command: RejectSourceCandidate): Promise<unknown>;
  updatePolicy(context: RegistryMutationContext, policyId: string, command: SourcePolicyPatch): Promise<unknown>;
  updateSource(context: RegistryMutationContext, sourceId: string, command: SourcePatch): Promise<unknown>;
  listCandidates(state?: string): Promise<unknown>;
  listSources(enabled?: boolean): Promise<unknown>;
}

export class RegistryRuleError extends Error {
  constructor(public readonly code: string, public readonly status: 400 | 404 | 409 | 422 = 422) {
    super(code);
    this.name = "RegistryRuleError";
  }
}

export class RegistryService {
  constructor(private readonly store: RegistryStore) {}

  importCandidates(context: RegistryMutationContext, command: SourceCandidateImport): Promise<unknown> {
    return this.store.importCandidates(context, command);
  }

  createPolicy(context: RegistryMutationContext, command: SourcePolicyCreate): Promise<unknown> {
    const reviewedAt = new Date(command.reviewedAt);
    const expiresAt = new Date(command.expiresAt);
    if (reviewedAt > new Date() || expiresAt <= reviewedAt) throw new RegistryRuleError("invalid_policy_review_window");
    if (command.state === "approved" && expiresAt <= new Date()) throw new RegistryRuleError("expired_policy_cannot_be_approved");
    return this.store.createPolicy(context, command);
  }

  verifyCandidate(
    context: RegistryMutationContext,
    candidateId: string,
    command: VerifySourceCandidate,
  ): Promise<unknown> {
    if (command.evidence.type !== "operator_confirmation" && command.evidence.confidence < 0.9) {
      throw new RegistryRuleError("ambiguous_ownership_requires_review");
    }
    return this.store.verifyCandidate(context, candidateId, command);
  }

  rejectCandidate(
    context: RegistryMutationContext,
    candidateId: string,
    command: RejectSourceCandidate,
  ): Promise<unknown> {
    return this.store.rejectCandidate(context, candidateId, command);
  }

  updatePolicy(context: RegistryMutationContext, policyId: string, command: SourcePolicyPatch): Promise<unknown> {
    const reviewedAt = new Date(command.reviewedAt);
    const expiresAt = new Date(command.expiresAt);
    if (reviewedAt > new Date() || expiresAt <= reviewedAt) throw new RegistryRuleError("invalid_policy_review_window");
    if (command.state === "approved" && expiresAt <= new Date()) throw new RegistryRuleError("expired_policy_cannot_be_approved");
    return this.store.updatePolicy(context, policyId, command);
  }

  updateSource(context: RegistryMutationContext, sourceId: string, command: SourcePatch): Promise<unknown> {
    return this.store.updateSource(context, sourceId, command);
  }

  listCandidates(state?: string): Promise<unknown> {
    return this.store.listCandidates(state);
  }

  listSources(enabled?: boolean): Promise<unknown> {
    return this.store.listSources(enabled);
  }
}
