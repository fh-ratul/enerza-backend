import { ScheduleStatus } from "../../../generated/prisma/enums";

export const MIN_SCHEDULE_MINUTES = 30;
export const MAX_LOAD_SHEDDING_MINUTES = 4 * 60;
export const MAX_MAINTENANCE_MINUTES = 12 * 60;

// A feeder gets at most this much load shedding per Dhaka calendar day.
export const DAILY_SHEDDING_CAP_MINUTES = 240;

// Statuses that occupy a feeder's timeline: nothing else may overlap them.
export const ACTIVE_SCHEDULE_STATUSES = [
	ScheduleStatus.DRAFT,
	ScheduleStatus.PUBLISHED,
] as const;

export const MAX_FEEDERS_PER_SCHEDULE = 20;

// Phases of a PUBLISHED schedule, computed from the clock (never stored).
export const SCHEDULE_PHASES = ["UPCOMING", "ONGOING", "COMPLETED"] as const;

export const SCHEDULE_SORTABLE_FIELDS = [
	"startTime",
	"endTime",
	"createdAt",
	"type",
	"status",
] as const;

// A customer's feeder rarely has more than a handful of future schedules.
export const CUSTOMER_SCHEDULE_LIMIT = 100;
