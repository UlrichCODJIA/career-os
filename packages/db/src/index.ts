export interface DatabaseHealth {
  check(): Promise<{ ok: true; latencyMs: number }>;
}

export interface TransactionContext {
  readonly transactionId: string;
}
