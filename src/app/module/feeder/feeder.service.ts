import httpStatus from "http-status";
import {
	AuditAction,
	FeederPriority,
	Role,
	ScheduleStatus,
	ScheduleType,
} from "../../../generated/prisma/enums";
import type {
	FeederSelect,
	FeederWhereInput,
} from "../../../generated/prisma/models";
import type { TErrorSource, TMeta } from "../../interfaces";
import { prisma } from "../../lib/prisma";
import type { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import { createAuditLog } from "../../utils/auditLog";
import {
	CACHE_KEYS,
	CACHE_TTL,
	cacheBumpVersion,
	cacheDel,
	cacheGet,
	cacheGetVersion,
	cacheSet,
	hashQuery,
} from "../../utils/cache";
import { lockFeeders } from "../../utils/feederLock";
import { buildMeta, paginationHelper } from "../../utils/paginationHelper";
import { OPEN_OUTAGE_STATUSES } from "../outage/outage.constant";
import {
	FEEDER_SEARCHABLE_FIELDS,
	FEEDER_SORTABLE_FIELDS,
} from "./feeder.constant";
import type {
	ICreateFeederPayload,
	IFeederListQuery,
	IUpdateFeederPayload,
} from "./feeder.interface";

const feederSelect = {
	id: true,
	name: true,
	code: true,
	loadMW: true,
	priority: true,
	isActive: true,
	createdAt: true,
	updatedAt: true,
	substation: {
		select: {
			id: true,
			name: true,
			code: true,
			zone: { select: { id: true, name: true, code: true } },
		},
	},
	areas: {
		where: { isDeleted: false },
		orderBy: { name: "asc" },
		select: { id: true, name: true, code: true },
	},
} satisfies FeederSelect;

// Every feeder write changes what the public list returns.
const invalidateFeederCache = async (feederId?: string) => {
	await cacheBumpVersion(CACHE_KEYS.feedersVersion);

	if (feederId) {
		await cacheDel(CACHE_KEYS.customerSchedules(feederId));
	}
};

// Area codes are unique across the whole grid (including soft-deleted areas).
const assertAreaCodesAreFree = async (areas: { code: string }[]) => {
	if (areas.length === 0) {
		return;
	}

	const taken = await prisma.area.findMany({
		where: { code: { in: areas.map((area) => area.code) } },
		select: { code: true },
	});

	if (taken.length === 0) {
		return;
	}

	const takenCodes = new Set(taken.map((area) => area.code));
	const errors: TErrorSource[] = [];

	areas.forEach((area, index) => {
		if (takenCodes.has(area.code)) {
			errors.push({
				path: `areas.${index}.code`,
				message: `Area code ${area.code} already exists`,
			});
		}
	});

	throw new AppError(
		httpStatus.CONFLICT,
		"One or more area codes already exist",
		errors,
	);
};

const createFeeder = async (
	payload: ICreateFeederPayload,
	actor: RequestUser,
	ip?: string,
) => {
	const { areas, ...feederData } = payload;

	const [substation, isFeederExists] = await Promise.all([
		prisma.substation.findUnique({
			where: { id: feederData.substationId },
			select: { id: true },
		}),
		prisma.feeder.findUnique({
			where: { code: feederData.code },
			select: { id: true },
		}),
	]);

	if (!substation) {
		throw new AppError(httpStatus.NOT_FOUND, "Substation not found", [
			{ path: "substationId", message: "Substation not found" },
		]);
	}

	if (isFeederExists) {
		throw new AppError(
			httpStatus.CONFLICT,
			`Feeder code ${feederData.code} already exists`,
			[{ path: "code", message: "Feeder code already exists" }],
		);
	}

	await assertAreaCodesAreFree(areas);

	const feeder = await prisma.$transaction(async (tx) => {
		const created = await tx.feeder.create({
			data: {
				...feederData,
				areas: { create: areas },
			},
			select: feederSelect,
		});

		await createAuditLog(tx, {
			actor: { userId: actor.userId, role: actor.role },
			action: AuditAction.CREATE,
			entityType: "Feeder",
			entityId: created.id,
			after: created,
			ip,
		});

		return created;
	});

	await invalidateFeederCache();

	return feeder;
};

type TFeederList = {
	data: unknown[];
	meta: TMeta;
};

const getAllFeeders = async (query: IFeederListQuery) => {
	// null when Redis is down: skip the cache entirely and read from the DB.
	const version = await cacheGetVersion(CACHE_KEYS.feedersVersion);
	const cacheKey =
		version === null ? null : CACHE_KEYS.feedersList(version, hashQuery(query));

	if (cacheKey) {
		const cached = await cacheGet<TFeederList>(cacheKey);

		if (cached) {
			return { ...cached, fromCache: true };
		}
	}

	const { page, limit, skip, sortBy, sortOrder } = paginationHelper(
		query,
		FEEDER_SORTABLE_FIELDS,
	);

	const andConditions: FeederWhereInput[] = [{ isDeleted: false }];

	if (query.searchTerm) {
		const contains = {
			contains: query.searchTerm,
			mode: "insensitive" as const,
		};

		// Matches the feeder itself or any of its (non-deleted) areas, so a
		// customer can find their feeder by typing their neighbourhood.
		andConditions.push({
			OR: [
				...FEEDER_SEARCHABLE_FIELDS.map((field) => ({ [field]: contains })),
				{
					areas: {
						some: {
							isDeleted: false,
							OR: FEEDER_SEARCHABLE_FIELDS.map((field) => ({
								[field]: contains,
							})),
						},
					},
				},
			],
		});
	}

	if (query.zoneId) {
		andConditions.push({ substation: { zoneId: query.zoneId } });
	}

	if (query.substationId) {
		andConditions.push({ substationId: query.substationId });
	}

	if (query.priority) {
		andConditions.push({ priority: query.priority });
	}

	if (query.isActive !== undefined) {
		andConditions.push({ isActive: query.isActive });
	}

	const where: FeederWhereInput = { AND: andConditions };

	const [feeders, total] = await prisma.$transaction([
		prisma.feeder.findMany({
			where,
			skip,
			take: limit,
			orderBy: [{ [sortBy]: sortOrder }, { id: "asc" }],
			select: feederSelect,
		}),
		prisma.feeder.count({ where }),
	]);

	const result = {
		data: feeders,
		meta: buildMeta(page, limit, total),
	};

	if (cacheKey) {
		await cacheSet(cacheKey, result, CACHE_TTL.feedersList);
	}

	return { ...result, fromCache: false };
};

const updateFeeder = async (
	feederId: string,
	payload: IUpdateFeederPayload,
	actor: RequestUser,
	ip?: string,
) => {
	const { areas = [], ...changes } = payload;

	await assertAreaCodesAreFree(areas);

	const feeder = await prisma.$transaction(async (tx) => {
		// Serialises this update against schedule creation on the same feeder.
		await lockFeeders(tx, [feederId]);

		const before = await tx.feeder.findFirst({
			where: { id: feederId, isDeleted: false },
			select: feederSelect,
		});

		if (!before) {
			throw new AppError(httpStatus.NOT_FOUND, "Feeder not found");
		}

		// CRITICAL feeders are never load-shed, so a feeder cannot become
		// CRITICAL while load shedding is still planned or running on it.
		if (
			changes.priority === FeederPriority.CRITICAL &&
			before.priority !== FeederPriority.CRITICAL
		) {
			const pendingShedding = await tx.schedule.findFirst({
				where: {
					feederId,
					type: ScheduleType.LOAD_SHEDDING,
					status: { in: [ScheduleStatus.DRAFT, ScheduleStatus.PUBLISHED] },
					endTime: { gt: new Date() },
				},
				select: { id: true },
			});

			if (pendingShedding) {
				throw new AppError(
					httpStatus.CONFLICT,
					"This feeder has upcoming or ongoing load-shedding schedules. Cancel them before marking it CRITICAL",
				);
			}
		}

		const after = await tx.feeder.update({
			where: { id: feederId },
			data: {
				...changes,
				areas: areas.length ? { create: areas } : undefined,
			},
			select: feederSelect,
		});

		await createAuditLog(tx, {
			actor: { userId: actor.userId, role: actor.role },
			action: AuditAction.UPDATE,
			entityType: "Feeder",
			entityId: feederId,
			before,
			after,
			ip,
		});

		return after;
	});

	await invalidateFeederCache(feederId);

	return feeder;
};

const deleteFeeder = async (
	feederId: string,
	actor: RequestUser,
	ip?: string,
) => {
	const result = await prisma.$transaction(async (tx) => {
		// With the row locked, no schedule or outage can be created on this
		// feeder between the guard checks below and the delete itself.
		await lockFeeders(tx, [feederId]);

		const before = await tx.feeder.findFirst({
			where: { id: feederId, isDeleted: false },
			select: feederSelect,
		});

		if (!before) {
			throw new AppError(httpStatus.NOT_FOUND, "Feeder not found");
		}

		const now = new Date();

		const [activeSchedules, openOutages, customers] = await Promise.all([
			tx.schedule.count({
				where: {
					feederId,
					status: ScheduleStatus.PUBLISHED,
					endTime: { gt: now },
				},
			}),
			tx.outage.count({
				where: { feederId, status: { in: [...OPEN_OUTAGE_STATUSES] } },
			}),
			tx.customer.count({
				where: {
					area: { feederId },
					user: { role: Role.CUSTOMER, isDeleted: false },
				},
			}),
		]);

		// Report every blocker at once, so the admin can fix them in one go.
		const blockers: TErrorSource[] = [];

		if (activeSchedules > 0) {
			blockers.push({
				path: "schedules",
				message: `${activeSchedules} upcoming or ongoing published schedule(s) must end or be cancelled first`,
			});
		}

		if (openOutages > 0) {
			blockers.push({
				path: "outages",
				message: "The feeder has an open outage that must be resolved first",
			});
		}

		if (customers > 0) {
			blockers.push({
				path: "customers",
				message: `${customers} customer(s) are connected to this feeder's areas`,
			});
		}

		if (blockers.length) {
			throw new AppError(
				httpStatus.CONFLICT,
				"Feeder cannot be deleted while it is in use",
				blockers,
			);
		}

		// Drafts that were never published would be orphaned: cancel them.
		const cancelledDrafts = await tx.schedule.updateMany({
			where: { feederId, status: ScheduleStatus.DRAFT },
			data: {
				status: ScheduleStatus.CANCELLED,
				cancelReason: "Feeder was deleted",
			},
		});

		const deletedAreas = await tx.area.updateMany({
			where: { feederId, isDeleted: false },
			data: { isDeleted: true, deletedAt: now },
		});

		const deleted = await tx.feeder.update({
			where: { id: feederId },
			data: { isDeleted: true, deletedAt: now, isActive: false },
			select: { id: true, name: true, code: true, deletedAt: true },
		});

		await createAuditLog(tx, {
			actor: { userId: actor.userId, role: actor.role },
			action: AuditAction.SOFT_DELETE,
			entityType: "Feeder",
			entityId: feederId,
			before,
			after: {
				isDeleted: true,
				deletedAt: now,
				deletedAreas: deletedAreas.count,
				cancelledDraftSchedules: cancelledDrafts.count,
			},
			ip,
		});

		return {
			...deleted,
			deletedAreas: deletedAreas.count,
			cancelledDraftSchedules: cancelledDrafts.count,
		};
	});

	await invalidateFeederCache(feederId);

	return result;
};

export const FeederServices = {
	createFeeder,
	getAllFeeders,
	updateFeeder,
	deleteFeeder,
};
