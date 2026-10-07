import crypto from "node:crypto";

// ENZ-1759830000000-9F3A1C — sent to bKash as merchantInvoiceNumber
export const generateInvoiceNumber = (now: Date = new Date()): string =>
	`ENZ-${now.getTime()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
