import type { HealthResponse } from "@career-os/contracts";

export type ServiceEvent = Pick<HealthResponse, "service" | "profile" | "version"> & {
  event: "service_started" | "service_stopped";
  host: string;
  port: number;
};

export function logServiceEvent(event: ServiceEvent): void {
  console.log(JSON.stringify({ ...event, timestamp: new Date().toISOString() }));
}
