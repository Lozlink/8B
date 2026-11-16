import "server-only";
import { z } from "zod";

export const uuid = z.string().uuid("Invalid id");
export const pin = z.string().regex(/^\d{4,6}$/, "PIN must be 4–6 digits");
export const reason = z.string().trim().min(3, "A reason is required").max(500);
export const hhmm = z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/, "Use HH:MM");
export const name = z.string().trim().min(1, "Name is required").max(60);
export const role = z.enum(["staff", "manager"]);

export const managerAction = z.object({ managerPin: pin, reason });
