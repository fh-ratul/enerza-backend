import httpStatus from "http-status";
import {
	AuditAction,
	OutageStatus,
	ReportStatus,
	Role,
	type ScheduleType,
} from "../../../generated/prisma/enums";
import type {
	OutageReportSelect,
	OutageSelect,
	OutageWhereInput,
} from "../../../generated/prisma/models";
import { prisma } from "../../lib/prisma";
import type { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import { createAuditLog } from "../../utils/auditLog";
import { CACHE_KEYS, cacheDel } from "../../utils/cache";
import {
	LOCKING_TRANSACTION_OPTIONS,
	lockFeeders,
} from "../../utils/feederLock";
import { buildMeta, paginationHelper } from "../../utils/paginationHelper";
import { toDhakaTimeString } from "../../utils/time";
import { phaseWhere } from "../schedule/schedule.utils";
import {
	OPEN_OUTAGE_STATUSES,
	OUTAGE_OUTCOME,
	OUTAGE_SORTABLE_FIELDS,
} from "./outage.constant";
import type {
	ICreateOutagePayload,
	IOutageListQuery,
} from "./outage.interface";
import { computeOutagePriority } from "./outage.utils";

const outageSelect = {
	id: true,
	status: true,
	priority: true,
	description: true,
	reportCount: true,
	startedAt: true,
	assignedAt: true,
	resolvedAt: true,
	durationMinutes: true,
	resolutionNote: true,
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
	technician: {
		select: {
			id: true,
			contactNumber: true,
			user: { select: { id: true, name: true } },
		},
	},
} satisfies OutageSelect;

const reportSelect = {
	id: true,
	status: true,
	description: true,
	createdAt: true,
} satisfies OutageReportSelect;

const SCHEDULE_LABEL: Record<ScheduleType, string> = {
	LOAD_SHEDDING: "Scheduled load shedding",
	MAINTENANCE: "Scheduled maintenance",
};

// Customer intake (Requirements §6.1). A report ends in exactly one of three
// outcomes: explained by a running schedule, linked to the outage that is
// already open on the feeder, or a new outage.
const reportOutage = async (
	payload: ICreateOutagePayload,
	user: RequestUser,
	ip?: string,
) => {
	const { description } = payload;

	if (payload.feederId) {
		throw new AppError(
			httpStatus.BAD_REQUEST,
			"feederId can only be sent by an admin. Your feeder is taken from your profile",
			[{ path: "feederId", message: "Not allowed for customers" }],
		);
	}

	const customer = await prisma.customer.findUnique({
		where: { userId: user.userId },
		select: {
			id: true,
			area: {
				select: {
					id: true,
					isDeleted: true,
					feeder: { select: { id: true, priority: true, isDeleted: true } },
				},
			},
		},
	});

	if (!customer) {
		throw new AppError(httpStatus.NOT_FOUND, "Customer profile not found");
	}

	if (
		!customer.area ||
		customer.area.isDeleted ||
		customer.area.feeder.isDeleted
	) {
		throw new AppError(
			httpStatus.BAD_REQUEST,
			"Set your area in your profile (PATCH /users/me) before reporting an outage",
		);
	}

	const { area } = customer;
	const { feeder } = area;
	const actor = { userId: user.userId, role: user.role };

	const result = await prisma.$transaction(async (tx) => {
		// Every report for this feeder queues up behind this lock. That is what
		// guarantees "one open outage per feeder": two neighbours reporting at
		// the same moment cannot both find "no open outage" and both create one.
		await lockFeeders(tx, [feeder.id]);

		const openReport = await tx.outageReport.findFirst({
			where: { customerId: customer.id, status: ReportStatus.OPEN },
			select: { id: true },
		});

		if (openReport) {
			throw new AppError(
				httpStatus.CONFLICT,
				"You already have an open outage report. It will be closed when the outage is resolved",
			);
		}

		// 1. A published schedule is running right now: the cut is expected.
		const ongoingSchedule = await tx.schedule.findFirst({
			where: { feederId: feeder.id, ...phaseWhere("ONGOING") },
			orderBy: { endTime: "desc" },
			select: {
				id: true,
				type: true,
				startTime: true,
				endTime: true,
				reason: true,
			},
		});

		if (ongoingSchedule) {
			// Asking again during the same schedule gets the same answer
			// without piling up identical rows.
			const earlierReport = await tx.outageReport.findFirst({
				where: {
					customerId: customer.id,
					scheduleId: ongoingSchedule.id,
					status: ReportStatus.EXPLAINED,
				},
				select: reportSelect,
			});

			const report =
				earlierReport ??
				(await tx.outageReport.create({
					data: {
						status: ReportStatus.EXPLAINED,
						description,
						customerId: customer.id,
						areaId: area.id,
						scheduleId: ongoingSchedule.id,
					},
					select: reportSelect,
				}));

			return {
				outcome: OUTAGE_OUTCOME.EXPLAINED_BY_SCHEDULE,
				isNew: !earlierReport,
				explanation: `${SCHEDULE_LABEL[ongoingSchedule.type]} until ${toDhakaTimeString(ongoingSchedule.endTime)}. No outage was opened`,
				report,
				schedule: ongoingSchedule,
			};
		}

		const openOutage = await tx.outage.findFirst({
			where: {
				feederId: feeder.id,
				status: { in: [...OPEN_OUTAGE_STATUSES] },
			},
			select: { id: true, priority: true },
		});

		// 2. The feeder already has an open outage: attach this report to it.
		if (openOutage) {
			// Atomic increment, then the priority is recomputed from the new count.
			const counted = await tx.outage.update({
				where: { id: openOutage.id },
				data: { reportCount: { increment: 1 } },
				select: { reportCount: true },
			});
			const priority = computeOutagePriority(
				feeder.priority,
				counted.reportCount,
			);

			if (priority !== openOutage.priority) {
				await tx.outage.update({
					where: { id: openOutage.id },
					data: { priority },
				});

				await createAuditLog(tx, {
					actor,
					action: AuditAction.UPDATE,
					entityType: "Outage",
					entityId: openOutage.id,
					before: { priority: openOutage.priority },
					after: {
						priority,
						reportCount: counted.reportCount,
						reason: "Escalated by the number of customer reports",
					},
					ip,
				});
			}

			const report = await tx.outageReport.create({
				data: {
					description,
					customerId: customer.id,
					areaId: area.id,
					outageId: openOutage.id,
				},
				select: reportSelect,
			});

			const outage = await tx.outage.findUniqueOrThrow({
				where: { id: openOutage.id },
				select: outageSelect,
			});

			return {
				outcome: OUTAGE_OUTCOME.LINKED_TO_EXISTING_OUTAGE,
				isNew: true,
				explanation:
					"This outage has already been reported. Your report was added to it",
				report,
				outage,
			};
		}

		// 3. Nothing explains the cut yet: open a new outage with this report.
		const created = await tx.outage.create({
			data: {
				priority: computeOutagePriority(feeder.priority, 1),
				description,
				reportCount: 1,
				feederId: feeder.id,
				timeline: {
					create: {
						toStatus: OutageStatus.REPORTED,
						note: description,
						changedById: user.userId,
					},
				},
				reports: {
					create: {
						description,
						customerId: customer.id,
						areaId: area.id,
					},
				},
			},
			select: { ...outageSelect, reports: { select: reportSelect } },
		});
		const { reports, ...outage } = created;

		await createAuditLog(tx, {
			actor,
			action: AuditAction.CREATE,
			entityType: "Outage",
			entityId: outage.id,
			after: {
				status: outage.status,
				priority: outage.priority,
				feederId: feeder.id,
				feederCode: outage.feeder.code,
				source: "CUSTOMER_REPORT",
			},
			ip,
		});

		return {
			outcome: OUTAGE_OUTCOME.NEW_OUTAGE_CREATED,
			isNew: true,
			explanation: "Outage reported. A technician will be assigned shortly",
			report: reports[0],
			outage,
		};
	}, LOCKING_TRANSACTION_OPTIONS);

	// Open-outage counts on the dashboard have changed.
	await cacheDel(CACHE_KEYS.adminStats);

	return result;
};

// An admin (control room) logs an incident directly on a feeder.
const createIncident = async (
	payload: ICreateOutagePayload,
	user: RequestUser,
	ip?: string,
) => {
	const { description, feederId } = payload;

	if (!feederId) {
		throw new AppError(
			httpStatus.BAD_REQUEST,
			"feederId is required to create an outage as an admin",
			[{ path: "feederId", message: "feederId is required" }],
		);
	}

	const outage = await prisma.$transaction(async (tx) => {
		await lockFeeders(tx, [feederId]);

		const feeder = await tx.feeder.findFirst({
			where: { id: feederId, isDeleted: false },
			select: { id: true, code: true, priority: true },
		});

		if (!feeder) {
			throw new AppError(httpStatus.NOT_FOUND, "Feeder not found", [
				{ path: "feederId", message: "Feeder not found" },
			]);
		}

		const openOutage = await tx.outage.findFirst({
			where: { feederId, status: { in: [...OPEN_OUTAGE_STATUSES] } },
			select: { id: true, status: true },
		});

		if (openOutage) {
			throw new AppError(
				httpStatus.CONFLICT,
				`Feeder ${feeder.code} already has an open outage (${openOutage.status})`,
				[{ path: "feederId", message: `Open outage id: ${openOutage.id}` }],
			);
		}

		const created = await tx.outage.create({
			data: {
				priority: computeOutagePriority(feeder.priority, 0),
				description,
				feederId,
				timeline: {
					create: {
						toStatus: OutageStatus.REPORTED,
						note: description,
						changedById: user.userId,
					},
				},
			},
			select: outageSelect,
		});

		await createAuditLog(tx, {
			actor: { userId: user.userId, role: user.role },
			action: AuditAction.CREATE,
			entityType: "Outage",
			entityId: created.id,
			after: {
				status: created.status,
				priority: created.priority,
				feederId,
				feederCode: feeder.code,
				source: "ADMIN_INCIDENT",
			},
			ip,
		});

		return created;
	}, LOCKING_TRANSACTION_OPTIONS);

	await cacheDel(CACHE_KEYS.adminStats);

	return {
		outcome: OUTAGE_OUTCOME.NEW_OUTAGE_CREATED,
		isNew: true,
		explanation: "Outage created successfully",
		outage,
	};
};

const createOutage = async (
	payload: ICreateOutagePayload,
	user: RequestUser,
	ip?: string,
) => {
	if (user.role === Role.CUSTOMER) {
		return reportOutage(payload, user, ip);
	}

	return createIncident(payload, user, ip);
};

// Admin: every outage. Technician: the ones assigned to them. Customer: the
// ones they reported. The filters then narrow that set further.
const getOutages = async (query: IOutageListQuery, user: RequestUser) => {
	const { page, limit, skip, sortBy, sortOrder } = paginationHelper(
		query,
		OUTAGE_SORTABLE_FIELDS,
	);

	const andConditions: OutageWhereInput[] = [];
	const isCustomer = user.role === Role.CUSTOMER;

	if (user.role === Role.TECHNICIAN) {
		andConditions.push({ technician: { userId: user.userId } });
	}

	if (isCustomer) {
		andConditions.push({
			reports: { some: { customer: { userId: user.userId } } },
		});
	}

	if (query.status) {
		andConditions.push({ status: query.status });
	}

	if (query.priority) {
		andConditions.push({ priority: query.priority });
	}

	if (query.feederId) {
		andConditions.push({ feederId: query.feederId });
	}

	if (query.zoneId) {
		andConditions.push({ feeder: { substation: { zoneId: query.zoneId } } });
	}

	if (query.from) {
		andConditions.push({ startedAt: { gte: query.from } });
	}

	if (query.to) {
		andConditions.push({ startedAt: { lt: query.to } });
	}

	const where: OutageWhereInput = { AND: andConditions };

	const [outages, total] = await prisma.$transaction([
		prisma.outage.findMany({
			where,
			skip,
			take: limit,
			orderBy: [{ [sortBy]: sortOrder }, { id: "asc" }],
			select: {
				...outageSelect,
				timeline: {
					orderBy: { createdAt: "asc" },
					select: {
						id: true,
						fromStatus: true,
						toStatus: true,
						note: true,
						createdAt: true,
						// who made each change is staff information
						changedBy: isCustomer
							? false
							: { select: { id: true, name: true, role: true } },
					},
				},
				// a customer also gets their own report on each outage
				reports: isCustomer
					? {
							where: { customer: { userId: user.userId } },
							orderBy: { createdAt: "desc" },
							select: reportSelect,
						}
					: false,
			},
		}),
		prisma.outage.count({ where }),
	]);

	return {
		data: outages,
		meta: buildMeta(page, limit, total),
	};
};

export const OutageServices = {
	createOutage,
	getOutages,
};
