export interface SourceIdentity {
  companyId: string;
  connectorId: string;
  externalSourceId: string;
}

export interface SourceObservation {
  identity: SourceIdentity;
  observedAt: string;
  artifactDigest: string;
  completeForAbsenceInference: boolean;
}
