import { isOfficeSnapshot, type OfficeSnapshot } from "../domain/office-snapshot";
import mockSnapshot from "../../resources/mock/office-snapshot.json";
import emptyMockSnapshot from "../../resources/mock/office-empty-snapshot.json";

export type OfficeMockMode = "populated" | "empty" | null;

export class OfficeSnapshotError extends Error {
  constructor(readonly reason: "UNAUTHORIZED" | "NETWORK" | "INVALID_RESPONSE") {
    super(reason);
    this.name = "OfficeSnapshotError";
  }
}

export async function loadOfficeSnapshot(
  mockMode: OfficeMockMode,
  apiBaseUrl: string,
): Promise<OfficeSnapshot> {
  const payload: unknown = mockMode
    ? mockMode === "empty"
      ? emptyMockSnapshot
      : mockSnapshot
    : await fetch(`${apiBaseUrl}/office/snapshot`, { credentials: "include" })
        .then(async (response) => {
          if (response.status === 401) throw new OfficeSnapshotError("UNAUTHORIZED");
          if (!response.ok) throw new OfficeSnapshotError("NETWORK");
          return response.json();
        })
        .catch((error: unknown) => {
          if (error instanceof OfficeSnapshotError) throw error;
          throw new OfficeSnapshotError("NETWORK");
        });
  if (!isOfficeSnapshot(payload)) throw new OfficeSnapshotError("INVALID_RESPONSE");
  return payload;
}
