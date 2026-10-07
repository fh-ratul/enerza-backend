import {
	FeederPriority,
	OutagePriority,
	OutageStatus,
	Role,
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

// The state machine (Requirements §6.3): from → the statuses it may move to.
// ASSIGNED → ASSIGNED and IN_PROGRESS → ASSIGNED are reassignments.
export const OUTAGE_TRANSITIONS: Record<OutageStatus, readonly OutageStatus[]> =
	{
		[OutageStatus.REPORTED]: [OutageStatus.ASSIGNED, OutageStatus.CANCELLED],
		[OutageStatus.ASSIGNED]: [
			OutageStatus.IN_PROGRESS,
			OutageStatus.ASSIGNED,
			OutageStatus.CANCELLED,
		],
		[OutageStatus.IN_PROGRESS]: [OutageStatus.RESOLVED, OutageStatus.ASSIGNED],
		[OutageStatus.RESOLVED]: [],
		[OutageStatus.CANCELLED]: [],
	};

// The statuses an outage can be moved to, and the one role that may do it.
// The admin dispatches and cancels; the assigned technician does the work.
export const TRANSITION_ROLE = {
	[OutageStatus.ASSIGNED]: Role.ADMIN,
	[OutageStatus.CANCELLED]: Role.ADMIN,
	[OutageStatus.IN_PROGRESS]: Role.TECHNICIAN,
	[OutageStatus.RESOLVED]: Role.TECHNICIAN,
} as const;

export const OUTAGE_TARGET_STATUSES = [
	OutageStatus.ASSIGNED,
	OutageStatus.IN_PROGRESS,
	OutageStatus.RESOLVED,
	OutageStatus.CANCELLED,
] as const;

// Moving to these statuses needs a note: what fixed it, or why it was dropped.
export const NOTE_REQUIRED_STATUSES: readonly OutageStatus[] = [
	OutageStatus.RESOLVED,
	OutageStatus.CANCELLED,
];

export const OUTAGE_SORTABLE_FIELDS = [
	"createdAt",
	"startedAt",
	"resolvedAt",
	"priority",
	"status",
	"reportCount",
] as const;
