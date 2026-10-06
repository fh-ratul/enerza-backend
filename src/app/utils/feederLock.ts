import type { Prisma } from "../../generated/prisma/client";

// Takes a row lock (SELECT … FOR UPDATE) on each feeder for the rest of the
// transaction. Anything that must be serialised per feeder (schedule conflict
// checks, "one open outage per feeder", soft delete) locks the feeder first,
// so two concurrent requests cannot both pass the same check.
//
// The ids are locked in sorted order: two transactions that need the same
// feeders always acquire them in the same sequence, so they cannot deadlock.
export const lockFeeders = async (
	tx: Prisma.TransactionClient,
	feederIds: string[],
): Promise<void> => {
	const sortedIds = [...new Set(feederIds)].sort();

	for (const feederId of sortedIds) {
		await tx.$queryRaw`SELECT id FROM "feeders" WHERE id = ${feederId} FOR UPDATE`;
	}
};
