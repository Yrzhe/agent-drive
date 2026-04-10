/**
 * EdgeSpark client — singleton for auth + API.
 *
 * Usage:
 *   import { client } from "@/lib/edgespark"
 *
 *   // Auth (Better Auth-compatible API + EdgeSpark additions)
 *   await client.auth.signIn.email({ email, password })
 *   await client.auth.signUp.email({ name, email, password })
 *   const session = await client.auth.requireSession()
 *   await client.auth.signOut()
 *
 *   // Managed auth UI (two modes)
 *   client.authUI.mount(container, { redirectTo: "/dashboard" })
 *   client.authUI.mount(container, { onSuccess: (event) => { ... } })
 *
 *   // API calls (same-origin fetch with cookie credentials)
 *   const res = await client.api.fetch("/api/users")
 *   const users = await res.json()
 *
 * Browser auth guidance:
 * - Use @edgespark/web for all browser auth flows.
 * - Prefer client.authUI.mount() for managed auth UI.
 * - For custom flows, use client.auth directly.
 * - Do not implement app auth by calling /api/_es/auth/* endpoints manually.
 * - Raw auth endpoints are for platform debugging and verification, not normal app code.
 *
 * For full API types, read: node_modules/@edgespark/web/dist/index.d.ts
 */

import { createEdgeSpark } from "@edgespark/web";
import "@edgespark/web/styles.css";

export const client = createEdgeSpark();
