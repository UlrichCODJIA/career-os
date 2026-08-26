import type { SourceObservation } from "@career-os/discovery-domain";

export interface ArtifactView {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sourceUrl: URL;
}

export interface ConnectorResult {
  readonly observations: readonly SourceObservation[];
  readonly completeForAbsenceInference: boolean;
}

export interface Connector {
  readonly id: string;
  parse(artifact: ArtifactView): Promise<ConnectorResult>;
}
