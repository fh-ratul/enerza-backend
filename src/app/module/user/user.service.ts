import httpStatus from "http-status";
import {
	AuditAction,
	BillStatus,
	ReportStatus,
	Role,
} from "../../../generated/prisma/enums";
import type { UserWhereInput } from "../../../generated/prisma/models";
import type { TErrorSource } from "../../interfaces";
import { deleteImage, uploadImage } from "../../lib/cloudinary";
import { prisma } from "../../lib/prisma";
import type { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import { createAuditLog } from "../../utils/auditLog";
import { buildMeta, paginationHelper } from "../../utils/paginationHelper";
import { USER_SEARCHABLE_FIELDS, USER_SORTABLE_FIELDS } from "./user.constant";
import type {
	IUpdateMyProfilePayload,
	IUpdateUserPayload,
	IUserListQuery,
} from "./user.interface";

const CUSTOMER_ONLY_FIELDS = ["address", "areaId", "meterNumber"] as const;

// What an admin sees for a user: never the password hash.
const adminUserSelect = {
	id: true,
	name: true,
	email: true,
	profilePhoto: true,
	role: true,
	status: true,
	authProvider: true,
	createdAt: true,
	updatedAt: true,
	customer: {
		select: {
			id: true,
			meterNumber: true,
			contactNumber: true,
			connectionType: true,
			area: { select: { id: true, name: true, code: true } },
		},
	},
	technician: {
		select: {
			id: true,
			contactNumber: true,
			isAvailable: true,
			activeJobCount: true,
			maxActiveJobs: true,
			zone: { select: { id: true, name: true, code: true } },
		},
	},
} as const;

const getMyProfile = async (user: RequestUser) => {
	const profile = await prisma.user.findFirst({
		where: { id: user.userId, isDeleted: false },
		select: {
			id: true,
			name: true,
			email: true,
			profilePhoto: true,
			role: true,
			status: true,
			authProvider: true,
			createdAt: true,
			updatedAt: true,
			customer: {
				select: {
					id: true,
					contactNumber: true,
					address: true,
					meterNumber: true,
					connectionType: true,
					sanctionedLoadKW: true,
					lastReading: true,
					// area → feeder → substation → zone: where the customer sits on the grid
					area: {
						select: {
							id: true,
							name: true,
							code: true,
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
											code: true,
											zone: { select: { id: true, name: true, code: true } },
										},
									},
								},
							},
						},
					},
				},
			},
			technician: {
				select: {
					id: true,
					contactNumber: true,
					isAvailable: true,
					activeJobCount: true,
					maxActiveJobs: true,
					lastAssignedAt: true,
					zone: { select: { id: true, name: true, code: true } },
				},
			},
		},
	});

	if (!profile) {
		throw new AppError(httpStatus.NOT_FOUND, "User not found");
	}

	const { customer, technician, ...account } = profile;

	// Only the profile that belongs to the role is returned.
	if (account.role === Role.CUSTOMER) {
		return {
			...account,
			customer: customer && {
				...customer,
				// A Google sign-up starts without an area or a meter number.
				isProfileComplete: Boolean(customer.area && customer.meterNumber),
			},
		};
	}

	if (account.role === Role.TECHNICIAN) {
		return { ...account, technician };
	}

	return account;
};

