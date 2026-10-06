import bcrypt from "bcryptjs";
import type { TokenPayload } from "google-auth-library";
import httpStatus from "http-status";
import {
	AuthProvider,
	Role,
	UserStatus,
} from "../../../generated/prisma/enums";
import config from "../../config";
import { googleClient } from "../../lib/googleAuth";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../utils/AppError";
import { jwtUtils, type TTokenPayload } from "../../utils/jwt";
import type {
	IGoogleLoginPayload,
	ILoginPayload,
	IRegisterPayload,
} from "./auth.interface";

// Never select the password hash for anything that is sent back to a client.
const safeUserSelect = {
	id: true,
	name: true,
	email: true,
	role: true,
	status: true,
	authProvider: true,
	createdAt: true,
} as const;

const createTokens = (user: { id: string; email: string; role: Role }) => {
	const jwtPayload: TTokenPayload = {
		userId: user.id,
		email: user.email,
		role: user.role,
	};

	return {
		accessToken: jwtUtils.createAccessToken(jwtPayload),
		refreshToken: jwtUtils.createRefreshToken(jwtPayload),
	};
};

const register = async (payload: IRegisterPayload) => {
	const { name, email, password, ...profile } = payload;

	const [isUserExists, area, isMeterExists] = await Promise.all([
		prisma.user.findUnique({ where: { email }, select: { id: true } }),
		prisma.area.findFirst({
			where: {
				id: profile.areaId,
				isDeleted: false,
				feeder: { isDeleted: false },
			},
			select: { id: true },
		}),
		prisma.customer.findUnique({
			where: { meterNumber: profile.meterNumber },
			select: { id: true },
		}),
	]);

	if (isUserExists) {
		throw new AppError(
			httpStatus.CONFLICT,
			"User with this email already exists",
			[{ path: "email", message: "Email is already registered" }],
		);
	}

	if (!area) {
		throw new AppError(httpStatus.NOT_FOUND, "Area not found", [
			{ path: "areaId", message: "Area not found" },
		]);
	}

	if (isMeterExists) {
		throw new AppError(
			httpStatus.CONFLICT,
			"This meter number is already registered",
			[{ path: "meterNumber", message: "Meter number is already registered" }],
		);
	}

	const hashedPassword = await bcrypt.hash(password, config.bcrypt_salt_rounds);

	// The user and the customer profile are created together or not at all.
	// A concurrent duplicate still hits the unique index and surfaces as a 409.
	const result = await prisma.$transaction(async (tx) => {
		const user = await tx.user.create({
			data: {
				name,
				email,
				password: hashedPassword,
				role: Role.CUSTOMER,
			},
			select: safeUserSelect,
		});

		const customer = await tx.customer.create({
			data: {
				...profile,
				userId: user.id,
			},
			select: {
				id: true,
				contactNumber: true,
				address: true,
				meterNumber: true,
				connectionType: true,
				sanctionedLoadKW: true,
				area: {
					select: {
						id: true,
						name: true,
						code: true,
						feeder: { select: { id: true, name: true, code: true } },
					},
				},
			},
		});

		return { user, customer };
	});

	return {
		...createTokens(result.user),
		user: result.user,
		customer: result.customer,
	};
};

const login = async (payload: ILoginPayload) => {
	const { email, password } = payload;

	const user = await prisma.user.findUnique({
		where: { email },
	});

	// The same message for "no such user" and "wrong password", so the
	// endpoint cannot be used to discover which emails are registered.
	if (!user || user.isDeleted) {
		throw new AppError(httpStatus.UNAUTHORIZED, "Invalid email or password");
	}

	if (!user.password) {
		throw new AppError(
			httpStatus.BAD_REQUEST,
			"This account was created with Google. Please log in with Google.",
		);
	}

	const isPasswordMatched = await bcrypt.compare(password, user.password);

	if (!isPasswordMatched) {
		throw new AppError(httpStatus.UNAUTHORIZED, "Invalid email or password");
	}

	if (user.status === UserStatus.BLOCKED) {
		throw new AppError(
			httpStatus.FORBIDDEN,
			"Your account has been blocked. Please contact support.",
		);
	}

	return {
		...createTokens(user),
		user: {
			id: user.id,
			name: user.name,
			email: user.email,
			role: user.role,
		},
	};
};

