import { OutageStatus } from "../../../generated/prisma/enums";

// An outage is "open" until it is RESOLVED or CANCELLED. A feeder has at most
// one open outage at a time.
export const OPEN_OUTAGE_STATUSES = [
	OutageStatus.REPORTED,
	OutageStatus.ASSIGNED,
	OutageStatus.IN_PROGRESS,
] as const;
