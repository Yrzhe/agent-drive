import type { Context } from "hono";

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function handleApiError(c: Context, error: unknown): Response {
  if (error instanceof ApiError) {
    return c.json(
      { error: { code: error.code, message: error.message } },
      error.status as 400 | 401 | 403 | 404 | 409 | 410 | 429 | 500
    );
  }

  console.error("Unhandled API error", error);
  return c.json(
    { error: { code: "internal_error", message: "Internal server error" } },
    500
  );
}

export const withErrorHandling =
  (handler: (c: Context) => Promise<Response>) =>
  async (c: Context): Promise<Response> => {
    try {
      return await handler(c);
    } catch (error) {
      return handleApiError(c, error);
    }
  };
