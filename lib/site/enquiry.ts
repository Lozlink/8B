/**
 * The enquiry form's fields and limits (functions and contact pages), shared by the form
 * and the server that checks what arrives (lib/server/enquiries.ts). Pure: no zod, nothing
 * server-only, so the public page doesn't carry the validator.
 */

export const ENQUIRY_LIMITS = {
  name: 80,
  company: 120,
  email: 254,
  phone: 30,
  message: 2000,
  groupSizeMax: 500,
} as const;

/**
 * Which page's form it came from. The contact form asks for less (no company, date or numbers)
 * and needs a message; the functions form's message is optional.
 */
export type EnquiryKind = "functions" | "contact";

/** What the form posts to /api/enquiries. Empty optional fields are sent as "" or null. */
export interface EnquiryInput {
  kind: EnquiryKind;
  name: string;
  company?: string | null;
  email: string;
  phone?: string | null;
  /** "YYYY-MM-DD", or "" / null when they didn't pick one. */
  preferredDate?: string | null;
  /** A whole number, or null when they left it blank. */
  groupSize?: number | null;
  message?: string | null;
  /** Hidden from people. A bot that fills every field fills this one too. */
  website?: string | null;
}
