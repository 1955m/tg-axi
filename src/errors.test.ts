import { describe, expect, it } from "vitest";
import { mapTgApiError } from "./errors.js";

describe("mapTgApiError", () => {
  it("maps 429 to RATE_LIMITED with retry_after", () => {
    const err = mapTgApiError(429, "Too Many Requests: retry after 5", { retry_after: 5 });
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.message).toContain("retry after 5");
  });

  it("maps 429 to RATE_LIMITED without retry_after", () => {
    const err = mapTgApiError(429, "Too Many Requests", {});
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.suggestions.length).toBeGreaterThan(0);
  });

  it("maps 401 to AUTH_REQUIRED", () => {
    const err = mapTgApiError(401, "Unauthorized", {});
    expect(err.code).toBe("AUTH_REQUIRED");
    expect(err.message).toContain("token");
    expect(err.suggestions.length).toBeGreaterThan(0);
  });

  it("maps 403 'bot was blocked' to FORBIDDEN", () => {
    const err = mapTgApiError(403, "Forbidden: bot was blocked by the user", {});
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toContain("blocked");
  });

  it("maps 403 chat-rights to FORBIDDEN with chat hint", () => {
    const err = mapTgApiError(403, "Forbidden: not enough rights to send text messages to the chat", {});
    expect(err.code).toBe("FORBIDDEN");
    expect(err.suggestions.some((s) => s.includes("--chat"))).toBe(true);
  });

  it("maps 400 'chat not found' to NOT_FOUND", () => {
    const err = mapTgApiError(400, "Bad Request: chat not found", {});
    expect(err.code).toBe("NOT_FOUND");
  });

  it("maps 400 'message text is empty' to VALIDATION_ERROR", () => {
    const err = mapTgApiError(400, "Bad Request: message text is empty", {});
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  it("maps 400 generic to VALIDATION_ERROR", () => {
    const err = mapTgApiError(400, "Bad Request: malformed chat id", {});
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("400");
  });

  it("maps 404 to NOT_FOUND", () => {
    const err = mapTgApiError(404, "Not Found", {});
    expect(err.code).toBe("NOT_FOUND");
  });

  it("maps 409 to VALIDATION_ERROR", () => {
    const err = mapTgApiError(409, "Conflict: terminated", {});
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  it("maps 5xx to UNKNOWN", () => {
    const err = mapTgApiError(500, "Internal Server Error", {});
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toContain("server error");
  });

  it("maps an unknown code to UNKNOWN", () => {
    const err = mapTgApiError(418, "I'm a teapot", {});
    expect(err.code).toBe("UNKNOWN");
  });

  it("maps undefined error_code to UNKNOWN", () => {
    const err = mapTgApiError(undefined, "", {});
    expect(err.code).toBe("UNKNOWN");
  });
});
