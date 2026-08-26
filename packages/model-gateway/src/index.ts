export interface ModelRequest<TOutput> {
  readonly operation: string;
  readonly input: unknown;
  readonly validateOutput: (value: unknown) => TOutput;
}

export interface ModelGateway {
  complete<TOutput>(request: ModelRequest<TOutput>): Promise<TOutput>;
}