const updateMyProfile = async (
	user: RequestUser,
	payload: IUpdateMyProfilePayload,
	photo?: Express.Multer.File,
) => {
	const { name, contactNumber, address, areaId, meterNumber, isAvailable } =
		payload;

	if (Object.keys(payload).length === 0 && !photo) {
		throw new AppError(
			httpStatus.BAD_REQUEST,
			"Provide at least one field to update",
		);
	}

	// Reject fields that do not belong to the caller's role, naming each one.
	const errors: TErrorSource[] = [];

	if (user.role !== Role.CUSTOMER) {
		for (const field of CUSTOMER_ONLY_FIELDS) {
			if (payload[field] !== undefined) {
				errors.push({
					path: field,
					message: `${field} can only be updated by customers`,
				});
			}
		}
	}

	if (user.role !== Role.TECHNICIAN && isAvailable !== undefined) {
		errors.push({
			path: "isAvailable",
			message: "isAvailable can only be updated by technicians",
		});
	}

	if (user.role === Role.ADMIN && contactNumber !== undefined) {
		errors.push({
			path: "contactNumber",
			message: "contactNumber can only be updated by customers and technicians",
		});
	}

	if (errors.length) {
		throw new AppError(
			httpStatus.BAD_REQUEST,
			"Some fields cannot be updated by your role",
			errors,
		);
	}

	if (user.role === Role.CUSTOMER) {
		const customer = await prisma.customer.findUnique({
			where: { userId: user.userId },
			select: {
				id: true,
				areaId: true,
				meterNumber: true,
				_count: { select: { bills: true } },
			},
		});

		if (!customer) {
			throw new AppError(httpStatus.NOT_FOUND, "Customer profile not found");
		}

		if (areaId && areaId !== customer.areaId) {
			const [area, openReport] = await Promise.all([
				prisma.area.findFirst({
					where: { id: areaId, isDeleted: false, feeder: { isDeleted: false } },
					select: { id: true },
				}),
				prisma.outageReport.findFirst({
					where: { customerId: customer.id, status: ReportStatus.OPEN },
					select: { id: true },
				}),
			]);

			if (!area) {
				throw new AppError(httpStatus.NOT_FOUND, "Area not found", [
					{ path: "areaId", message: "Area not found" },
				]);
			}

			// An open report is tied to the area it was filed from.
			if (openReport) {
				throw new AppError(
					httpStatus.CONFLICT,
					"You cannot change your area while you have an open outage report",
				);
			}
		}

		if (meterNumber && meterNumber !== customer.meterNumber) {
			// Bills carry readings from one physical meter, so the number is
			// frozen once billing has started.
			if (customer.meterNumber && customer._count.bills > 0) {
				throw new AppError(
					httpStatus.CONFLICT,
					"Meter number cannot be changed after a bill has been issued",
				);
			}

			const isMeterExists = await prisma.customer.findUnique({
				where: { meterNumber },
				select: { id: true },
			});

			if (isMeterExists) {
				throw new AppError(
					httpStatus.CONFLICT,
					"This meter number is already registered",
					[
						{
							path: "meterNumber",
							message: "Meter number is already registered",
						},
					],
				);
			}
		}
	}

	// The upload is a network call, so it happens before the transaction and
	// only once everything else about the request has been accepted.
	const uploaded = photo && (await uploadImage(photo.buffer, "profiles"));
	let previousPhotoPublicId: string | null;

	try {
		// Prisma skips `undefined` values, so only the fields that were sent change.
		previousPhotoPublicId = await prisma.$transaction(async (tx) => {
			const previous = await tx.user.findUniqueOrThrow({
				where: { id: user.userId },
				select: { profilePhotoPublicId: true },
			});

			if (name !== undefined || uploaded) {
				await tx.user.update({
					where: { id: user.userId },
					data: {
						name,
						profilePhoto: uploaded?.url,
						profilePhotoPublicId: uploaded?.publicId,
					},
				});
			}

			if (user.role === Role.CUSTOMER) {
				await tx.customer.update({
					where: { userId: user.userId },
					data: { contactNumber, address, areaId, meterNumber },
				});
			}

			if (user.role === Role.TECHNICIAN) {
				await tx.technician.update({
					where: { userId: user.userId },
					data: { contactNumber, isAvailable },
				});
			}

			return previous.profilePhotoPublicId;
		});
	} catch (error) {
		// The profile was not saved, so the new image would be an orphan.
		if (uploaded) {
			await deleteImage(uploaded.publicId);
		}

		throw error;
	}

	// The replaced image is of no use any more.
	if (uploaded && previousPhotoPublicId) {
		await deleteImage(previousPhotoPublicId);
	}

	return getMyProfile(user);
};

