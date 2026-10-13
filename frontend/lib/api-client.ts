// Server-side API client utility for making requests to the backend API
// This should ONLY be used in API routes and server components

import { cookies } from "next/headers"

/**
 * API Client Configuration
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"

/**
 * The backend API key, read from the server environment at request time.
 *
 * It must never use a `NEXT_PUBLIC_` name or live in a module that client
 * components import (such as lib/config.ts): Next.js inlines those into the
 * browser bundle. This module imports `next/headers`, so it cannot end up in
 * client code.
 *
 * @throws Error if BACKEND_API_KEY is not set
 */
function getBackendApiKey(): string {
  const apiKey = process.env.BACKEND_API_KEY
  if (!apiKey) {
    throw new Error(
      "BACKEND_API_KEY is not set. Set it in the frontend server environment " +
      "(e.g. frontend/.env) to an API key created with backend/scripts/create_api_client.py.",
    )
  }
  return apiKey
}

/**
 * Custom error class for API errors
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: any,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

/**
 * Options for apiFetch function
 */
interface ApiFetchOptions extends RequestInit {
  /** Whether to include the auth token from cookies (server-side only) */
  includeAuth?: boolean
  /** Custom headers to merge with default headers */
  headers?: HeadersInit
}

/**
 * Server-side only fetch wrapper for API calls to backend
 *
 * Features:
 * - Automatically adds API key header
 * - Handles JSON serialization/deserialization
 * - Provides consistent error handling
 * - Supports authentication token
 *
 * @param endpoint - API endpoint (e.g., "/api/v1/auth/login")
 * @param options - Fetch options with additional custom options
 * @returns Parsed JSON response
 * @throws ApiError on HTTP errors
 * @throws Error if called from client-side
 */
export async function apiFetch<T = any>(
  endpoint: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  // Ensure this is only called server-side
  if (typeof window !== "undefined") {
    throw new Error(
      "apiFetch can only be used server-side (API routes/server components). " +
      "In client components, use fetch() to call your Next.js API routes (e.g., /api/auth/login)."
    )
  }

  const { includeAuth = false, headers = {}, ...fetchOptions } = options

  // Build full URL
  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE_URL}${endpoint}`

  // Build headers
  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": getBackendApiKey(),
    ...(headers as Record<string, string>),
  }

  // Add auth token if requested
  if (includeAuth) {
    const cookieStore = await cookies()
    const token = cookieStore.get("auth-token")?.value
    if (token) {
      requestHeaders.Authorization = `Bearer ${token}`
    }
  }

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers: requestHeaders,
    })

    // Parse response body
    let data: any
    const contentType = response.headers.get("content-type")
    if (contentType?.includes("application/json")) {
      data = await response.json()
    } else {
      data = await response.text()
    }

    // Handle HTTP errors
    if (!response.ok) {
      throw new ApiError(
        data?.message || data?.detail || `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        data,
      )
    }

    return data as T
  } catch (error) {
    // Re-throw ApiError as-is
    if (error instanceof ApiError) {
      throw error
    }

    // Wrap other errors
    if (error instanceof Error) {
      throw new ApiError(error.message, 500)
    }

    // Unknown error
    throw new ApiError("An unknown error occurred", 500)
  }
}



