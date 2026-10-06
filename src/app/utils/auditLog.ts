import type { Prisma } from "../../generated/prisma/client";
import type { AuditAction, Role } from "../../generated/prisma/enums";

export const AUDIT_ENTITY_TYPES = [
	"User",
	"Feeder",
	"Schedule",
	"Outage",
	"Bill",
	"Payment",
] as const;

export type TAuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

type TAuditLogPayload = {
	// null for actions with no logged-in actor (e.g. the bKash callback)
	actor: { userId: string; role: Role } | null;
	action: AuditAction;
	entityType: TAuditEntityType;
	entityId: string;
	before?: unknown;
	after?: unknown;
	ip?: string;
};

// Dates and Decimals become plain JSON values; undefined keys are dropped.
const toJson = (value: unknown): Prisma.InputJsonValue | undefined =>
	value === undefined || value === null
		? undefined
		: (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);

const toAuditRow = ({
	actor,
	action,
	entityType,
	entityId,
	before,
	after,
	ip,
}: TAuditLogPayload) => ({
	action,
	entityType,
	entityId,
	before: toJson(before),
	after: toJson(after),
	actorId: actor?.userId,
	actorRole: actor?.role,
	ipAddress: ip,
});

// Takes the transaction client on purpose: the audit row must commit or roll
// back together with the change it describes.
export const createAuditLog = (
	tx: Prisma.TransactionClient,
	payload: TAuditLogPayload,
) => {
	return tx.auditLog.create({
		data: toAuditRow(payload),
		select: { id: true },
	});
};

// One INSERT for an action that touches several entities at once
// (e.g. one schedule row per feeder).
export const createAuditLogs = (
	tx: Prisma.TransactionClient,
	payloads: TAuditLogPayload[],
) => {
	return tx.auditLog.createMany({
		data: payloads.map(toAuditRow),
	});
};
