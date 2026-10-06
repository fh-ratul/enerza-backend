import { Prisma } from "../../generated/prisma/client";

// Takes a row lock (SELECT … FOR UPDATE) on each feeder for the rest of the
// transaction. Anything that must be serialised per feeder (schedule conflict
// checks, "one open outage per feeder", soft delete) locks the feeder first,
// so two concurrent requests cannot both pass the same check.
//
// The rows are locked in id order: PostgreSQL sorts first and then locks the
// rows as they come out of the sort. Two transactions that need the same
// feeders therefore always acquire them in the same sequence and cannot
// deadlock on each other.
export const lockFeeders = async (
	tx: Prisma.TransactionClient,
	feederIds: string[],
): Promise<void> => {
	const sortedIds = [...new Set(feederIds)].sort();

	if (sortedIds.length === 0) {
		return;
	}

	await tx.$queryRaw`
		SELECT id FROM "feeders"
		WHERE id IN (${Prisma.join(sortedIds)})
		ORDER BY id
		FOR UPDATE`;
};

// Interactive transactions that take feeder locks may wait on each other, so
// they get more room than Prisma's 5 s default.
export const LOCKING_TRANSACTION_OPTIONS = {
	maxWait: 10_000,
	timeout: 20_000,
} as const;
