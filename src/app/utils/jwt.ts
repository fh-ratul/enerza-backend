import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";
import type { Role } from "../../generated/prisma/enums";
import config from "../config";

export type TTokenPayload = {
	userId: string;
	email: string;
	role: Role;
};

const createToken = (
	payload: TTokenPayload,
	secret: string,
	expiresIn: string,
) => {
	const token = jwt.sign(payload, secret, {
		expiresIn,
	} as SignOptions);

	return token;
};

const verifyToken = (token: string, secret: string) => {
	try {
		const verifiedToken = jwt.verify(token, secret) as JwtPayload &
			TTokenPayload;

		return {
			success: true as const,
			data: verifiedToken,
		};
	} catch (error) {
		return {
			success: false as const,
			isExpired: (error as Error).name === "TokenExpiredError",
		};
	}
};

const createAccessToken = (payload: TTokenPayload) =>
	createToken(payload, config.jwt_access_secret, config.jwt_access_expires_in);

const createRefreshToken = (payload: TTokenPayload) =>
	createToken(
		payload,
		config.jwt_refresh_secret,
		config.jwt_refresh_expires_in,
	);

export const jwtUtils = {
	createToken,
	verifyToken,
	createAccessToken,
	createRefreshToken,
};
