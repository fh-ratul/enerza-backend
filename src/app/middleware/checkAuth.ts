import type { NextFunction, Request, Response } from "express";
import httpStatus from "http-status";
import { type Role, UserStatus } from "../../generated/prisma/enums";
import config from "../config";
import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";
import { catchAsync } from "../utils/catchAsync";
import { jwtUtils } from "../utils/jwt";

export interface RequestUser {
	userId: string;
	email: string;
	name: string;
	role: Role;
}

declare global {
	namespace Express {
		interface Request {
			user?: RequestUser;
		}
	}
}

// auth(Role.ADMIN, Role.TECHNICIAN) → only those roles; auth() → any logged-in user
export const auth = (...requiredRoles: Role[]) => {
	return catchAsync(
		async (req: Request, _res: Response, next: NextFunction) => {
			// Bearer token first, httpOnly cookie as a fallback.
			const header = req.headers.authorization;
			const token = header?.startsWith("Bearer ")
				? header.slice("Bearer ".length).trim()
				: req.cookies?.accessToken;

			if (!token) {
				throw new AppError(
					httpStatus.UNAUTHORIZED,
					"You are not logged in. Please log in to access this resource.",
				);
			}

			const verifiedToken = jwtUtils.verifyToken(
				token,
				config.jwt_access_secret,
			);

			if (!verifiedToken.success) {
				throw new AppError(
					httpStatus.UNAUTHORIZED,
					verifiedToken.isExpired
						? "Access token has expired. Please refresh it or log in again."
						: "Invalid access token. Please log in again.",
				);
			}

			// Look the user up by id only, then check the live account state: the
			// token may be up to a day old, the database row is current.
			const user = await prisma.user.findUnique({
				where: { id: String(verifiedToken.data.userId) },
				select: {
					id: true,
					name: true,
					email: true,
					role: true,
					status: true,
					isDeleted: true,
				},
			});

			if (!user || user.isDeleted) {
				throw new AppError(
					httpStatus.UNAUTHORIZED,
					"User not found. Please log in again.",
				);
			}

			if (user.status === UserStatus.BLOCKED) {
				throw new AppError(
					httpStatus.FORBIDDEN,
					"Your account has been blocked. Please contact support.",
				);
			}

			// The role is read from the database, so a promotion or demotion takes
			// effect immediately instead of when the old token expires.
			if (requiredRoles.length && !requiredRoles.includes(user.role)) {
				throw new AppError(
					httpStatus.FORBIDDEN,
					"Forbidden. You don't have permission to access this resource.",
				);
			}

			req.user = {
				userId: user.id,
				email: user.email,
				name: user.name,
				role: user.role,
			};

			next();
		},
	);
};