const refreshToken = async (token: string) => {
	const verifiedRefreshToken = jwtUtils.verifyToken(
		token,
		config.jwt_refresh_secret,
	);

	if (!verifiedRefreshToken.success) {
		throw new AppError(
			httpStatus.UNAUTHORIZED,
			verifiedRefreshToken.isExpired
				? "Refresh token has expired. Please log in again."
				: "Invalid refresh token",
		);
	}

	const user = await prisma.user.findUnique({
		where: { id: String(verifiedRefreshToken.data.userId) },
		select: {
			id: true,
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

	// Built from the database row, so the new token carries the current role.
	const { accessToken } = createTokens(user);

	return { accessToken };
};

const googleLogin = async (payload: IGoogleLoginPayload) => {
	let googleIdTokenPayload: TokenPayload | undefined;

	// Network call to Google: deliberately outside any database transaction.
	try {
		const ticket = await googleClient.verifyIdToken({
			idToken: payload.idToken,
			audience: config.google_client_id,
		});

		googleIdTokenPayload = ticket.getPayload();
	} catch {
		throw new AppError(
			httpStatus.UNAUTHORIZED,
			"Invalid or expired Google ID token",
		);
	}

	if (!googleIdTokenPayload?.sub || !googleIdTokenPayload.email) {
		throw new AppError(
			httpStatus.UNAUTHORIZED,
			"Invalid or expired Google ID token",
		);
	}

	if (!googleIdTokenPayload.email_verified) {
		throw new AppError(
			httpStatus.FORBIDDEN,
			"Your Google email address is not verified",
		);
	}

	const googleId = googleIdTokenPayload.sub;
	const email = googleIdTokenPayload.email.trim().toLowerCase();
	const name = googleIdTokenPayload.name?.trim() || email.split("@")[0];

	const existingUser = await prisma.user.findFirst({
		where: { OR: [{ googleId }, { email }] },
		select: {
			...safeUserSelect,
			googleId: true,
			isDeleted: true,
			customer: { select: { areaId: true, meterNumber: true } },
		},
	});

	if (existingUser) {
		// Google login is a customer feature: staff accounts must use their password.
		if (existingUser.role !== Role.CUSTOMER) {
			throw new AppError(
				httpStatus.FORBIDDEN,
				"Google login is only available for customer accounts",
			);
		}

		if (existingUser.isDeleted) {
			throw new AppError(
				httpStatus.UNAUTHORIZED,
				"User not found. Please contact support.",
			);
		}

		if (existingUser.status === UserStatus.BLOCKED) {
			throw new AppError(
				httpStatus.FORBIDDEN,
				"Your account has been blocked. Please contact support.",
			);
		}

		if (existingUser.googleId && existingUser.googleId !== googleId) {
			throw new AppError(
				httpStatus.CONFLICT,
				"This email is already linked to a different Google account",
			);
		}

		// An email/password account with the same (verified) email: link it.
		if (!existingUser.googleId) {
			await prisma.user.update({
				where: { id: existingUser.id },
				data: { googleId },
			});
		}

		const { googleId: _googleId, isDeleted, customer, ...user } = existingUser;

		return {
			...createTokens(user),
			user,
			isNewUser: false,
			isProfileComplete: Boolean(customer?.areaId && customer.meterNumber),
		};
	}

	// First Google login: create the customer with an empty profile. They
	// set their area and meter number later through PATCH /users/me.
	const user = await prisma.user.create({
		data: {
			name,
			email,
			googleId,
			authProvider: AuthProvider.GOOGLE,
			role: Role.CUSTOMER,
			customer: { create: {} },
		},
		select: safeUserSelect,
	});

	return {
		...createTokens(user),
		user,
		isNewUser: true,
		isProfileComplete: false,
	};
};

export const AuthServices = {
	register,
	login,
	refreshToken,
	googleLogin,
};
