import httpStatus from "http-status";
import type { Prisma } from "../../../generated/prisma/client";
import {
	AuditAction,
	FeederPriority,
	Role,
	ScheduleStatus,
	ScheduleType,
} from "../../../generated/prisma/enums";
import type {
	ScheduleSelect,
	ScheduleWhereInput,
} from "../../../generated/prisma/models";
import type { TErrorSource } from "../../interfaces";
import { prisma } from "../../lib/prisma";
import type { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import { createAuditLog, createAuditLogs } from "../../utils/auditLog";
import {
	CACHE_KEYS,
	CACHE_TTL,
	cacheDel,
	cacheGet,
	cacheSet,
} from "../../utils/cache";
import {
	LOCKING_TRANSACTION_OPTIONS,
	lockFeeders,
} from "../../utils/feederLock";
import { buildMeta, paginationHelper } from "../../utils/paginationHelper";
import {
	dhakaDayRange,
	overlapMinutes,
	toDhakaDateString,
} from "../../utils/time";
import {
	ACTIVE_SCHEDULE_STATUSES,
	CUSTOMER_SCHEDULE_LIMIT,
	DAILY_SHEDDING_CAP_MINUTES,
	SCHEDULE_SORTABLE_FIELDS,
} from "./schedule.constant";
import type {
	ICreateSchedulePayload,
	IScheduleListQuery,
	IUpdateScheduleStatusPayload,
} from "./schedule.interface";
import { formatWindow, phaseWhere, withPhase } from "./schedule.utils";

const scheduleSelect = {
	id: true,
	type: true,
	status: true,
	startTime: true,
	endTime: true,
	reason: true,
	batchId: true,
	cancelReason: true,
	createdAt: true,
	updatedAt: true,
	feeder: {
		select: {
			id: true,
			name: true,
			code: true,
			priority: true,
			substation: {
				select: {
					id: true,
					name: true,
					zone: { select: { id: true, name: true, code: true } },
				},
			},
		},
	},
	createdBy: { select: { id: true, name: true } },
} satisfies ScheduleSelect;

type TFeederForSchedule = {
	id: string;
	code: string;
	priority: FeederPriority;
	isActive: boolean;
};

type TConflictCheck = {
	feeders: Pick<TFeederForSchedule, "id" | "code">[];
	type: ScheduleType;
	startTime: Date;
	endTime: Date;
	// when re-checking an existing schedule (publish), ignore the schedule itself
	excludeScheduleId?: string;
	pathFor: (feederId: string) => string;
};

const TYPE_LABEL: Record<ScheduleType, string> = {
	LOAD_SHEDDING: "load-shedding",
	MAINTENANCE: "maintenance",
};

// CRITICAL feeders (hospitals, water pumps) are never load-shed; they can
// only get MAINTENANCE schedules.
const getFeederRuleErrors = (
	type: ScheduleType,
	feeders: TFeederForSchedule[],
	pathFor: (feederId: string) => string,
) => {
	if (type !== ScheduleType.LOAD_SHEDDING) {
		return { critical: [], inactive: [] };
	}

	const critical: TErrorSource[] = [];
	const inactive: TErrorSource[] = [];

	for (const feeder of feeders) {
		if (feeder.priority === FeederPriority.CRITICAL) {
			critical.push({
				path: pathFor(feeder.id),
				message: `Feeder ${feeder.code} is CRITICAL and can never be load-shed`,
			});
		} else if (!feeder.isActive) {
			inactive.push({
				path: pathFor(feeder.id),
				message: `Feeder ${feeder.code} is inactive`,
			});
		}
	}

	return { critical, inactive };
};

// Overlap and daily-cap checks for a window on a set of feeders.
// MUST run inside a transaction that already holds the feeder row locks:
// that is what stops two concurrent requests from both passing these checks.
const findScheduleConflicts = async (
	tx: Prisma.TransactionClient,
	{
		feeders,
		type,
		startTime,
		endTime,
		excludeScheduleId,
		pathFor,
	}: TConflictCheck,
): Promise<TErrorSource[]> => {
	const feederIds = feeders.map((feeder) => feeder.id);
	const excludeSelf = excludeScheduleId
		? { id: { not: excludeScheduleId } }
		: {};
	const errors: TErrorSource[] = [];
	const clashedFeederIds = new Set<string>();

	// 1. Overlap: a.start < b.end AND a.end > b.start, against DRAFT/PUBLISHED rows.
	const clashes = await tx.schedule.findMany({
		where: {
			feederId: { in: feederIds },
			status: { in: [...ACTIVE_SCHEDULE_STATUSES] },
			startTime: { lt: endTime },
			endTime: { gt: startTime },
			...excludeSelf,
		},
		orderBy: { startTime: "asc" },
		select: {
			feederId: true,
			type: true,
			status: true,
			startTime: true,
			endTime: true,
		},
	});

	for (const feeder of feeders) {
		const clash = clashes.find((schedule) => schedule.feederId === feeder.id);

		if (clash) {
			clashedFeederIds.add(feeder.id);
			errors.push({
				path: pathFor(feeder.id),
				message: `Feeder ${feeder.code} already has a ${clash.status} ${TYPE_LABEL[clash.type]} schedule at ${formatWindow(clash.startTime, clash.endTime)}`,
			});
		}
	}

	if (type !== ScheduleType.LOAD_SHEDDING) {
		return errors;
	}

	// 2. Daily cap: load-shedding minutes per Dhaka calendar day. A window that
	//    crosses midnight is split between the two days it touches.
	const days = new Set([
		toDhakaDateString(startTime),
		toDhakaDateString(new Date(endTime.getTime() - 1)),
	]);

	for (const day of days) {
		const range = dhakaDayRange(day);
		const newMinutes = overlapMinutes(
			startTime,
			endTime,
			range.start,
			range.end,
		);

		const sameDay = await tx.schedule.findMany({
			where: {
				feederId: { in: feederIds },
				type: ScheduleType.LOAD_SHEDDING,
				status: { in: [...ACTIVE_SCHEDULE_STATUSES] },
				startTime: { lt: range.end },
				endTime: { gt: range.start },
				...excludeSelf,
			},
			select: { feederId: true, startTime: true, endTime: true },
		});

		for (const feeder of feeders) {
			if (clashedFeederIds.has(feeder.id)) {
				continue;
			}

			const usedMinutes = sameDay
				.filter((schedule) => schedule.feederId === feeder.id)
				.reduce(
					(total, schedule) =>
						total +
						overlapMinutes(
							schedule.startTime,
							schedule.endTime,
							range.start,
							range.end,
						),
					0,
				);

			if (usedMinutes + newMinutes > DAILY_SHEDDING_CAP_MINUTES) {
				errors.push({
					path: pathFor(feeder.id),
					message: `Feeder ${feeder.code} already has ${usedMinutes} of its ${DAILY_SHEDDING_CAP_MINUTES} daily load-shedding minutes on ${day}; ${newMinutes} more would exceed the cap`,
				});
			}
		}
	}

	return errors;
};

const invalidateCustomerSchedules = (feederIds: string[]) =>
	cacheDel(
		...feederIds.map((feederId) => CACHE_KEYS.customerSchedules(feederId)),
	);

const createSchedules = async (
	payload: ICreateSchedulePayload,
	actor: RequestUser,
	ip?: string,
) => {
	const { type, feederIds, startTime, endTime, reason } = payload;
	const pathFor = (feederId: string) =>
		`feederIds.${feederIds.indexOf(feederId)}`;

	const schedules = await prisma.$transaction(async (tx) => {
		// From here until commit, no other request can add or publish a
		// schedule on these feeders.
		await lockFeeders(tx, feederIds);

		const feeders = await tx.feeder.findMany({
			where: { id: { in: feederIds }, isDeleted: false },
			select: { id: true, code: true, priority: true, isActive: true },
		});
		const foundIds = new Set(feeders.map((feeder) => feeder.id));
		const missingIds = feederIds.filter((feederId) => !foundIds.has(feederId));

		if (missingIds.length) {
			throw new AppError(
				httpStatus.NOT_FOUND,
				"One or more feeders were not found",
				missingIds.map((feederId) => ({
					path: pathFor(feederId),
					message: "Feeder not found",
				})),
			);
		}

		const ruleErrors = getFeederRuleErrors(type, feeders, pathFor);

		if (ruleErrors.critical.length) {
			throw new AppError(
				httpStatus.BAD_REQUEST,
				"CRITICAL feeders can only get MAINTENANCE schedules",
				ruleErrors.critical,
			);
		}

		if (ruleErrors.inactive.length) {
			throw new AppError(
				httpStatus.CONFLICT,
				"Inactive feeders cannot be load-shed",
				ruleErrors.inactive,
			);
		}

		const conflicts = await findScheduleConflicts(tx, {
			feeders,
			type,
			startTime,
			endTime,
			pathFor,
		});

		if (conflicts.length) {
			throw new AppError(
				httpStatus.CONFLICT,
				"The schedule conflicts with existing schedules",
				conflicts,
			);
		}

		const createdIds = await tx.schedule.createManyAndReturn({
			data: feederIds.map((feederId) => ({
				type,
				startTime,
				endTime,
				reason,
				feederId,
				createdById: actor.userId,
			})),
			select: { id: true },
		});

		const created = await tx.schedule.findMany({
			where: { id: { in: createdIds.map((schedule) => schedule.id) } },
			orderBy: { feeder: { code: "asc" } },
			select: scheduleSelect,
		});

		await createAuditLogs(
			tx,
			created.map((schedule) => ({
				actor: { userId: actor.userId, role: actor.role },
				action: AuditAction.CREATE,
				entityType: "Schedule" as const,
				entityId: schedule.id,
				after: {
					type: schedule.type,
					status: schedule.status,
					startTime: schedule.startTime,
					endTime: schedule.endTime,
					feederId: schedule.feeder.id,
					feederCode: schedule.feeder.code,
				},
				ip,
			})),
		);

		return created;
	}, LOCKING_TRANSACTION_OPTIONS);

	await invalidateCustomerSchedules(feederIds);

	return schedules.map((schedule) => withPhase(schedule));
};

// What a customer sees: no drafts, no internal fields.
const customerScheduleSelect = {
	id: true,
	type: true,
	status: true,
	startTime: true,
	endTime: true,
	reason: true,
	feeder: { select: { id: true, name: true, code: true } },
} satisfies ScheduleSelect;

type TCustomerSchedule = {
	id: string;
	type: ScheduleType;
	status: ScheduleStatus;
	// ISO strings when the row comes back from the JSON cache
	startTime: Date | string;
	endTime: Date | string;
	reason: string | null;
	feeder: { id: string; name: string; code: string };
};

// Customers only ever see the published, not-yet-finished schedules of the
// feeder that serves their own area.
const getCustomerSchedules = async (
	query: IScheduleListQuery,
	user: RequestUser,
) => {
	const customer = await prisma.customer.findUnique({
		where: { userId: user.userId },
		select: {
			area: { select: { feederId: true, isDeleted: true } },
		},
	});

	if (!customer?.area || customer.area.isDeleted) {
		throw new AppError(
			httpStatus.BAD_REQUEST,
			"Set your area in your profile (PATCH /users/me) to see your schedule",
		);
	}

	const { feederId } = customer.area;
	const cacheKey = CACHE_KEYS.customerSchedules(feederId);
	const now = new Date();

	let schedules = await cacheGet<TCustomerSchedule[]>(cacheKey);
	const fromCache = schedules !== null;

	if (!schedules) {
		schedules = await prisma.schedule.findMany({
			where: {
				feederId,
				status: ScheduleStatus.PUBLISHED,
				endTime: { gt: now },
			},
			orderBy: { startTime: "asc" },
			take: CUSTOMER_SCHEDULE_LIMIT,
			select: customerScheduleSelect,
		});

		await cacheSet(cacheKey, schedules, CACHE_TTL.customerSchedules);
	}

	// Only the rows are cached. The phase is worked out now, and anything that
	// ended while it sat in the cache is dropped, so a cached response can
	// never claim that a finished schedule is still ONGOING.
	const live = schedules
		.filter((schedule) => new Date(schedule.endTime) > now)
		.map((schedule) => withPhase(schedule, now));

	const { page, limit, skip } = paginationHelper(
		query,
		SCHEDULE_SORTABLE_FIELDS,
	);

	return {
		data: live.slice(skip, skip + limit),
		meta: buildMeta(page, limit, live.length),
		fromCache,
	};
};

const getAllSchedules = async (query: IScheduleListQuery) => {
	const { page, limit, skip, sortBy, sortOrder } = paginationHelper(
		query,
		SCHEDULE_SORTABLE_FIELDS,
		"startTime",
	);
	const now = new Date();

	const andConditions: ScheduleWhereInput[] = [];

	if (query.type) {
		andConditions.push({ type: query.type });
	}

	if (query.status) {
		andConditions.push({ status: query.status });
	}

	// UPCOMING / ONGOING / COMPLETED are not columns: they translate into a
	// status + time-range filter.
	if (query.phase) {
		andConditions.push(phaseWhere(query.phase, now));
	}

	if (query.feederId) {
		andConditions.push({ feederId: query.feederId });
	}

	if (query.zoneId) {
		andConditions.push({ feeder: { substation: { zoneId: query.zoneId } } });
	}

	// Schedules that overlap the requested range.
	if (query.from) {
		andConditions.push({ endTime: { gt: query.from } });
	}

	if (query.to) {
		andConditions.push({ startTime: { lt: query.to } });
	}

	const where: ScheduleWhereInput = { AND: andConditions };

	const [schedules, total] = await prisma.$transaction([
		prisma.schedule.findMany({
			where,
			skip,
			take: limit,
			orderBy: [{ [sortBy]: sortOrder }, { id: "asc" }],
			select: scheduleSelect,
		}),
		prisma.schedule.count({ where }),
	]);

	return {
		data: schedules.map((schedule) => withPhase(schedule, now)),
		meta: buildMeta(page, limit, total),
		fromCache: false,
	};
};

const getSchedules = async (query: IScheduleListQuery, user: RequestUser) => {
	if (user.role === Role.CUSTOMER) {
		return getCustomerSchedules(query, user);
	}

	return getAllSchedules(query);
};

const updateScheduleStatus = async (
	scheduleId: string,
	payload: IUpdateScheduleStatusPayload,
	actor: RequestUser,
	ip?: string,
) => {
	const { status, reason } = payload;

	// Only needed to know which feeder to lock; everything else is re-read
	// under the lock.
	const existing = await prisma.schedule.findUnique({
		where: { id: scheduleId },
		select: { feederId: true },
	});

	if (!existing) {
		throw new AppError(httpStatus.NOT_FOUND, "Schedule not found");
	}

	const updated = await prisma.$transaction(async (tx) => {
		await lockFeeders(tx, [existing.feederId]);

		const schedule = await tx.schedule.findUniqueOrThrow({
			where: { id: scheduleId },
			select: {
				type: true,
				status: true,
				startTime: true,
				endTime: true,
				feeder: {
					select: {
						id: true,
						code: true,
						priority: true,
						isActive: true,
						isDeleted: true,
					},
				},
			},
		});
		const now = new Date();

		if (schedule.status === ScheduleStatus.CANCELLED) {
			throw new AppError(
				httpStatus.CONFLICT,
				"A cancelled schedule cannot be changed",
			);
		}

		if (schedule.status === status) {
			throw new AppError(httpStatus.CONFLICT, `Schedule is already ${status}`);
		}

		if (status === ScheduleStatus.PUBLISHED) {
			// DRAFT → PUBLISHED. Everything that was true when the draft was
			// created is checked again, because it may have changed since.
			if (schedule.startTime <= now) {
				throw new AppError(
					httpStatus.CONFLICT,
					"This draft's start time has already passed, so it can no longer be published",
				);
			}

			if (schedule.feeder.isDeleted) {
				throw new AppError(
					httpStatus.CONFLICT,
					"The feeder of this schedule has been deleted",
				);
			}

			const pathFor = () => "status";
			const ruleErrors = getFeederRuleErrors(
				schedule.type,
				[schedule.feeder],
				pathFor,
			);

			if (ruleErrors.critical.length) {
				throw new AppError(
					httpStatus.BAD_REQUEST,
					"CRITICAL feeders can only get MAINTENANCE schedules",
					ruleErrors.critical,
				);
			}

			if (ruleErrors.inactive.length) {
				throw new AppError(
					httpStatus.CONFLICT,
					"Inactive feeders cannot be load-shed",
					ruleErrors.inactive,
				);
			}

			const conflicts = await findScheduleConflicts(tx, {
				feeders: [schedule.feeder],
				type: schedule.type,
				startTime: schedule.startTime,
				endTime: schedule.endTime,
				excludeScheduleId: scheduleId,
				pathFor,
			});

			if (conflicts.length) {
				throw new AppError(
					httpStatus.CONFLICT,
					"The schedule conflicts with existing schedules",
					conflicts,
				);
			}
		} else if (schedule.status === ScheduleStatus.PUBLISHED) {
			// PUBLISHED → CANCELLED: customers have already seen it, so it needs
			// a reason, and it only makes sense while the schedule has not ended.
			if (schedule.endTime <= now) {
				throw new AppError(
					httpStatus.CONFLICT,
					"A completed schedule cannot be cancelled",
				);
			}

			if (!reason) {
				throw new AppError(
					httpStatus.BAD_REQUEST,
					"A reason is required to cancel a published schedule",
					[{ path: "reason", message: "reason is required" }],
				);
			}
		}

		// Conditional on the status we just read: if another request changed
		// the row in between, nothing is updated and we report a conflict.
		const { count } = await tx.schedule.updateMany({
			where: { id: scheduleId, status: schedule.status },
			data: {
				status,
				cancelReason: status === ScheduleStatus.CANCELLED ? reason : undefined,
			},
		});

		if (count === 0) {
			throw new AppError(
				httpStatus.CONFLICT,
				"The schedule was changed by another request. Please try again",
			);
		}

		await createAuditLog(tx, {
			actor: { userId: actor.userId, role: actor.role },
			action: AuditAction.STATUS_CHANGE,
			entityType: "Schedule",
			entityId: scheduleId,
			before: { status: schedule.status },
			after: {
				status,
				cancelReason: status === ScheduleStatus.CANCELLED ? reason : undefined,
				feederCode: schedule.feeder.code,
			},
			ip,
		});

		return tx.schedule.findUniqueOrThrow({
			where: { id: scheduleId },
			select: scheduleSelect,
		});
	}, LOCKING_TRANSACTION_OPTIONS);

	// Publishing or cancelling changes what customers on this feeder see.
	await invalidateCustomerSchedules([existing.feederId]);

	return withPhase(updated);
};

export const ScheduleServices = {
	createSchedules,
	getSchedules,
	updateScheduleStatus,
};
