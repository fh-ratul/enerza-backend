import httpStatus from "http-status";
import { ReportStatus, Role } from "../../../generated/prisma/enums";
import type { TErrorSource } from "../../interfaces";
import { prisma } from "../../lib/prisma";
import type { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import type { IUpdateMyProfilePayload } from "./user.interface";

const CUSTOMER_ONLY_FIELDS = ["address", "areaId", "meterNumber"] as const;

const getMyProfile = async (user: RequestUser) => {
	const profile = await prisma.user.findFirst({
		where: { id: user.userId, isDeleted: false },
		select: {
			id: true,
			name: true,
			email: true,
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
) => {
	const { name, contactNumber, address, areaId, meterNumber, isAvailable } =
		payload;

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

	// Prisma skips `undefined` values, so only the fields that were sent change.
	await prisma.$transaction(async (tx) => {
		if (name !== undefined) {
			await tx.user.update({
				where: { id: user.userId },
				data: { name },
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
	});

	return getMyProfile(user);
};

export const UserServices = {
	getMyProfile,
	updateMyProfile,
};
