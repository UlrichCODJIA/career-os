# Worker app boundary

Owns scheduler composition and durable job handlers. Shared-index scan workers do not receive candidate-private repositories or model-provider secrets.

DSV-002 provides the executable Bun composition root and `/healthz`; scheduler election and durable handlers land in later tasks.
