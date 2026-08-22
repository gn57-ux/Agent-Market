/**
 * The one place `apps/web` knows how to reach `apps/api`: base URL,
 * `credentials: "include"` (required for the session cookie to actually be
 * sent — Feature 4's session is a cookie, not a bearer token this client
 * attaches itself), JSON request/response handling, and error-body
 * extraction. Every feature module (Feature 5's agents API, and every
 * later Feature's own API calls) goes through this instead of calling
 * `fetch` directly, so this is the single place that would change if the
 * transport ever did (e.g. adding a CSRF header).
 */

const DEFAULT_BASE_URL = "http://localhost:3001";

function apiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL ?? DEFAULT_BASE_URL;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ApiErrorBody {
  error?: { message?: unknown; code?: unknown };
}

async function readErrorMessage(response: Response): Promise<{ message: string; code?: string }> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    const message = typeof body.error?.message === "string" ? body.error.message : undefined;
    const code = typeof body.error?.code === "string" ? body.error.code : undefined;
    return { message: message ?? `请求失败（HTTP ${response.status}）`, code };
  } catch {
    return { message: `请求失败（HTTP ${response.status}）` };
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    const { message, code } = await readErrorMessage(response);
    throw new ApiError(response.status, message, code);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
