export type OfficeMockQuery = "1" | "empty" | null;

/**
 * The React boundary owns iframe configuration. Cocos receives one stable API
 * base URL and an explicitly allow-listed demo mode; arbitrary parent query
 * parameters never leak into the embedded application.
 */
export function officeFrameUrl(apiUrl: string, requestedMock: string | null): string {
  const params = new URLSearchParams({ apiBaseUrl: apiUrl });
  if (requestedMock === "1" || requestedMock === "empty") {
    params.set("mock", requestedMock satisfies Exclude<OfficeMockQuery, null>);
  }
  return `/office-cocos/index.html?${params.toString()}`;
}
