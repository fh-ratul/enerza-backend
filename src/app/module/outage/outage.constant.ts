import {
	FeederPriority,
	OutagePriority,
	OutageStatus,
} from "../../../generated/prisma/enums";

// An outage is "open" until it is RESOLVED or CANCELLED. A feeder has at most
// one open outage at a time.
export const OPEN_OUTAGE_STATUSES = [
	OutageStatus.REPORTED,
	OutageStatus.ASSIGNED,
	OutageStatus.IN_PROGRESS,
] as const;

// An outage starts with a priority that follows its feeder: a fault on a
// hospital feeder is urgent from the first report.
export const FEEDER_TO_OUTAGE_PRIORITY: Record<FeederPriority, OutagePriority> =
	{
		[FeederPriority.CRITICAL]: OutagePriority.URGENT,
		[FeederPriority.HIGH]: OutagePriority.HIGH,
		[FeederPriority.NORMAL]: OutagePriority.MEDIUM,
		[FeederPriority.LOW]: OutagePriority.LOW,
	};

// Lowest to highest: escalation moves one step to the right.
export const OUTAGE_PRIORITY_ORDER = [
	OutagePriority.LOW,
	OutagePriority.MEDIUM,
	OutagePriority.HIGH,
	OutagePriority.URGENT,
] as const;

// Once this many customers have reported the same outage it moves up one
// priority level (never above URGENT).
export const ESCALATION_REPORT_COUNT = 10;

// What happened to a customer's report (Requirements §6.1).
export const OUTAGE_OUTCOME = {
	EXPLAINED_BY_SCHEDULE: "EXPLAINED_BY_SCHEDULE",
	LINKED_TO_EXISTING_OUTAGE: "LINKED_TO_EXISTING_OUTAGE",
	NEW_OUTAGE_CREATED: "NEW_OUTAGE_CREATED",
} as const;
