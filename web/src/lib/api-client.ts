import { client } from "@/lib/edgespark";

export const isMockMode = import.meta.env.VITE_USE_MOCK === "true";

export class DriveApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 500, code = "UNKNOWN") {
    super(message);
    this.name = "DriveApiError";
    this.status = status;
    this.code = code;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  return (text ? (JSON.parse(text) as T) : ({} as T));
}

export async function apiFetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await client.api.fetch(input, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    let code = "UNKNOWN";
    try {
      const body = await readJson<{ message?: string; error?: string | { code?: string; message?: string }; code?: string }>(response);
      if (typeof body.error === "object" && body.error !== null) {
        message = body.error.message ?? message;
        code = body.error.code ?? code;
      } else {
        message = body.message ?? (typeof body.error === "string" ? body.error : null) ?? message;
        code = body.code ?? code;
      }
    } catch {
      // Ignore malformed error body.
    }
    throw new DriveApiError(message, response.status, code);
  }

  return readJson<T>(response);
}

export async function withMockFallback<T>(
  realRequest: () => Promise<T>,
  mockRequest: () => Promise<T>,
): Promise<T> {
  if (isMockMode) return mockRequest();
  try {
    return await realRequest();
  } catch (error) {
    const isNetworkFetchError =
      error instanceof TypeError &&
      (error.message.includes("Failed to fetch") || error.message.includes("fetch failed"));
    if (import.meta.env.DEV && isNetworkFetchError) {
      console.warn("[drive-api] falling back to mock data", error);
      return mockRequest();
    }
    throw error;
  }
}