const getAllUsers = async (query: IUserListQuery) => {
	const { page, limit, skip, sortBy, sortOrder } = paginationHelper(
		query,
		USER_SORTABLE_FIELDS,
	);

	const andConditions: UserWhereInput[] = [{ isDeleted: false }];

	if (query.searchTerm) {
		andConditions.push({
			OR: [
				...USER_SEARCHABLE_FIELDS.map((field) => ({
					[field]: { contains: query.searchTerm, mode: "insensitive" as const },
				})),
				{
					customer: {
						meterNumber: { contains: query.searchTerm, mode: "insensitive" },
					},
				},
			],
		});
	}

	if (query.role) {
		andConditions.push({ role: query.role });
	}

	if (query.status) {
		andConditions.push({ status: query.status });
	}

	const where: UserWhereInput = { AND: andConditions };

	const [users, total] = await prisma.$transaction([
		prisma.user.findMany({
			where,
			skip,
			take: limit,
			// `id` as a tie-breaker keeps pages stable when the sort key repeats
			orderBy: [{ [sortBy]: sortOrder }, { id: "asc" }],
			select: adminUserSelect,
		}),
		prisma.user.count({ where }),
	]);

	return {
		data: users,
		meta: buildMeta(page, limit, total),
	};
};

const updateUser = async (
	userId: string,
	payload: IUpdateUserPayload,
	actor: RequestUser,
	ip?: string,
) => {
	if (userId === actor.userId) {
		throw new AppError(
			httpStatus.FORBIDDEN,
			"You cannot change your own status or role",
		);
	}

	const target = await prisma.user.findFirst({
		where: { id: userId, isDeleted: false },
		select: {
			id: true,
			role: true,
			status: true,
			password: true,
			customer: { select: { id: true } },
		},
	});

	if (!target) {
		throw new AppError(httpStatus.NOT_FOUND, "User not found");
	}

	const { status, role, zoneId } = payload;

	if (status && status === target.status) {
		throw new AppError(httpStatus.CONFLICT, `User is already ${status}`);
	}

	if (role && zoneId) {
		if (target.role !== Role.CUSTOMER) {
			throw new AppError(
				httpStatus.CONFLICT,
				target.role === Role.TECHNICIAN
					? "User is already a technician"
					: "Only customers can be promoted to technician",
			);
		}

		// Technicians sign in with email and password; Google login is for
		// customers only, so a Google-only account would be locked out.
		if (!target.password) {
			throw new AppError(
				httpStatus.CONFLICT,
				"This account signs in with Google and has no password, so it cannot be promoted",
			);
		}

		const [zone, unpaidBill, openReport] = await Promise.all([
			prisma.distributionZone.findUnique({
				where: { id: zoneId },
				select: { id: true },
			}),
			prisma.bill.findFirst({
				where: { customerId: target.customer?.id, status: BillStatus.UNPAID },
				select: { id: true },
			}),
			prisma.outageReport.findFirst({
				where: { customerId: target.customer?.id, status: ReportStatus.OPEN },
				select: { id: true },
			}),
		]);

		if (!zone) {
			throw new AppError(httpStatus.NOT_FOUND, "Distribution zone not found", [
				{ path: "zoneId", message: "Distribution zone not found" },
			]);
		}

		// After promotion the account loses its customer access, so it must
		// not leave an unpaid bill or an open report behind.
		if (target.customer && (unpaidBill || openReport)) {
			throw new AppError(
				httpStatus.CONFLICT,
				unpaidBill
					? "This customer has an unpaid bill and cannot be promoted yet"
					: "This customer has an open outage report and cannot be promoted yet",
			);
		}
	}

	const actorInfo = { userId: actor.userId, role: actor.role };

	return prisma.$transaction(async (tx) => {
		if (status) {
			await tx.user.update({
				where: { id: target.id },
				data: { status },
			});

			await createAuditLog(tx, {
				actor: actorInfo,
				action: AuditAction.STATUS_CHANGE,
				entityType: "User",
				entityId: target.id,
				before: { status: target.status },
				after: { status },
				ip,
			});
		}

		if (role && zoneId) {
			await tx.user.update({
				where: { id: target.id },
				data: { role },
			});

			// A concurrent promotion hits the unique userId and surfaces as a 409.
			await tx.technician.create({
				data: { userId: target.id, zoneId },
			});

			await createAuditLog(tx, {
				actor: actorInfo,
				action: AuditAction.ROLE_CHANGE,
				entityType: "User",
				entityId: target.id,
				before: { role: target.role },
				after: { role, zoneId },
				ip,
			});
		}

		return tx.user.findUniqueOrThrow({
			where: { id: target.id },
			select: adminUserSelect,
		});
	});
};

export const UserServices = {
	getMyProfile,
	updateMyProfile,
	getAllUsers,
	updateUser,
};
